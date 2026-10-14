/**
 * CLI 0.1.22 (DESIGN-0.1.22-SERVE-DURABILITY, C151). BRG-02: the inbox queue — never repeat a started turn, retry
 * only a turn that provably did not start, one failed group never stops the others, visible failures (status, opt-in
 * notice). BRG-03: an unreadable state file refuses to start (no silent reset), `--accept-state-loss` can skip work
 * but never repeat it, and saves are fsynced in order. Tests 1–7 of the design note; L27 exact outcomes, L34 both ways.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, test } from "node:test";
import { type McpToolResult, manifestApi } from "@opt2-tealbrick/bridge";
import { healthLine, refusedLine } from "../src/lead.ts";
import {
  commandRunner,
  fileState,
  type HarnessRunner,
  QUEUE_BACKOFF_MS,
  QUEUE_MAX_ATTEMPTS,
  type ServeConfig,
  type ServeHealth,
  type ServeState,
  type StateIo,
  StateUnreadableError,
  serveLoop,
  TURN_FAILED_NOTICE,
  validateServeConfig,
} from "../src/serve.ts";
import { configDir, createFileStore } from "../src/store.ts";
import { EXIT_STALLED, EXIT_STATE_UNREADABLE, heartbeatPath, isAlive, pidPath, readHeartbeat, readPid, supervise } from "../src/supervise.ts";
import { Harness } from "./fixtures.ts";

const IDEM = "tealbrick/idempotencyKey";
const HEX = (n: number) => n.toString(16).padStart(64, "0");

interface Call {
  name: string;
  args: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** A Buzz channel inbox (connect__buzz_read) whose items arrive after the priming poll. */
function world(o: { cfg: ServeConfig; state?: ServeState; runTurn: (prompt: string, n: number, snapshot: () => ServeState) => ReturnType<HarnessRunner>; stopAfterPolls: number; arrive?: Record<string, unknown>[] }) {
  const abort = new AbortController();
  let state: ServeState = o.state ? structuredClone(o.state) : { cursors: {}, seen: {}, primed: {} };
  let clock = 1_000_000;
  let polls = 0;
  let turns = 0;
  const calls: Call[] = [];
  const logs: { e: string; f?: Record<string, unknown> }[] = [];
  const healths: ServeHealth[] = [];
  const turnTimes: number[] = [];
  const messages: Record<string, unknown>[] = [];
  const done = serveLoop(
    o.cfg,
    {
      mcp: {
        async callTool(name, args, meta): Promise<McpToolResult> {
          calls.push({ name, args, ...(meta ? { meta } : {}) });
          if (name === "connect__buzz_read") {
            polls += 1;
            if (polls === 2 && o.arrive) messages.push(...o.arrive);
            if (polls > o.stopAfterPolls) abort.abort();
            return { structuredContent: { messages, untrusted: true, relays: [] } };
          }
          if (name === "connect__buzz_post") return { structuredContent: { id: HEX(999) } };
          return { isError: true, structuredContent: { error: { code: "unknown_tool" } } };
        },
      },
      async runTurn(prompt) {
        turns += 1;
        turnTimes.push(clock);
        return o.runTurn(prompt, turns, () => structuredClone(state));
      },
      loadState: async () => structuredClone(state),
      saveState: async (s) => {
        state = structuredClone(s);
      },
      log: (e, f) => logs.push({ e, ...(f ? { f } : {}) }),
      sleep: async (ms) => {
        clock += ms;
        await new Promise((r) => setTimeout(r, 1));
      },
      now: () => clock,
      health: (h) => void healths.push(h),
    },
    abort.signal,
  );
  return { done, calls, logs, healths, turnTimes, state: () => state, turns: () => turns };
}

const buzzCfg = (extra: Record<string, unknown> = {}): ServeConfig =>
  validateServeConfig({
    format: "tealbrick.agent-serve/1",
    harness: { kind: "command", command: ["true"] },
    inboxes: [{ tool: "connect__buzz_read", args: { channel: "ch_team" }, cursor: { param: "since", from: "max:createdAt" }, items: "messages", id: "id", skipIf: { fromSelf: true }, wake: "all", ...extra }],
    pollSeconds: 5,
  });

