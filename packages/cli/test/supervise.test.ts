/** C96 §8 liveness: pidfile (one loop per connection), watchdog, supervisor restarts with backoff (own child only). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { acquirePidfile, EXIT_STALLED, liveness, readHeartbeat, readPid, supervise } from "../src/supervise.ts";

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
});
