/**
 * BRG-04: the `command` serve harness ends every turn. A harness that ignores SIGTERM gets SIGKILL after the grace —
 * only the runner's own child (L20); the turn ends as "turn timed out" once the process is gone (L28) and the serve
 * loop goes on with the next item (L23). Quiet case (L34): a normal fast turn sends no signal at all. An EPIPE on the
 * prompt and a harness that does not start both end the turn instead of crashing or hanging serve.
 * Proof boundary: the harness is a test double (real child process, real signals); the inbox is a fake MCP.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { McpToolResult } from "@opt2-tealbrick/bridge";
import { commandRunner, HARNESS_KILL_GRACE_MS, HARNESS_TURN_TIMEOUT_S, type ServeState, serveLoop, validateServeConfig } from "../src/serve.ts";

const FAKE = fileURLToPath(new URL("./support/fake-command-harness.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "tb-cmd-harness-"));
const noHold = { onHeld: () => undefined };
type Logged = { event: string; fields: Record<string, unknown> };

const records = (path: string): { pid: number; event: string }[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const harness = (record: string) => ({ kind: "command" as const, command: [process.execPath, FAKE, record] });

describe("command harness turn limit (BRG-04)", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("defaults: the same turn limit and kill grace as the claude-code harness (600 s, 10 s)", () => {
    assert.equal(HARNESS_TURN_TIMEOUT_S, 600);
    assert.equal(HARNESS_KILL_GRACE_MS, 10_000);
  });

  test("a harness that ignores SIGTERM: SIGTERM, then SIGKILL of its OWN child only; 'turn timed out' once the pid is gone", async () => {
    const record = join(dir, "hang.jsonl");
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const logs: Logged[] = [];
      const runTurn = await commandRunner(harness(record), "relay", { turnTimeoutMs: 1_500, killGraceMs: 500, log: (event, fields = {}) => logs.push({ event, fields }) });
      const started = Date.now();
      const r = await runTurn("HANG please", noHold);
      assert.deepEqual(r, { ok: false, summary: "turn timed out" });
      assert.ok(Date.now() - started >= 2_000, "the grace ran before SIGKILL");
      const rec = records(record);
      const pid = rec[0]?.pid as number;
      assert.deepEqual(
        rec.map((x) => x.event),
        ["hang", "sigterm"],
        "SIGTERM first (and ignored)",
      );
      assert.equal(alive(pid), false, "L28: the own child is gone when the turn ends");
      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.event, "serve.turn.result");
      assert.deepEqual(logs[0]?.fields.sent, ["SIGTERM", "SIGKILL"]);
      assert.equal(logs[0]?.fields.signal, "SIGKILL");
      assert.equal(logs[0]?.fields.timedOut, true);
      assert.equal(logs[0]?.fields.ok, false);
      assert.equal(bystander.exitCode, null);
      assert.ok(alive(bystander.pid as number), "L20: a process the runner did not start is untouched");
    } finally {
      bystander.kill("SIGTERM");
    }
  });

  test("quiet case (L34): a normal fast turn sends no signal and is not timed out", async () => {
    const record = join(dir, "fast.jsonl");
    const logs: Logged[] = [];
    const runTurn = await commandRunner(harness(record), "relay", { turnTimeoutMs: 1_500, killGraceMs: 500, log: (event, fields = {}) => logs.push({ event, fields }) });
    const r = await runTurn("hello", noHold);
    assert.deepEqual(r, { ok: true, summary: "exit code 0" });
    // wait past the turn limit + grace: a timer left behind would show up as a signal now
    await new Promise((res) => setTimeout(res, 2_200));
    assert.deepEqual(
      records(record).map((x) => x.event),
      ["fast"],
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.fields.ok, true);
    assert.equal(logs[0]?.fields.exitCode, 0);
    assert.equal(logs[0]?.fields.sent, undefined, "no SIGTERM, no SIGKILL");
    assert.equal(logs[0]?.fields.timedOut, undefined);
    assert.equal(logs[0]?.fields.signal, undefined);
  });

  test("an EPIPE on the prompt and a harness that does not start end the turn (no crash, no hang)", async () => {
    const quit = await commandRunner({ kind: "command", command: [process.execPath, "-e", "process.exit(3)"] }, "relay", { turnTimeoutMs: 5_000 });
    assert.deepEqual(await quit("x".repeat(4 * 1024 * 1024), noHold), { ok: false, summary: "exit code 3" });
    const missing = await commandRunner({ kind: "command", command: [join(dir, "no-such-harness")] }, "relay", { turnTimeoutMs: 5_000 });
    assert.deepEqual(await missing("x", noHold), { ok: false, summary: "harness did not start" });
  });

  test("the serve loop goes on: a hung turn times out, the next inbox item gets its own turn", async () => {
    const record = join(dir, "loop.jsonl");
    const cfg = validateServeConfig({
      format: "tealbrick.agent-serve/1",
      harness: harness(record),
      inboxes: [{ tool: "connect__channel_inbox", cursor: { param: "sinceSeq", from: "nextSeq" }, id: "seq", wake: "all" }],
      pollSeconds: 5,
      backlog: true,
    });
    const inbox: Record<string, unknown>[] = [{ seq: 1, text: "HANG on this one" }];
    let nextSeq = 1;
    const results: { ok: boolean; summary?: string }[] = [];
    const logs: string[] = [];
    const abort = new AbortController();
    const runner = await commandRunner(harness(record), "relay", { turnTimeoutMs: 1_500, killGraceMs: 500 });
    let state: ServeState = { cursors: {}, seen: {}, primed: {} };
    let clock = 1_000_000;
    await serveLoop(
      cfg,
      {
        mcp: {
          async callTool(name, args): Promise<McpToolResult> {
            if (name !== "connect__channel_inbox") return { isError: true, structuredContent: { error: { code: "unknown_tool" } } };
            const since = Number(args.sinceSeq ?? 0);
            return { structuredContent: { messages: inbox.filter((m) => Number(m.seq) > since), nextSeq, untrusted: true } };
          },
        },
        async runTurn(prompt, events, opts) {
          const r = await runner(prompt, events, opts);
          results.push(r);
          if (results.length === 1) {
            inbox.push({ seq: 2, text: "a normal question" });
            nextSeq = 2;
          }
          if (results.length === 2) abort.abort();
          return r;
        },
        loadState: async () => structuredClone(state),
        saveState: async (s) => {
          state = structuredClone(s);
        },
        log: (e, f) => logs.push(`${e} ${JSON.stringify(f ?? {})}`),
        sleep: async (ms) => {
          clock += ms;
          await new Promise((r) => setTimeout(r, 1));
        },
        now: () => clock,
      },
      abort.signal,
    );
    assert.deepEqual(results, [
      { ok: false, summary: "turn timed out" },
      { ok: true, summary: "exit code 0" },
    ]);
    assert.deepEqual(
      logs.map((l) => l.split(" ")[0]),
      ["serve.turn.start", "serve.error", "serve.turn.start", "serve.turn.done"],
      "the timed-out turn is a failed turn (backoff), then the loop starts the next turn",
    );
    assert.match(logs[1] as string, /"code":"turn_failed"/);
    const rec = records(record);
    assert.deepEqual(
      rec.map((x) => x.event),
      ["hang", "sigterm", "fast"],
    );
    assert.equal(alive(rec[0]?.pid as number), false, "the hung harness is gone");
  });
});