const msg = (n: number, sender: string, text: string) => ({ id: HEX(n), channel: "ch_team", author: sender, sender: { id: sender, name: sender }, service: "buzz", content: text, createdAt: 2_000_000_000 + n });
const events = (w: { logs: { e: string }[] }, prefix = "serve.") => w.logs.map((l) => l.e).filter((e) => e.startsWith(prefix) && !e.startsWith("serve.inbox.primed"));

describe("BRG-02: durable inbox queue (C151 B, D)", () => {
  it("1: group A fails after it started → A is NOT re-run, group B of the same poll still runs, status counts it", async () => {
    const prompts: string[] = [];
    const w = world({
      cfg: buzzCfg(),
      stopAfterPolls: 4,
      arrive: [msg(1, "alice", "question from A"), msg(2, "bob", "question from B")],
      runTurn: async (prompt) => {
        prompts.push(prompt);
        return /question from A/.test(prompt) ? { ok: false, summary: "turn timed out", code: "turn_timeout" } : { ok: true };
      },
    });
    await w.done;
    assert.equal(prompts.filter((p) => /question from A/.test(p)).length, 1, "A ran exactly once (never re-run)");
    assert.equal(prompts.filter((p) => /question from B/.test(p)).length, 1, "B ran once, after A failed");
    assert.deepEqual(events(w, "serve.turn"), ["serve.turn.start", "serve.turn.failed", "serve.turn.start", "serve.turn.done"]);
    const failed = w.logs.find((l) => l.e === "serve.turn.failed");
    assert.deepEqual(failed?.f, { tool: "connect__buzz_read", items: [HEX(1)], code: "turn_timeout" }, "item ids and the code, no payload");
    assert.ok(!w.logs.some((l) => l.e === "serve.error"), "a failed turn is not a loop error");
    assert.equal(w.state().inboxQueue?.length, 0);
    assert.equal(w.state().health?.failed, 1);
    assert.equal(w.state().health?.last?.kind, "failed");
    assert.equal(w.healths.at(-1)?.failed, 1, "the heartbeat gets the counters at once");
    assert.ok(!w.calls.some((c) => c.name === "connect__buzz_post"), "no notice unless the inbox opts in (outward action)");
  });

  it("1b: opt-in onFailure notify → ONE fixed notice in the item's thread, idempotency key turnfail:<itemId>", async () => {
    const w = world({
      cfg: buzzCfg({ onFailure: "notify" }),
      stopAfterPolls: 4,
      arrive: [{ ...msg(7, "alice", "please do X"), threadId: HEX(5) }],
      runTurn: async () => ({ ok: false, code: "turn_failed" }),
    });
    await w.done;
    const posts = w.calls.filter((c) => c.name === "connect__buzz_post");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]?.args, { channel: "ch_team", content: TURN_FAILED_NOTICE, replyTo: HEX(7), threadRoot: HEX(5) });
    assert.equal(posts[0]?.meta?.[IDEM], `turnfail:${HEX(7)}`);
    assert.ok(w.logs.some((l) => l.e === "serve.turn.notice_sent"));
    assert.throws(() => buzzCfg({ onFailure: "post" }), /onFailure/);
    assert.throws(
      () => validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "command", command: ["true"] }, inboxes: [{ tool: "notes__notes_list", onFailure: "notify" }] }),
      /onFailure "notify" is for connect__buzz_read, connect__channel_inbox/,
    );
  });

  it("2: harness binary missing (spawn error) → started:false → retried with backoff, at most 5 calls, then gave_up", async () => {
    const real = await commandRunner({ kind: "command", command: ["/nonexistent/tealbrick-test-harness-binary"] }, "relay");
    const results: { started?: boolean }[] = [];
    const w = world({
      cfg: buzzCfg(),
      stopAfterPolls: 60,
      arrive: [msg(3, "alice", "hello")],
      runTurn: async (prompt) => {
        const r = await real(prompt, { onHeld: () => undefined });
        results.push(r);
        return r;
      },
    });
    await w.done;
    assert.equal(w.turns(), QUEUE_MAX_ATTEMPTS, "never more than 5 calls");
    assert.ok(results.every((r) => r.started === false));
    const gaps = w.turnTimes.slice(1).map((t, i) => t - (w.turnTimes[i] as number));
    for (const [i, g] of gaps.entries()) assert.ok(g >= QUEUE_BACKOFF_MS * 2 ** i, `backoff before attempt ${i + 2}: ${g} ms`);
    assert.equal(w.logs.filter((l) => l.e === "serve.turn.not_started").length, 4);
    const gave = w.logs.find((l) => l.e === "serve.inbox.gave_up");
    assert.deepEqual(gave?.f, { tool: "connect__buzz_read", items: [HEX(3)], attempts: 5, code: "not_started" });
    assert.equal(w.state().health?.gaveUp, 1);
    assert.equal(w.state().health?.failed, 0, "not started is not a failed turn");
    assert.equal(w.state().inboxQueue?.length, 0);
  });

  it("3: the runner dies during a started turn; on restart the turn is uncertain and NEVER runs again", async () => {
    // run 1: the state saved before the turn is what a killed process leaves behind
    let leftBehind: ServeState | undefined;
    const w1 = world({
      cfg: buzzCfg(),
      stopAfterPolls: 3,
      arrive: [msg(4, "alice", "do the thing")],
      runTurn: async (_p, _n, snapshot) => {
        leftBehind = snapshot();
        return { ok: true };
      },
    });
    await w1.done;
    assert.equal(leftBehind?.inboxQueue?.[0]?.state, "started", "saved as started BEFORE the turn");
    assert.deepEqual(leftBehind?.seen?.[`connect__buzz_read|${JSON.stringify({ channel: "ch_team" })}`], [HEX(4)], "the cursor moved in the same write");
    // run 2 (restart from the left-behind state): uncertain, no second turn, the message is not re-read
    const w2 = world({ cfg: buzzCfg({ onFailure: "notify" }), state: leftBehind as ServeState, stopAfterPolls: 3, runTurn: async () => ({ ok: true }) });
    await w2.done;
    assert.equal(w2.turns(), 0, "no second run");
    assert.deepEqual(w2.logs.find((l) => l.e === "serve.turn.uncertain")?.f, { tool: "connect__buzz_read", items: [HEX(4)] });
    assert.equal(w2.state().health?.uncertain, 1);
    assert.equal(w2.state().inboxQueue?.length, 0);
    assert.equal(w2.calls.filter((c) => c.name === "connect__buzz_post").length, 0, "the entry was queued without notify: no notice");
  });

  it("6: quiet case (L34) — a good poll with two groups → two turns, no failure line, no notice, counters stay 0", async () => {
    const w = world({ cfg: buzzCfg({ onFailure: "notify" }), stopAfterPolls: 4, arrive: [msg(10, "alice", "a"), msg(11, "bob", "b")], runTurn: async () => ({ ok: true }) });
    await w.done;
    assert.equal(w.turns(), 2);
    assert.deepEqual(events(w, "serve.turn"), ["serve.turn.start", "serve.turn.done", "serve.turn.start", "serve.turn.done"]);
    assert.ok(!w.logs.some((l) => /failed|uncertain|gave_up|not_started|notice/.test(l.e)));
    assert.ok(!w.calls.some((c) => c.name === "connect__buzz_post"));
    assert.deepEqual(w.state().health, { failed: 0, uncertain: 0, gaveUp: 0 });
    assert.equal(healthLine(w.state().health as ServeHealth), "unanswered: none");
  });

  it("D: the agent status lines name the counts and the last failure; a refused start names the file and both choices", () => {
    assert.equal(
      healthLine({ failed: 1, uncertain: 0, gaveUp: 2, last: { at: "2026-10-14T12:03:09.000Z", kind: "failed", tool: "connect__buzz_read", items: 2, code: "turn_timeout" } }),
      "unanswered: 1 failed turn, 0 uncertain turns, 2 gave-up items; last: turn failed 12:03Z (connect__buzz_read, 2 items, turn_timeout)",
    );
    assert.equal(
      refusedLine({ path: "/c/agent-serve-con_x.json", reason: "json", at: "2026-10-14T12:01:00.000Z" }),
      "serve refused to start 12:01Z: state file unreadable (/c/agent-serve-con_x.json: json); fix or restore the file, or start serve with --accept-state-loss",
    );
  });
});

