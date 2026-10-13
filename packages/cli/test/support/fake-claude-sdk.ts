/**
 * Test double of the Claude Agent SDK's `query()` for F48. It emulates the documented persistence behaviour
 * (sdk.d.ts 0.3.x `persistSession`: "When false, … Sessions will not be saved to ~/.claude/projects/"): unless
 * `persistSession === false`, it writes the turn transcript under $FAKE_SDK_HOME/.claude/projects/<cwd-slug>/.
 * It records the options it got in $FAKE_SDK_HOME/options.json. Never touches the real home.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function query(params: { prompt: string; options: Record<string, unknown> }) {
  const home = process.env.FAKE_SDK_HOME as string;
  const { abortController: _a, hooks: _h, env: _e, mcpServers: _m, ...plain } = params.options;
  writeFileSync(join(home, "options.json"), JSON.stringify(plain));
  // F54: Claude Code creates the auto-memory folder unless auto-memory is off (flag settings)
  const settings = (params.options.settings ?? {}) as { autoMemoryEnabled?: boolean; autoMemoryDirectory?: string };
  if (settings.autoMemoryEnabled !== false) mkdirSync(settings.autoMemoryDirectory ?? join(home, ".claude", "projects", String(params.options.cwd).replace(/[^A-Za-z0-9]/g, "-"), "memory"), { recursive: true });
  if (params.options.persistSession !== false) {
    const dir = join(home, ".claude", "projects", String(params.options.cwd).replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), JSON.stringify({ prompt: params.prompt }));
  }
  return (async function* () {
    yield { type: "system", subtype: "init", session_id: "s1", model: "claude-test-model" };
    // F57: one tool call that the bridge refused (error envelope in a text block), one that succeeded
    yield { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__tealbrick__connect__buzz_post" }, { type: "tool_use", id: "tu2", name: "mcp__tealbrick__knowledge__recall" }] } };
    yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "hook_failed", message: "x", requestId: "req_1" } }) }] }, { type: "tool_result", tool_use_id: "tu2", content: [{ type: "text", text: "{\"items\":[]}" }] }] } };
    yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
    yield { type: "result", subtype: "success", result: "done", num_turns: 2, total_cost_usd: 0.05, usage: { input_tokens: 3, cache_creation_input_tokens: 30, cache_read_input_tokens: 300, output_tokens: 7 }, modelUsage: { "claude-test-model": { inputTokens: 4, outputTokens: 8, cacheReadInputTokens: 400, cacheCreationInputTokens: 40, costUSD: 0.04 }, "claude-haiku-x": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } } };
  })();
}
