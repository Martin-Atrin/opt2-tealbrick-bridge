/**
 * C158 private-repo gate (the mirror of the public repo's release gate): ONE owner per module (L1).
 * The agent side of the bridge (stdio relay, MCP client, JSON limits, ManifestApi binding, protocol constants) is
 * owned by `@opt2-tealbrick/relay` in the CLI repo. This repo imports it and never carries a second copy:
 *   (a) no agent-side package directory (cli, harness-claude, harness-eve, relay) and no agent-side module file name;
 *   (b) no source file DEFINES a relay / MCP-client / JSON-limit / ManifestApi / protocol-constant symbol;
 *   (c) no source file imports one of those modules by a relative path;
 *   (d) the bridge package depends on `@opt2-tealbrick/relay` and exports no `./relay` entry.
 * Runs in `pnpm test` and `pnpm lint`. Proven both ways by scripts/test/agent-side-gate.test.ts (L34): quiet on the
 * clean tree, fires on planted files. Usage: node scripts/agent-side-gate.ts [<root>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** symbols owned by `@opt2-tealbrick/relay` (relay.ts, mcp-client.ts, json-limits.ts, api.ts, manifest-adapter.ts, constants.ts) */
export const AGENT_SYMBOLS = [
  // relay.ts
  "startRelay",
  "RelayOptions",
  "RelaySigner",
  "RelayStatus",
  "RunningRelay",
  "RelayError",
  "SignWithSigner",
  "TokenRefusal",
  "tokenRefusal",
  "retryAfterS",
  "offlineDetail",
  "TOKEN_RATE_LIMIT_DEFAULT_S",
  // mcp-client.ts
  "connectMcp",
  "McpClient",
  "McpStartError",
  "McpTimeoutError",
  "McpTool",
  "McpToolResult",
  "StdioTarget",
  "HeldResult",
  "HoldOutcome",
  "heldOf",
  "holdOutcome",
  "pollHold",
  "MCP_CALL_TIMEOUT_MS",
  // json-limits.ts
  "tooDeep",
  "validRpcId",
  "MAX_JSON_DEPTH",
  // api.ts
  "ManifestApi",
  "Kek",
  "AssertionExpect",
  "HoldVerdict",
  "BeforeChainResult",
  "isRefusal",
  // manifest-adapter.ts (the binding; the bridge keeps loadManifestApi and the dropPrivileges re-export)
  "manifestApi",
  // constants.ts
  "MCP_VERSIONS",
  "SDK_MAJORS",
  "SDK_CURRENT_MAJOR",
  "RELAY_VERSION",
] as const;

/** a DEFINITION of one of the symbols (a declaration, not an import or a use) */
const NAMES = AGENT_SYMBOLS.join("|");
const DEFINITION_RE = new RegExp(`\\b(?:(?:function\\*?|const|let|var|class|interface|enum)\\s+(${NAMES})\\b|type\\s+(${NAMES})\\s*[=<])`);
/** `import { type X } from` / `export { X } from` lists name symbols without defining them: blank them, keep the line count */
const NAME_LIST_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[\w$*]+\s*,\s*)?\{[^}]*\}\s*from\s*["'][^"']+["']/g;
const blank = (s: string) => s.replace(NAME_LIST_RE, (m) => m.replace(/[^\n]/g, " "));
/** a relative import or re-export of an agent-side module */
const MODULE_IMPORT_RE = /\bfrom\s+["']\.{1,2}\/(?:[\w./-]*\/)?(relay|relay-entry|mcp-client|json-limits|api)(?:\.ts|\.js)?["']|\bimport\(\s*["']\.{1,2}\/(?:[\w./-]*\/)?(relay|relay-entry|mcp-client|json-limits|api)(?:\.ts|\.js)?["']\s*\)/;

/** agent-side package directories (they live in the CLI repo) */
const AGENT_DIRS = ["packages/cli", "packages/harness-claude", "packages/harness-eve", "packages/relay"];
/** agent-side module file names under a `src/` directory */
const AGENT_MODULES = ["relay.ts", "relay-entry.ts", "mcp-client.ts", "json-limits.ts", "api.ts"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".tb-ci"]);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
/** the gate and its test hold the deny-lists themselves */
const SELF = new Set(["scripts/agent-side-gate.ts", "scripts/test/agent-side-gate.test.ts"]);

export function agentSideGate(root: string): string[] {
  const problems: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      if (statSync(abs).isDirectory()) {
        if (AGENT_DIRS.includes(rel)) problems.push(`${rel}/: agent-side package directory (it lives in the CLI repo)`);
        walk(abs);
        continue;
      }
      if (AGENT_MODULES.includes(name) && /(^|\/)src\//.test(rel)) problems.push(`${rel}: agent-side module file name (${name}); import @opt2-tealbrick/relay instead`);
      if (!SOURCE.test(name) || SELF.has(rel)) continue;
      const text = readFileSync(abs, "utf8");
      const lines = blank(text).split("\n");
      const raw = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        const def = DEFINITION_RE.exec(line);
        if (def) problems.push(`${rel}:${i + 1}: defines ${def[1] ?? def[2]}, which @opt2-tealbrick/relay owns`);
        const imp = MODULE_IMPORT_RE.exec(raw[i] as string);
        if (imp) problems.push(`${rel}:${i + 1}: imports the agent-side module ${imp[1] ?? imp[2]} by a relative path`);
      }
    }
  };
  walk(root);
  const pkg = join(root, "packages", "bridge", "package.json");
  if (existsSync(pkg)) {
    const j = JSON.parse(readFileSync(pkg, "utf8")) as { dependencies?: Record<string, string>; exports?: Record<string, unknown> };
    if (!j.dependencies?.["@opt2-tealbrick/relay"]) problems.push("packages/bridge/package.json: does not depend on @opt2-tealbrick/relay");
    if (j.exports && "./relay" in j.exports) problems.push("packages/bridge/package.json: exports ./relay (the relay form lives in @opt2-tealbrick/relay)");
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(fileURLToPath(new URL("..", import.meta.url))));
  const problems = agentSideGate(root);
  if (problems.length) {
    for (const p of problems) console.error(`agent-side-gate: ${p}`);
    console.error(`agent-side-gate: FAIL (${problems.length}) in ${basename(root)}: one owner per module; the agent side lives in @opt2-tealbrick/relay (C158, L1)`);
    process.exit(1);
  }
  console.log(`agent-side-gate: ok (no agent-side package or module, ${AGENT_SYMBOLS.length} relay symbols not defined here)`);
}