describe("BRG-03: the state file (C151 C)", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "tb-state-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("4: ENOENT starts fresh; empty, corrupt JSON, wrong shape and EACCES refuse with state_unreadable", async () => {
    assert.deepEqual(await fileState(join(dir, "none.json")).loadState(), { cursors: {}, seen: {}, primed: {}, routineRuns: {}, pendingReports: [] });
    const cases: [string, string, string][] = [
      ["empty.json", "", "empty"],
      ["torn.json", '{"cursors":{"a":1},"routineRu', "json"],
      ["shape.json", '{"cursors":[],"seen":{}}', "shape"],
      ["array.json", "[]", "shape"],
    ];
    for (const [name, text, reason] of cases) {
      await writeFile(join(dir, name), text);
      await assert.rejects(fileState(join(dir, name)).loadState(), (e: unknown) => e instanceof StateUnreadableError && e.code === "state_unreadable" && e.reason === reason && e.path === join(dir, name), name);
    }
    if (process.getuid?.() !== 0) {
      await writeFile(join(dir, "locked.json"), "{}");
      await chmod(join(dir, "locked.json"), 0o000);
      await assert.rejects(fileState(join(dir, "locked.json")).loadState(), (e: unknown) => e instanceof StateUnreadableError && e.reason === "EACCES");
      await chmod(join(dir, "locked.json"), 0o600);
    }
    // quiet case: a good file loads unchanged
    await writeFile(join(dir, "good.json"), JSON.stringify({ cursors: { k: 3 }, seen: {}, primed: { k: true }, routineRuns: {}, inboxQueue: [] }));
    assert.deepEqual((await fileState(join(dir, "good.json")).loadState()).cursors, { k: 3 });
  });

  it("4b: the supervisor does not restart a serve that refused to start (state_unreadable); a crash still restarts", async () => {
    const run = async (code: number) => {
      const events: string[] = [];
      const last = await supervise({ command: process.execPath, args: ["-e", `process.exit(${code})`], pidfile: join(dir, `sup-${code}.pid`), log: (e) => events.push(e), sleep: async () => undefined, maxRestarts: 3 });
      return { last, starts: events.filter((e) => e === "serve.supervisor.started").length, events };
    };
    const refused = await run(EXIT_STATE_UNREADABLE);
    assert.equal(refused.last, EXIT_STATE_UNREADABLE);
    assert.equal(refused.starts, 1, "no restart loop");
    assert.ok(refused.events.includes("serve.supervisor.gave_up"));
    const crashed = await run(EXIT_STALLED);
    assert.equal(crashed.starts, 4, "other exits are still restarted (L34 both ways)");
  });

  it("7: power-loss order — tmp written and fsynced, then renamed, then the directory fsynced", async () => {
    const order: string[] = [];
    const io: StateIo = {
      readFile: async () => "{}",
      mkdir: async () => void order.push("mkdir"),
      writeFileSynced: async (p, data) => {
        assert.ok(JSON.parse(data));
        order.push(`write+fsync ${p.endsWith(`.tmp-${process.pid}`) ? "tmp" : p}`);
      },
      rename: async (a, b) => void order.push(`rename ${a.endsWith(`.tmp-${process.pid}`) ? "tmp" : a} -> ${b}`),
      syncDir: async (d) => void order.push(`fsync dir ${d}`),
    };
    await fileState("/x/state/agent-serve-con.json", io).saveState({ cursors: {}, seen: {}, primed: {} });
    assert.deepEqual(order, ["mkdir", "write+fsync tmp", "rename tmp -> /x/state/agent-serve-con.json", "fsync dir /x/state"]);
    // the real io writes 0600 and the file reads back
    const p = join(dir, "real", "s.json");
    await fileState(p).saveState({ cursors: { a: 1 }, seen: {}, primed: {} });
    assert.deepEqual(JSON.parse(await readFile(p, "utf8")).cursors, { a: 1 });
    const { statSync } = await import("node:fs");
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });
});

