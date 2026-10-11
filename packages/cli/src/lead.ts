import type { Handler } from "./ctx.ts";
import { CliError, EXIT } from "./io.ts";

/**
 * ===================================================================================================
 * LEAD SECTION - agent mode, local bridge, standalone admin. NOT implemented in this worker.
 * Replace each stub below with the real handler (same `Handler` signature, see ctx.ts). The dispatcher
 * in cli.ts routes the first word of the command line to `leadGroups`; nothing else needs to change.
 *   agent login|status|logout|list          CLI.md section 4
 *   bridge serve|enrol|run                  CLI.md section 5
 *   admin pause|resume|revoke-connection|ticket   CLI.md section 3 (standalone workspaces)
 *   standalone owner-key                    CLI.md section 3
 * Rules for the real handlers: never load the person item (src/session.ts reads it, nothing here may);
 * `--code -` is parsed into ctx.g.code; options for these commands are already declared in ctx.ts OPTIONS.
 * ===================================================================================================
 */

function notImplemented(what: string): Handler {
  return async () => {
    throw new CliError(EXIT.unexpected, "internal", `${what}: not implemented in this worker`);
  };
}

export const leadGroups: Record<string, Handler> = {
  agent: notImplemented("agent"),
  bridge: notImplemented("bridge"),
  admin: notImplemented("admin"),
  standalone: notImplemented("standalone"),
};
