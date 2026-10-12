import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOptions, runTurn, sessionEnv } from "../src/index.ts";

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