describe("BRG-03: --accept-state-loss can skip work, never repeat it (test 5)", () => {
  const OCC = (n: number) => `${"b".repeat(62)}${String(n).padStart(2, "0")}`;
  it("5: a routine occurrence due before the loss is reported uncertain and not run; one due after runs once", async () => {
    const lostAt = Date.parse("2026-10-14T12:00:00Z");
    const jobs = [
      { occurrence: OCC(1), workflowId: "wfl_01HPAST", version: 1, dueAt: "2026-10-14T11:00:00Z", title: "past" },
      { occurrence: OCC(2), workflowId: "wfl_01HLATER", version: 1, dueAt: "2026-10-14T12:30:00Z", title: "later" },
    ];
    const claims: string[] = [];
    const reports: { occ: string; status: string; summary?: string }[] = [];
    let polls = 0;
    const prompts: string[] = [];
    const abort = new AbortController();
    let state: ServeState = { cursors: {}, seen: {}, primed: {}, routineRuns: {}, pendingReports: [], stateLostAt: lostAt };
    const cfg = validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "command", command: ["true"] }, routines: [{ due: "evolution__routines_due", claim: "evolution__routine_claim", report: "evolution__routine_report" }], pollSeconds: 5 });
    await serveLoop(
      cfg,
      {
        mcp: {
          async callTool(name, args): Promise<McpToolResult> {
            if (name === "evolution__routines_due") {
              polls += 1;
              if (polls > 3) abort.abort();
              return { structuredContent: { jobs: jobs.filter((j) => !claims.includes(j.occurrence)) } };
            }
            if (name === "evolution__routine_claim") {
              claims.push(String(args.occurrence));
              return { structuredContent: { claimed: true, job: { occurrence: args.occurrence, workflowId: "wfl_01HLATER", version: 1, instruction: "x", steps: [], allowed: [] } } };
            }
            if (name === "evolution__routine_report") {
              // like Evolution: a report on an occurrence this runner never claimed is not_found
              if (!claims.includes(String(args.occurrence))) return { isError: true, structuredContent: { error: { code: "not_found" } } };
              reports.push({ occ: String(args.occurrence), status: String(args.status), ...(typeof args.summary === "string" ? { summary: args.summary } : {}) });
              return { structuredContent: { ok: true } };
            }
            return { isError: true, structuredContent: { error: { code: "unknown_tool" } } };
          },
        },
        async runTurn(prompt) {
          prompts.push(prompt);
          return { ok: true };
        },
        loadState: async () => structuredClone(state),
        saveState: async (s) => {
          state = structuredClone(s);
        },
        log: () => undefined,
        sleep: async () => {
          await new Promise((r) => setTimeout(r, 1));
        },
        now: () => lostAt + 60_000,
      },
      abort.signal,
    );
    assert.deepEqual(claims, [OCC(2)], "the past occurrence is never claimed");
    assert.equal(prompts.length, 1, "one turn: the later occurrence");
    assert.match(prompts[0] as string, /wfl_01HLATER/);
    assert.equal(state.routineRuns?.[OCC(1)]?.s, "reported");
    assert.equal(state.routineRuns?.[OCC(1)]?.reason, "state_lost");
    assert.equal(state.health?.routinesSkipped, 1);
    assert.deepEqual(
      reports.map((r) => `${r.occ.slice(-2)}:${r.status}`),
      ["02:dispatched", "02:completed"],
    );
    assert.equal(state.pendingReports?.length, 0, "the refused uncertain report is not queued for 50 retries");
  });
});

