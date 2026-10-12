import { SPEC_VERSION } from "@opt2-tealbrick/spec";
import { connect } from "./connect.ts";
import type { Ctx, Handler } from "./ctx.ts";
import { makeCtx, parseCommandLine, unexpectedError } from "./ctx.ts";
import { draft, recipe, register } from "./drafts.ts";
import type { Io } from "./io.ts";
import { type CliError, EXIT, envelope, usageError } from "./io.ts";
import { leadGroups } from "./lead.ts";
import { agents, audit, canvas, catalog, harness, instances, keys, licences, login, logout, sessions, skills, whoami, workspaces } from "./owner.ts";
import { BRIDGE_VERSION, CLI_VERSION } from "./version.ts";

export type { Io } from "./io.ts";

const HELP = `tealbrick - Teal Brick command line

Owner mode (person session; reads and drafts only):
  login [--open] | logout | sessions | whoami
  workspaces list|show   agents list|show <agt>   catalog [--search <text>]
  instances list|show <ins>   canvas show   keys status   skills show|pack   harness options
  licences list   audit
  draft new --title <t> | add <opId> --input <json|@file> | rm <n> | move <n> <to>
        | show [<drf>] | list | validate [<drf>] | submit [<drf>]
  recipe export <drf> [-o file] | import <file>
  register agents --file <agents.json> [--draft <drf>]
Harness:
  connect <claude-desktop|codex|claude-code|generic> [--agent <agt>] [--remote|--local] [--write [--yes]] [--bridge <url>]
Agent mode (agent items only):
  agent login (--agent <agt>... | --file <agents.json> | --create) [--name <card name>] [--purpose <text>] [--harness <id>] [--label <machine>] | status | logout | list
  agent serve --file <agent-serve.json> [--agent <agt>]   answer inbox items with the agent's own harness
  (owner) agents export [--file <agents.json>]   writes card ids so agent login --file connects existing cards
Local bridge: bridge serve --stdio [--agent <agt>] [--store file --config-dir <d>]   Own infrastructure: bridge enrol --code - [--data-dir <d>] | bridge run [--data-dir <d>]
Standalone: standalone owner-key --ws <ws>   admin pause|resume [--agent] | revoke-connection <con> | ticket launch <product>|keys  --ws <ws> --bridge <url>
Global flags: --json  --portal <url>  --ws <ws_...>  --agent <agt_...>  --yes  --code -
Exit codes: 0 ok, 1 unexpected, 2 usage, 3 not signed in, 4 wrong credential kind, 5 refused,
            6 not found, 7 conflict, 8 validation failed, 9 network, 10 device flow denied/expired
`;

/** Owner-mode groups: they use the person item only. */
const ownerGroups: Record<string, Handler> = {
  login,
  logout,
  sessions,
  whoami,
  workspaces,
  agents,
  catalog,
  instances,
  canvas,
  keys,
  skills,
  harness,
  licences,
  audit,
  draft,
  recipe,
  register,
};

/** Harness connection: reads agent items (never the person item). */
const harnessGroups: Record<string, Handler> = { connect };

function dispatch(ctx: Ctx): Handler {
  const group = ctx.pos[0];
  if (group === undefined) throw usageError("missing command; run tealbrick --help");
  const handler = ownerGroups[group] ?? harnessGroups[group] ?? leadGroups[group];
  if (!handler) throw usageError(`unknown command: ${group}`);
  return handler;
}

/**
 * Run the CLI. Returns the exit code (CLI.md section 2.1); never throws.
 * --json: exactly one JSON value on stdout (result, or the CORE section 8 error envelope); human text on stderr.
 */
export async function run(argv: string[], io: Io): Promise<number> {
  const wantsJson = argv.includes("--json");
  try {
    const { values, positionals } = parseCommandLine(argv);
    if (values.version === true) {
      const info = { cli: CLI_VERSION, bridge: BRIDGE_VERSION, spec: SPEC_VERSION };
      io.stdout.write(wantsJson ? `${JSON.stringify(info)}\n` : `tealbrick ${info.cli} (bridge ${info.bridge}, spec ${info.spec})\n`);
      return EXIT.ok;
    }
    if (values.help === true) {
      io.stdout.write(HELP);
      return EXIT.ok;
    }
    if (positionals.length === 0) {
      io.stderr.write(HELP);
      throw usageError("missing command");
    }
    const ctx = makeCtx(argv, io);
    await dispatch(ctx)(ctx);
    return EXIT.ok;
  } catch (e) {
    const err: CliError = unexpectedError(e);
    io.stderr.write(`error: ${err.message}${err.requestId !== "local" && err.requestId !== "unknown" ? ` (request ${err.requestId})` : ""}\n`);
    if (wantsJson) io.stdout.write(`${JSON.stringify(envelope(err))}\n`);
    return err.exit;
  }
}
