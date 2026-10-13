/**
 * F35 (CLI 0.1.12): the serve-time "auto" inbox — joined Buzz channel → Buzz DMs → bot channel inbox only with a chat
 * bot; re-resolved at most every AUTO_RESOLVE_MS (no buzz_channels call per poll), one log line when the choice changes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpToolResult } from "@opt2-tealbrick/bridge";
import { AUTO_RESOLVE_MS, autoInboxes, type ServeState, serveLoop, validateServeConfig } from "../src/serve.ts";

describe("auto inbox (F35)", () => {
  it("chooses joined channels, else DMs, else the bot inbox only with a chat bot, else nothing", () => {
    const base = { tool: "x", wake: "mentions" as const };
    const ch = (id: string, type: string) => ({ id, type });
    assert.deepEqual(
      autoInboxes(base, [ch("d1", "direct"), ch("c1", "channel")], false).inboxes.map((i) => i.args?.channel),
      ["c1"],
    );
    const dm = autoInboxes(base, [ch("d1", "direct")], true);
    assert.equal(dm.why, "buzz_dms");
    assert.equal(dm.inboxes[0]?.wake, "all", "DMs always wake");
    assert.equal(autoInboxes(base, [], true).inboxes[0]?.tool, "connect__channel_inbox");
    assert.deepEqual(autoInboxes(base, null, false), { why: "none", inboxes: [] });
    assert.throws(() => validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "claude" }, inboxes: [{ auto: "slack" }] }));
  });

  it("re-resolves at most every AUTO_RESOLVE_MS, logs each change once, and serves the joined channel", async () => {
    const cfg = validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "command", command: ["true"] }, inboxes: [{ auto: "connect", wake: "all" }], pollSeconds: 30 });
    const w = { channels: [] as { id: string; type: string }[], messages: [] as Record<string, unknown>[], calls: [] as string[], prompts: [] as string[] };
    const logs: { e: string; f?: Record<string, unknown> }[] = [];
    let clock = 1_000_000;
    let state: ServeState = { cursors: {}, seen: {}, primed: {} };
    const abort = new AbortController();
    const done = serveLoop(
      cfg,
      {
        mcp: {
          async callTool(name, args): Promise<McpToolResult> {
            w.calls.push(name);
            if (name === "connect__buzz_channels") return { structuredContent: { channels: w.channels, relays: [] } };
            if (name === "connect__accounts_list") return { structuredContent: { accounts: [{ id: "a1", label: "mail", service: "gmail", kind: "as_me", access: "read" }] } };
            if (name === "connect__buzz_read") return { structuredContent: { messages: w.messages.filter((m) => m.channel === args.channel && Number(m.createdAt) > Number(args.since ?? 0)), untrusted: true, relays: [] } };
            return { isError: true, structuredContent: { error: { code: "unknown_tool" } } };
          },
        },
        async runTurn(prompt) {
          w.prompts.push(prompt);
          abort.abort();
          return { ok: true };
        },
        loadState: async () => structuredClone(state),
        saveState: async (s) => {
          state = structuredClone(s);
        },
        log: (e, f) => logs.push({ e, ...(f ? { f } : {}) }),
        sleep: async (ms) => {
          clock += ms;
          // the owner's approval joins the agent to a channel after a while; a message arrives later
          if (clock > 1_000_000 + 2 * AUTO_RESOLVE_MS && !w.channels.length) w.channels.push({ id: "ch_team", type: "channel" });
          if (clock > 1_000_000 + 4 * AUTO_RESOLVE_MS && !w.messages.length) w.messages.push({ id: "m1", channel: "ch_team", author: "npub1x", content: "hello agent", createdAt: Math.floor(clock / 1000) });
          await new Promise((r) => setTimeout(r, 1));
        },
        now: () => clock,
      },
      abort.signal,
    );
    await done;
    assert.match(w.prompts[0] as string, /hello agent/);
    const autoLogs = logs.filter((l) => l.e === "serve.inbox.auto");
    assert.deepEqual(
      autoLogs.map((l) => l.f?.chosen),
      ["none", "buzz_channels"],
      "one line per change",
    );
    const polls = w.calls.filter((c) => c === "connect__buzz_read").length;
    const resolves = w.calls.filter((c) => c === "connect__buzz_channels").length;
    assert.ok(resolves <= Math.ceil((clock - 1_000_000) / AUTO_RESOLVE_MS) + 1, `buzz_channels at most once per ${AUTO_RESOLVE_MS} ms (${resolves})`);
    assert.ok(polls > resolves, "polls do not re-resolve");
  });

  it("F59: a transient refusal at serve start is retried in ~5 s, never settles on none, and a mention posted in the gap gets ONE reply", async () => {
    const cfg = validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "command", command: ["true"] }, inboxes: [{ auto: "connect", wake: "mentions" }], pollSeconds: 30 });
    const start = 1_700_000_000_000; // ms
    let clock = start;
    let channelCalls = 0;
    const prompts: string[] = [];
    const logs: { e: string; f?: Record<string, unknown> }[] = [];
    let state: ServeState = { cursors: {}, seen: {}, primed: {} };
    // the mention is posted 2 s after serve start, while buzz_channels is still refused (hook app restarting)
    const mention = { id: "m1", channel: "ch_team", author: "npub1owner", content: "@agent please summarise", createdAt: Math.floor(start / 1000) + 2, mentionsMe: true };
    const abort = new AbortController();
    await serveLoop(
      cfg,
      {
        mcp: {
          async callTool(name, args): Promise<McpToolResult> {
            if (name === "connect__buzz_channels") {
              channelCalls += 1;
              if (clock < start + 3_000) return { isError: true, structuredContent: { error: { code: "hook_failed" } } };
              return { structuredContent: { channels: [{ id: "ch_team", type: "channel" }], relays: [] } };
            }
            if (name === "connect__buzz_read") {
              const since = Number(args.since ?? 0);
              return { structuredContent: { messages: [mention].filter((m) => m.createdAt > since), untrusted: true, relays: [] } };
            }
            return { isError: true, structuredContent: { error: { code: "unknown_tool" } } };
          },
        },
        async runTurn(prompt) {
          prompts.push(prompt);
          return { ok: true };
        },
        loadState: async () => structuredClone(state),
        saveState: async (x) => {
          state = structuredClone(x);
        },
        log: (e, f) => logs.push({ e, ...(f ? { f } : {}) }),
        sleep: async (ms) => {
          clock += ms;
          if (clock > start + 120_000) abort.abort();
          await new Promise((r) => setTimeout(r, 1));
        },
        now: () => clock,
      },
      abort.signal,
    );
    assert.equal(prompts.length, 1, "exactly one reply turn for the gap mention");
    assert.match(prompts[0] as string, /please summarise/);
    assert.ok(logs.some((l) => l.e === "serve.inbox.auto_retry"), "the transient refusal is retried");
    assert.ok(!logs.some((l) => l.e === "serve.inbox.auto" && l.f?.chosen === "none"), "never settles on none for a transient code");
    assert.ok(channelCalls <= 4, `retried quickly, not every poll (${channelCalls})`);
  });
});

