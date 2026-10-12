import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpToolResult } from "@opt2-tealbrick/bridge";
import { promptFor, type ServeConfig, type ServeState, serveLoop, validateServeConfig } from "../src/serve.ts";

interface World {
  inbox: Record<string, unknown>[];
  nextSeq: number;
  holdStatus: string;
  calls: { name: string; args: Record<string, unknown> }[];
  prompts: string[];
  active: number;
  maxActive: number;
  inboxFails: number;
}

function harness(cfg: ServeConfig, w: World, opts: { turns: number; onTurn?: (n: number, ev: { onHeld: (h: never) => void }) => void }) {
  const abort = new AbortController();
  let state: ServeState = { cursors: {}, seen: {}, primed: {} };
  let clock = 1_000_000;
  const logs: string[] = [];
  const done = serveLoop(
    cfg,
    {
      mcp: {
        async callTool(name, args): Promise<McpToolResult> {
          w.calls.push({ name, args });
          if (name === "connect__channel_inbox") {
            if (w.inboxFails > 0) {
              w.inboxFails -= 1;
              throw new Error("bridge_unreachable");
            }
            const since = Number(args.sinceSeq ?? 0);
            const messages = w.inbox.filter((m) => Number(m.seq) > since);
            return { structuredContent: { messages, nextSeq: w.nextSeq, untrusted: true } };
          }
          if (name === "connect__tb_hold_status") return { structuredContent: { status: w.holdStatus } };
          return { isError: true, structuredContent: { error: { code: "unknown_tool" } } };
        },
      },
      async runTurn(prompt, events) {
        w.active += 1;
        w.maxActive = Math.max(w.maxActive, w.active);
        w.prompts.push(prompt);
        opts.onTurn?.(w.prompts.length, events as never);
        await new Promise((r) => setTimeout(r, 5));
        w.active -= 1;
        if (w.prompts.length >= opts.turns) abort.abort();
        return { ok: true };
      },
      loadState: async () => structuredClone(state),
      saveState: async (s) => {
        state = structuredClone(s);
      },
      log: (e) => logs.push(e),
      sleep: async (ms) => {
        clock += ms;
        await new Promise((r) => setTimeout(r, 1));
      },
      now: () => clock,
    },
    abort.signal,
  );
  return { done, abort, logs, state: () => state };
}

const cfg: ServeConfig = validateServeConfig({
  format: "tealbrick.agent-serve/1",
  harness: { kind: "command", command: ["true"] },
  inboxes: [{ tool: "connect__channel_inbox", cursor: { param: "sinceSeq", from: "nextSeq" }, id: "seq" }],
  pollSeconds: 5,
});

describe("agent serve", () => {
  it("first start primes the cursor (no history replay); new items start ONE turn; own messages are skipped", async () => {
    const w: World = { inbox: [{ seq: 1, text: "old" }], nextSeq: 1, holdStatus: "pending", calls: [], prompts: [], active: 0, maxActive: 0, inboxFails: 0 };
    const h = harness(cfg, w, { turns: 1 });
    // after the priming poll, new messages arrive: one from a person, one from the agent itself
    setTimeout(() => {
      w.inbox.push({ seq: 2, text: "hello agent" }, { seq: 3, text: "my own reply", fromSelf: true });
      w.nextSeq = 3;
    }, 5);
    await h.done;
    assert.equal(w.prompts.length, 1);
    assert.match(w.prompts[0] as string, /hello agent/);
    assert.doesNotMatch(w.prompts[0] as string, /old|my own reply/);
    assert.match(w.prompts[0] as string, /untrusted/);
    assert.ok(w.calls.some((c) => c.args.sinceSeq === 1), "the cursor is passed on the next poll");
    assert.ok(h.logs.includes("serve.inbox.primed"));
  });

  it("concurrency 1, and a held call is followed until the owner decides, then a follow-up turn runs", async () => {
    const w: World = { inbox: [], nextSeq: 0, holdStatus: "pending", calls: [], prompts: [], active: 0, maxActive: 0, inboxFails: 0 };
    const h = harness(cfg, w, {
      turns: 2,
      onTurn: (n, ev) => {
        if (n === 1) ev.onHeld({ status: "held", holdId: "hld_1", expiresAt: new Date(2_000_000_000_000).toISOString(), checkWith: "connect__tb_hold_status", tool: "connect__channel_send" } as never);
      },
    });
    setTimeout(() => {
      w.inbox.push({ seq: 1, text: "please send" });
      w.nextSeq = 1;
    }, 5);
    setTimeout(() => {
      w.holdStatus = "approved";
    }, 60);
    await h.done;
    assert.equal(w.maxActive, 1);
    assert.match(w.prompts[1] as string, /APPROVED.*connect__channel_send.*hld_1/s);
    assert.ok(w.calls.some((c) => c.name === "connect__tb_hold_status" && c.args.holdId === "hld_1"));
  });

  it("poll errors back off instead of spinning", async () => {
    const w: World = { inbox: [], nextSeq: 0, holdStatus: "pending", calls: [], prompts: [], active: 0, maxActive: 0, inboxFails: 3 };
    const h = harness({ ...cfg, backlog: true }, w, { turns: 1 });
    setTimeout(() => {
      w.inbox.push({ seq: 1, text: "after outage" });
      w.nextSeq = 1;
    }, 5);
    await h.done;
    assert.equal(h.logs.filter((l) => l === "serve.error").length, 3);
    assert.match(w.prompts[0] as string, /after outage/);
  });

  it("config is validated; prompts are bounded", () => {
    assert.throws(() => validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "claude" }, inboxes: [{ tool: "inbox" }] }));
    assert.throws(() => validateServeConfig({ format: "x", harness: { kind: "claude" }, inboxes: [] }));
    assert.ok(promptFor("connect__channel_inbox", [{ t: "x".repeat(100_000) }]).length <= 64_100);
  });
});