describe("BRG-03 end to end: agent serve refuses an unreadable state file; --accept-state-loss starts fresh (CLI)", () => {
  const api = manifestApi();
  const BRG = "brg_01HZZZZZZZZZZZZZZZZZZZZZZZ";
  const WS = "ws_01HZZZZZZZZZZZZZZZZZZZZZZZ";
  const AGT = "agt_01HDDDDDDDDDDDDDDDDDDDDDDD";
  const CON = "con_01HDDDDDDDDDDDDDDDDDDDDDDD";
  const h = new Harness();
  let bridge: Server;
  let started: number | undefined;

  before(async () => {
    await h.setup();
    h.injectStore = false;
    h.env.TB_CREDENTIAL_STORE = "file";
    bridge = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/oauth/token") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "k5-access", token_type: "Bearer", expires_in: 900 }));
      if (req.url === "/mcp" && req.method === "POST") {
        const m = JSON.parse(body);
        if (m.id === undefined) return res.writeHead(202).end();
        const result = m.method === "initialize" ? { protocolVersion: "2025-06-18" } : m.method === "tools/list" ? { tools: [{ name: "notes__notes_list" }] } : { content: [], structuredContent: { messages: [] } };
        return res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      }
      res.writeHead(405).end();
    });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
    const key = await api.generateKeyPair();
    const item = { v: 1, kind: "agent", con: CON, agt: AGT, ws: WS, bridgeId: BRG, bridgeUrl: url, tokenEndpoint: `${url}/oauth/token`, harness: "tealbrick-cli", label: "test", publicJwk: key.publicJwk, privateKey: Buffer.from(await api.exportPrivateKey(key)).toString("base64url"), createdAt: new Date().toISOString() };
    await createFileStore(configDir(h.env)).put(`tealbrick.agent.${CON}`, JSON.stringify(item));
  });
  after(async () => {
    // only the process this test started, from its own pidfile (L20)
    const held = await readPid(pidPath(configDir(h.env), CON));
    if (held && held.pid === started && isAlive(held.pid)) process.kill(held.pid, "SIGKILL");
    bridge.closeAllConnections();
    await new Promise((r) => bridge.close(r));
    await h.teardown();
  });

  test("corrupt state → exit 78 state_unreadable, pidfile released, agent status shows the refused start; --detach --accept-state-loss starts fresh and keeps the bad file", async () => {
    const file = join(h.cwd, "serve.json");
    await writeFile(file, JSON.stringify({ format: "tealbrick.agent-serve/1", harness: { kind: "command", command: ["true"] }, pollSeconds: 5, inboxes: [{ tool: "notes__notes_list", items: "messages", id: "id" }] }));
    const statePath = join(configDir(h.env), `agent-serve-${CON}.json`);
    const torn = '{"cursors":{},"routineRuns":{"occ":{"s":"star';
    await writeFile(statePath, torn);
    const r = await h.run(["agent", "serve", "--file", file, "--agent", AGT, "--log", join(h.cwd, "fg.log"), "--json"]);
    assert.equal(r.code, EXIT_STATE_UNREADABLE, r.err);
    assert.equal(r.json.error.code, "state_unreadable");
    assert.match(r.json.error.message, /--accept-state-loss/);
    assert.equal(await readFile(statePath, "utf8"), torn, "never a silent reset: the file is untouched");
    assert.equal(await readPid(pidPath(configDir(h.env), CON)), null, "the pidfile is released");
    assert.match(await readFile(join(h.cwd, "fg.log"), "utf8"), /serve\.state\.unreadable/);
    const hb = await readHeartbeat(heartbeatPath(configDir(h.env), CON));
    assert.deepEqual({ code: hb?.refused?.code, reason: hb?.refused?.reason }, { code: "state_unreadable", reason: "json" });
    const st = await h.run(["agent", "status", "--agent", AGT]);
    assert.equal(st.code, 0, st.err);
    assert.match(st.out, /serve refused to start \d\d:\d\dZ: state file unreadable \(.*agent-serve-con_01HDDDDDDDDDDDDDDDDDDDDDDD\.json: json\)/);
    // the owner's explicit choice: start fresh but safe (passed through --detach to the supervised child)
    const d = await h.run(["agent", "serve", "--file", file, "--agent", AGT, "--detach", "--accept-state-loss", "--json"]);
    assert.equal(d.code, 0, d.err);
    started = d.json.started.pid as number;
    let fresh: ServeState | null = null;
    for (let i = 0; i < 200 && !fresh; i++) {
      await new Promise((res) => setTimeout(res, 100));
      fresh = await readFile(statePath, "utf8").then(
        (t) => (t === torn ? null : (JSON.parse(t) as ServeState)),
        () => null,
      );
    }
    assert.equal(typeof fresh?.stateLostAt, "number", "fresh state, marked lost (past routine runs never run)");
    const log = await readFile(join(h.cwd, "serve.log"), "utf8");
    assert.match(log, /serve\.state\.reset_accepted/);
    const kept = /"kept":"([^"]+)"/.exec(log)?.[1];
    assert.ok(kept && (await readFile(kept, "utf8")) === torn, "the unreadable file is kept for the owner");
    h.clock = Date.now();
    const stop = await h.run(["agent", "stop", "--agent", AGT, "--json"]);
    assert.equal(stop.code, 0, stop.err);
    assert.equal(isAlive(started), false, "stopped (L28)");
    const st2 = await h.run(["agent", "status", "--agent", AGT]);
    assert.doesNotMatch(st2.out, /refused to start/);
    assert.match(st2.out, /unanswered: none/, "the counters come from the state file when serve is stopped");
  });
});
