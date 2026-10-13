import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOptions, type HarnessEvent, runTurn, sessionEnv, usageOf } from "../src/index.ts";

test("session env is allow-listed: no Teal Brick or person credentials", () => {
  const env = sessionEnv({ PATH: "/bin", HOME: "/h", TB_PORTAL_URL: "x", TEALBRICK_OWNER: "y", CLERK_SESSION: "z", GH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }, { passthrough: ["GH_TOKEN"], modelKeyEnv: "ANTHROPIC_API_KEY" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k" });
});

test("options are isolated and reach apps only through the relay", () => {
  const o = buildOptions({ bridge: { agentId: "agt_X" }, cwd: "/w", env: {} });
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.permissionMode, "default");
  assert.deepEqual((o.mcpServers as Record<string, unknown>).tealbrick, { type: "stdio", command: "tealbrick", args: ["bridge", "serve", "--stdio", "--agent", "agt_X"] });
  assert.deepEqual(o.allowedTools, ["mcp__tealbrick__*"]);
  assert.throws(() => buildOptions({ bridge: { agentId: "a" }, cwd: "/w", extraMcpServers: { tealbrick: {} } }));
});

test("F48: persistSession false reaches the SDK options; the default leaves the SDK default", () => {
  assert.equal(buildOptions({ bridge: { agentId: "a" }, cwd: "/w", env: {}, persistSession: false }).persistSession, false);
  assert.equal("persistSession" in buildOptions({ bridge: { agentId: "a" }, cwd: "/w", env: {} }), false);
  assert.deepEqual(buildOptions({ bridge: { agentId: "a" }, cwd: "/w", env: {}, autoMemory: false }).settings, { autoMemoryEnabled: false });
  assert.deepEqual(buildOptions({ bridge: { agentId: "a" }, cwd: "/w", env: {}, autoMemory: { directory: "/a/memory" } }).settings, { autoMemoryEnabled: true, autoMemoryDirectory: "/a/memory" });
});

test("a held result adds guidance and raises a held event; nothing is retried", async () => {
  const events: string[] = [];
  const sdk = {
    query({ options }: { prompt: unknown; options: Record<string, unknown> }) {
      const hook = ((options.hooks as any).PostToolUse[0].hooks[0]) as (i: unknown) => Promise<any>;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        const out = await hook({ tool_name: "mcp__tealbrick__notes__notes_send", tool_response: { structuredContent: { status: "held", holdId: "h1", expiresAt: "2030-01-01T00:00:00Z", checkWith: "notes__tb_hold_status" } } });
        assert.match(out.hookSpecificOutput.additionalContext, /exact same call/);
        yield { type: "result", subtype: "success", result: "done" };
      })();
    },
  };
  await runTurn(sdk, "hi", { bridge: { agentId: "agt_X" }, cwd: "/w", env: {} }, (e) => events.push(e.type));
  assert.deepEqual(events, ["session", "held", "result"]);
});

test("tool search: MCP tools stay deferrable — the session env never carries a host ENABLE_TOOL_SEARCH and the relay is not alwaysLoad", () => {
  const o = buildOptions({ bridge: { agentId: "agt_X" }, cwd: "/w", env: { PATH: "/bin", HOME: "/h", ENABLE_TOOL_SEARCH: "false" } });
  assert.equal((o.env as Record<string, string>).ENABLE_TOOL_SEARCH, undefined, "a host setting cannot turn tool search off for the agent");
  assert.equal(((o.mcpServers as Record<string, Record<string, unknown>>).tealbrick as Record<string, unknown>).alwaysLoad, undefined);
});

test("usage: a result carries tokens (modelUsage summed), cost, turns and the init model; is_error makes ok false", async () => {
  const events: HarnessEvent[] = [];
  const sdk = {
    query() {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "s1", model: "claude-main" };
        yield { type: "result", subtype: "success", is_error: true, result: "Login expired", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} };
      })();
    },
  };
  await runTurn(sdk, "hi", { bridge: { agentId: "agt_X" }, cwd: "/w", env: {} }, (e) => events.push(e));
  const r = events.find((e) => e.type === "result");
  assert.equal(r?.type === "result" && r.ok, false, "an error result is not ok");
  assert.deepEqual(usageOf({ num_turns: 4, total_cost_usd: 0.3, usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } }), { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 4, costUsd: 0.3, numTurns: 4 });
  assert.deepEqual(usageOf({ modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }, b: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 } } }), { inputTokens: 11, cacheCreationInputTokens: 44, cacheReadInputTokens: 33, outputTokens: 22, model: "a,b" });
  assert.equal(usageOf({ result: "text only" }), undefined);
});
