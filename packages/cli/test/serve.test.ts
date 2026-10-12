import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpToolResult } from "@opt2-tealbrick/bridge";
import { decodeOnBehalfOf, encodeOnBehalfOf } from "../src/relay-main.ts";
import { promptFor, type ServeConfig, type ServeState, senderOf, serveLoop, validateServeConfig } from "../src/serve.ts";

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

describe("agent serve: wake filter (F15)", () => {
  const runWith = async (inbox: Record<string, unknown>, items: Record<string, unknown>[]) => {
    const abort = new AbortController();
    let state: ServeState = { cursors: {}, seen: {}, primed: {} };
    const prompts: string[] = [];
    const logs: string[] = [];
    let polls = 0;
    await serveLoop(
      validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "command", command: ["true"] }, inboxes: [{ tool: "connect__channel_inbox", cursor: { param: "sinceSeq", from: "nextSeq" }, id: "seq", ...inbox }], backlog: true }),
      {
        mcp: {
          async callTool() {
            polls += 1;
            if (polls > 2) abort.abort();
            return { structuredContent: { messages: polls === 1 ? items : [], nextSeq: items.length } };
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
        log: (e) => logs.push(e),
        sleep: async () => {
          await new Promise((r) => setTimeout(r, 1));
        },
        now: () => 1,
      },
      abort.signal,
    );
    return { prompts, logs, seen: state.seen };
  };

  it("default: channel messages wake only on a mention; DMs always wake; the rest is marked seen", async () => {
    const r = await runWith({}, [
      { seq: 1, conversationType: "channel", mentionsMe: false, text: "chatter" },
      { seq: 2, conversationType: "channel", mentionsMe: true, text: "@agent please" },
      { seq: 3, conversationType: "direct", mentionsMe: false, text: "dm hello" },
    ]);
    assert.equal(r.prompts.length, 1);
    assert.match(r.prompts[0] as string, /@agent please/);
    assert.match(r.prompts[0] as string, /dm hello/);
    assert.doesNotMatch(r.prompts[0] as string, /chatter/);
    assert.deepEqual(Object.values(r.seen)[0], ["1", "2", "3"], "non-waking items never wake later");
  });

  it('wake: "all" wakes on every channel message', async () => {
    const r = await runWith({ wake: "all" }, [{ seq: 1, conversationType: "channel", mentionsMe: false, text: "chatter" }]);
    assert.equal(r.prompts.length, 1);
  });

  it("older Connect without mentionsMe: falls back to all, with ONE warning", async () => {
    const r = await runWith({}, [
      { seq: 1, conversationType: "channel", text: "a" },
      { seq: 2, conversationType: "channel", text: "b" },
    ]);
    assert.equal(r.prompts.length, 1);
    assert.equal(r.logs.filter((l) => l === "serve.inbox.no_mentions_field").length, 1);
    assert.throws(() => validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "claude" }, inboxes: [{ tool: "connect__channel_inbox", wake: "some" }] }));
  });
});

