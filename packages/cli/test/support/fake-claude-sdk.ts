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
  if (params.options.persistSession !== false) {
    const dir = join(home, ".claude", "projects", String(params.options.cwd).replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), JSON.stringify({ prompt: params.prompt }));
  }
  return (async function* () {
    yield { type: "system", subtype: "init", session_id: "s1" };
    yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
    yield { type: "result", subtype: "success", result: "done" };
  })();
}
