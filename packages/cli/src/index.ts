/**
 * tealbrick CLI.
 * - owner mode: person sign-in (device flow), reads, drafts; applying needs browser confirmation.
 * - agent mode, bridge relay and admin: lead sections (see lead.ts).
 * - connect: prints (or, with --write, previews and writes) harness configuration.
 * Owner and agent credentials are separate and never interchangeable.
 */
export const role = "tealbrick-cli";
export { run } from "./cli.ts";
export type { Io } from "./io.ts";