describe("agent serve: onBehalfOf (G4b)", () => {
  it("Connect channel items name their sender as an unverified channel_sender claim", () => {
    const inbox = { tool: "connect__channel_inbox" };
    assert.deepEqual(senderOf(inbox, { service: "Slack", sender: { id: "U024BE7LH", name: "Ann" } }), { kind: "channel_sender", id: "slack:U024BE7LH", display: "Ann" });
    assert.deepEqual(senderOf({ ...inbox, sender: { channel: "buzz", idField: "pubkey" } }, { pubkey: "npub1abc" }), { kind: "channel_sender", id: "buzz:npub1abc" });
    assert.equal(senderOf(inbox, { service: "slack" }), undefined, "no sender id → no claim");
    assert.equal(senderOf(inbox, { service: "sl ack", sender: { id: "U1" } }), undefined, "bad channel → no claim");
    assert.equal(senderOf(inbox, { service: "slack", sender: { id: "x".repeat(300) } }), undefined, "oversized → no claim");
    assert.equal(senderOf({ ...inbox, sender: false }, { service: "slack", sender: { id: "U1" } }), undefined);
    const c = { kind: "channel_sender" as const, id: "telegram:12345", display: "Bo" };
    assert.deepEqual(decodeOnBehalfOf(encodeOnBehalfOf(c)), c);
    assert.equal(decodeOnBehalfOf("not-json"), undefined);
  });

  it("one turn per sender; each turn gets its sender's claim; the hold follow-up keeps it", async () => {
    const abort = new AbortController();
    let state: ServeState = { cursors: {}, seen: {}, primed: {} };
    const turns: { prompt: string; onBehalfOf?: unknown }[] = [];
    let polls = 0;
    let clock = 2_000_000;
    const items = [
      { seq: 1, service: "slack", sender: { id: "U1", name: "Ann" }, text: "a1" },
      { seq: 2, service: "slack", sender: { id: "U2", name: "Bo" }, text: "b1" },
      { seq: 3, service: "slack", sender: { id: "U1", name: "Ann" }, text: "a2" },
    ];
    await serveLoop(
      { ...cfg, backlog: true },
      {
        mcp: {
          async callTool(name, args) {
            if (name === "connect__channel_inbox") {
              polls += 1;
              if (polls > 6) abort.abort();
              return { structuredContent: { messages: items.filter((m) => m.seq > Number(args.sinceSeq ?? 0)), nextSeq: 3 } };
            }
            return { structuredContent: { status: "approved" } };
          },
        },
        async runTurn(prompt, events, opts) {
          turns.push({ prompt, onBehalfOf: opts?.onBehalfOf });
          if (turns.length === 1) events.onHeld({ status: "held", holdId: "hld_9", expiresAt: new Date(2_000_000_000_000).toISOString(), checkWith: "connect__tb_hold_status", tool: "connect__channel_send" } as never);
          return { ok: true };
        },
        loadState: async () => structuredClone(state),
        saveState: async (s) => {
          state = structuredClone(s);
        },
        log: () => undefined,
        sleep: async (ms) => {
          clock += ms;
          await new Promise((r) => setTimeout(r, 1));
        },
        now: () => clock,
      },
      abort.signal,
    );
    assert.equal(turns.length, 3, "two sender turns + one hold follow-up");
    assert.match(turns[0]?.prompt as string, /a1[\s\S]*a2/);
    assert.doesNotMatch(turns[0]?.prompt as string, /b1/);
    assert.deepEqual(turns[0]?.onBehalfOf, { kind: "channel_sender", id: "slack:U1", display: "Ann" });
    assert.deepEqual(turns[1]?.onBehalfOf, { kind: "channel_sender", id: "slack:U2", display: "Bo" });
    assert.match(turns[2]?.prompt as string, /APPROVED/);
    assert.deepEqual(turns[2]?.onBehalfOf, turns[0]?.onBehalfOf, "the follow-up acts for the same sender");
  });
});

describe("agent serve: refused inbox backs off (F35)", () => {
  it("a scope_denied inbox is polled less and less and logged per back-off step; the other inbox keeps working", async () => {
    const abort = new AbortController();
    let state: ServeState = { cursors: {}, seen: {}, primed: {} };
    let clock = 0;
    const calls: Record<string, number> = {};
    const logs: string[] = [];
    let polls = 0;
    await serveLoop(
      validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "command", command: ["true"] }, inboxes: [{ tool: "connect__channel_inbox" }, { tool: "connect__buzz_read", args: { channel: "c1" } }], pollSeconds: 10 }),
      {
        mcp: {
          async callTool(name) {
            calls[name] = (calls[name] ?? 0) + 1;
            if (name === "connect__buzz_read" && ++polls > 40) abort.abort();
            if (name === "connect__channel_inbox") return { isError: true, structuredContent: { error: { code: "scope_denied" } } };
            return { structuredContent: { messages: [] } };
          },
        },
        async runTurn() {
          return { ok: true };
        },
        loadState: async () => structuredClone(state),
        saveState: async (x) => {
          state = structuredClone(x);
        },
        log: (e) => logs.push(e),
        sleep: async (ms) => {
          clock += ms;
          await new Promise((r) => setTimeout(r, 0));
        },
        now: () => clock,
      },
      abort.signal,
    );
    assert.equal(calls.connect__buzz_read, 41, "the readable inbox is polled every cycle");
    assert.ok((calls.connect__channel_inbox ?? 0) <= 6, `the refused inbox backs off (${calls.connect__channel_inbox} calls in 41 cycles)`);
    assert.equal(logs.filter((l) => l === "serve.inbox.refused").length, calls.connect__channel_inbox, "one log line per back-off step");
  });
});
