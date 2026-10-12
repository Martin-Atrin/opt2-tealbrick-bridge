/** C96 §8 liveness: pidfile (one loop per connection), watchdog, supervisor restarts with backoff (own child only). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { acquirePidfile, EXIT_STALLED, isAlive, liveness, readHeartbeat, readPid, stopLoop, supervise } from "../src/supervise.ts";

const dir = mkdtempSync(join(tmpdir(), "tb-supervise-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("agent serve liveness (C96 §8)", () => {
  it("the pidfile refuses a second loop while the holder lives; a stale file is replaced", async () => {
    const path = join(dir, "a.pid");
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ pid: holder.pid, role: "serve", startedAt: "x" }));
    await assert.rejects(acquirePidfile(path, "serve"), /already runs/);
    holder.kill("SIGTERM"); // the test's own child
    await new Promise((r) => holder.once("exit", r));
    const release = await acquirePidfile(path, "serve");
    assert.equal((await readPid(path))?.pid, process.pid, "stale file replaced");
    await release();
    assert.equal(existsSync(path), false, "released");
  });

  it("the watchdog fires when nothing moved past the limit of the current phase; beats write the heartbeat", async () => {
    let t = 1_000_000;
    let stalled = 0;
    const path = join(dir, "hb.json");
    const live = liveness({ path, pollMs: 5_000, turnLimitMs: 60_000, onStall: () => void stalled++, nowMs: () => t, checkEveryMs: 10 });
    await live.beat("poll");
    assert.ok((await readHeartbeat(path))?.lastPollAt);
    t += 200_000; // < 300 s floor
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(stalled, 0);
    await live.beat("turn");
    t += 330_000; // a turn may run up to turnLimit + 300 s
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(stalled, 0, "a long turn is not a stall");
    t += 60_000;
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(stalled > 0, "past the turn limit the loop is stalled");
    live.stop();
  });

  it("--supervise restarts a crashing child with backoff and releases its pidfile at the end", async () => {
    const path = join(dir, "sup.pid");
    const events: { e: string; f?: Record<string, unknown> }[] = [];
    const waits: number[] = [];
    await supervise({
      command: process.execPath,
      args: ["-e", `process.exit(${EXIT_STALLED})`],
      pidfile: path,
      log: (e, f) => events.push({ e, ...(f ? { f } : {}) }),
      sleep: async (ms) => void waits.push(ms),
      maxRestarts: 3,
    });
    assert.equal(events.filter((x) => x.e === "serve.supervisor.started").length, 4);
    assert.deepEqual(waits, [1000, 2000, 4000], "backoff doubles");
    assert.ok(events.some((x) => x.e === "serve.supervisor.restart" && x.f?.stalled === true), "a watchdog exit is reported as stalled");
    assert.equal(existsSync(path), false);
  });

  it("F38: stopLoop stops a SUPERVISOR confirmed by heartbeat.supervisorPid, waits for it, then removes the pidfile", async () => {
    const { writeFile } = await import("node:fs/promises");
    const sup = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    const pf = join(dir, "f38.pid");
    const hb = join(dir, "f38.hb.json");
    await writeFile(pf, JSON.stringify({ pid: sup.pid, role: "supervisor", startedAt: "x" }));
    await writeFile(hb, JSON.stringify({ pid: 999999, supervisorPid: sup.pid, lastPollAt: null, phase: "poll", since: new Date().toISOString() }));
    const r = await stopLoop({ pidfile: pf, heartbeat: hb, nowMs: Date.now() });
    assert.equal(r.stopped, sup.pid);
    assert.equal(isAlive(sup.pid as number), false);
    assert.equal(existsSync(pf), false);
  });

  it("F38: a process that does not stop keeps its pidfile; an unconfirmed holder is never signalled", async () => {
    const { writeFile } = await import("node:fs/promises");
    const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 150));
    const pf = join(dir, "f38b.pid");
    const hb = join(dir, "f38b.hb.json");
    await writeFile(pf, JSON.stringify({ pid: stubborn.pid, role: "serve", startedAt: "x" }));
    await writeFile(hb, JSON.stringify({ pid: stubborn.pid, lastPollAt: null, phase: "poll", since: new Date().toISOString() }));
    const r = await stopLoop({ pidfile: pf, heartbeat: hb, nowMs: Date.now(), waitMs: 300 });
    assert.equal(r.stopped, null);
    assert.match(r.left ?? "", /did not stop/);
    assert.equal(existsSync(pf), true, "pidfile kept while the process runs");
    // unconfirmed (no heartbeat naming it): left alone, pidfile kept
    await writeFile(hb, JSON.stringify({ pid: 4242, lastPollAt: null, phase: "poll", since: new Date().toISOString() }));
    const u = await stopLoop({ pidfile: pf, heartbeat: hb, nowMs: Date.now(), waitMs: 300 });
    assert.match(u.left ?? "", /not confirmed/);
    assert.equal(existsSync(pf), true);
    stubborn.kill("SIGKILL"); // the test's own child
    await new Promise((r2) => stubborn.once("exit", r2));
  });

  it("F56: SIGTERM to an idle supervisor ends it and its (SIGTERM-ignoring) child within STOP_BOUND_MS", async () => {
    const { STOP_BOUND_MS } = await import("../src/supervise.ts");
    const pf = join(dir, "f56.pid");
    const script = `import { supervise } from ${JSON.stringify(new URL("../src/supervise.ts", import.meta.url).href)};
await supervise({ command: process.execPath, args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], pidfile: ${JSON.stringify(pf)}, log: (e, f) => console.log(JSON.stringify({ e, ...f })) });`;
    const sup = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    sup.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    for (let i = 0; i < 100 && !/serve.supervisor.started/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    const childPid = JSON.parse(out.trim().split("\n")[0] as string).child as number;
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    sup.kill("SIGTERM");
    await new Promise((r) => sup.once("exit", r));
    const took = Date.now() - t0;
    assert.ok(took < STOP_BOUND_MS, `supervisor exited in ${took} ms`);
    assert.equal(isAlive(childPid), false, "its child is gone");
    assert.equal(existsSync(pf), false, "pidfile released");
  });
});
