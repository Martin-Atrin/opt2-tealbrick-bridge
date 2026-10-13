/**
 * Test double of the `claude` CLI for the claude-code serve harness (F79). A `claude` shell shim on PATH runs this
 * file. It records argv, cwd, env names, the prompt (stdin) and the MCP config it was given (content + file mode) in
 * $FAKE_CLAUDE_RECORD, then acts per $FAKE_CLAUDE_MODE:
 *   ok     — starts the MCP server named in the config (the real relay), sends `initialize`, records the answer, and
 *            prints a Claude Code `--output-format json` result
 *   error  — prints a result with is_error true and exits 1
 *   hang   — records its pid, ignores SIGTERM and never ends (the runner must escalate to SIGKILL)
 * Never touches the real home or the real Claude Code.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const recordPath = process.env.FAKE_CLAUDE_RECORD as string;
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const cfgPath = argv[argv.indexOf("--mcp-config") + 1] as string;
const cfgText = readFileSync(cfgPath, "utf8");
const prompt = readFileSync(0, "utf8");
const record: Record<string, unknown> = { argv, cwd: process.cwd(), envNames: Object.keys(process.env).sort(), prompt, mcpConfigPath: cfgPath, mcpConfig: JSON.parse(cfgText), mcpConfigMode: statSync(cfgPath).mode & 0o777, pid: process.pid };
const save = () => writeFileSync(recordPath, JSON.stringify(record));

if (mode === "hang") {
  process.on("SIGTERM", () => {
    record.sawSigterm = true;
    save();
  });
  save();
  setInterval(() => undefined, 1_000);
} else if (mode === "error") {
  save();
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 20, duration_ms: 50, total_cost_usd: 0.01, permission_denials: [], result: "" }));
  process.exit(1);
} else {
  const server = (record.mcpConfig as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.tealbrick as { command: string; args: string[] };
  const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  let out = "";
  let err = "";
  let done = false;
  const finish = (answer: unknown) => {
    if (done) return;
    done = true;
    record.initialize = answer;
    record.relayStderr = err.slice(0, 2000);
    save();
    child.kill("SIGTERM");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 1234, total_cost_usd: 0.12, permission_denials: [{ tool_name: "Bash" }, { tool_name: "Write" }], result: "replied PRIVATE_RESULT_TEXT", session_id: "s1", usage: { input_tokens: 9, cache_creation_input_tokens: 900, cache_read_input_tokens: 20000, output_tokens: 80 }, modelUsage: { "claude-sonnet-x": { inputTokens: 10, outputTokens: 100, cacheReadInputTokens: 25000, cacheCreationInputTokens: 1000, costUSD: 0.12 } } }));
  };
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
    for (const line of out.split("\n").filter(Boolean)) {
      try {
        const m = JSON.parse(line) as { id?: number };
        if (m.id === 1) return finish(m);
      } catch {
        /* partial line */
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => {
    err += d.toString();
  });
  child.on("exit", () => setTimeout(() => finish(null), 50));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude" } } })}\n`);
}
