import { parseArgs } from "node:util";
import type { Io } from "./io.ts";
import { CliError, EXIT, usageError } from "./io.ts";
import { normalizePortalOrigin, PortalClient } from "./portal.ts";
import type { CredentialStore } from "./store.ts";
import { configDir, createStore } from "./store.ts";
import { BUILD_PORTAL_ORIGIN } from "./version.ts";

/** Union of every option of every command; strict parsing rejects anything else (exit 2). */
export const OPTIONS = {
  // global flags (CLI.md section 2)
  json: { type: "boolean" },
  portal: { type: "string" },
  ws: { type: "string" },
  agent: { type: "string", multiple: true },
  yes: { type: "boolean" },
  code: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  // owner mode
  open: { type: "boolean" },
  search: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  input: { type: "string" },
  draft: { type: "string" },
  file: { type: "string" },
  output: { type: "string", short: "o" },
  product: { type: "string" },
  assigned: { type: "string" },
  action: { type: "string" },
  state: { type: "string" },
  limit: { type: "string" },
  cursor: { type: "string" },
  label: { type: "string" },
  /** agent login: suggested card name for a new card (C96; Core accepts agents[].name ≤ 60) */
  name: { type: "string" },
  /** agent login: suggested card purpose (spec 0.1.14, ≤ 280) */
  purpose: { type: "string" },
  /** adopt (C96/C106) */
  "from-v1": { type: "string" },
  persona: { type: "string" },
  serve: { type: "boolean" },
  "no-serve": { type: "boolean" },
  wake: { type: "string" },
  "dry-run": { type: "boolean" },
  undo: { type: "boolean" },
  purge: { type: "boolean" },
  inbox: { type: "string" },
  "keep-existing": { type: "boolean" },
  "switch-to-stdio": { type: "boolean" },
  start: { type: "boolean" },
  /** agent serve: restart after a crash with backoff (own pidfile) */
  supervise: { type: "boolean" },
  /** internal: the process a supervisor started */
  "supervised-child": { type: "boolean" },
  // connect
  write: { type: "boolean" },
  remote: { type: "boolean" },
  local: { type: "boolean" },
  bridge: { type: "string" },
  // lead sections (agent / bridge / admin): parsed here so the lead only reads them
  harness: { type: "string" },
  create: { type: "boolean" },
  stdio: { type: "boolean" },
  "data-dir": { type: "string" },
  path: { type: "string" },
} as const;

export interface Globals {
  json: boolean;
  portal: string | undefined;
  ws: string | undefined;
  /** First --agent (or TB_AGENT); `agents` holds every repeated --agent. */
  agent: string | undefined;
  agents: string[];
  yes: boolean;
  /** Raw --code value; "-" means read from stdin. Never log it. */
  code: string | undefined;
}

type ParsedValues = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

export interface Ctx {
  io: Io;
  g: Globals;
  /** Positionals: group, command, arguments. */
  pos: string[];
  v: ParsedValues;
  /** Output `result` (JSON mode) or `human` text (default mode) on stdout. */
  emit(result: unknown, human?: string): void;
  /** Guidance and progress on stderr. */
  say(text: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  cwd(): string;
  platform(): string;
  store(): CredentialStore;
  configDir(): string;
  /** Origin given by --portal / TB_PORTAL_URL, or undefined. */
  explicitPortal(): string | undefined;
  /** Origin for a session-less command (login): explicit or the build default. */
  portalOrigin(): string;
  client(origin: string, token?: string): PortalClient;
}

export function parseCommandLine(argv: string[]): { values: ParsedValues; positionals: string[] } {
  try {
    const r = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    return { values: r.values, positionals: r.positionals };
  } catch (e) {
    throw usageError(e instanceof Error ? e.message.split("\n")[0] ?? "invalid arguments" : "invalid arguments");
  }
}

export function makeCtx(argv: string[], io: Io): Ctx {
  const { values, positionals } = parseCommandLine(argv);
  const agents = values.agent ?? [];
  const g: Globals = {
    json: values.json === true,
    portal: values.portal,
    ws: values.ws ?? io.env.TB_WORKSPACE,
    agent: agents[0] ?? io.env.TB_AGENT,
    agents,
    yes: values.yes === true,
    code: values.code,
  };
  let store: CredentialStore | undefined = io.store;
  const ctx: Ctx = {
    io,
    g,
    pos: positionals,
    v: values,
    emit(result, human) {
      if (g.json) io.stdout.write(`${JSON.stringify(result)}\n`);
      else io.stdout.write(`${human ?? JSON.stringify(result, null, 2)}\n`);
    },
    say(text) {
      io.stderr.write(`${text}\n`);
    },
    now: () => (io.now ?? Date.now)(),
    sleep: (ms) => (io.sleep ? io.sleep(ms) : new Promise((r) => setTimeout(r, ms))),
    cwd: () => io.cwd ?? process.cwd(),
    platform: () => io.platform ?? process.platform,
    store() {
      store ??= createStore(io.env, io.platform ?? process.platform);
      return store;
    },
    configDir: () => configDir(io.env),
    explicitPortal() {
      const raw = g.portal ?? io.env.TB_PORTAL_URL;
      return raw && raw.length > 0 ? normalizePortalOrigin(raw) : undefined;
    },
    portalOrigin() {
      const e = ctx.explicitPortal();
      if (e) return e;
      if (BUILD_PORTAL_ORIGIN) return normalizePortalOrigin(BUILD_PORTAL_ORIGIN);
      throw usageError("no Portal origin: pass --portal <url> or set TB_PORTAL_URL");
    },
    client: (origin, token) => new PortalClient({ origin, fetch: io.fetch, ...(token !== undefined ? { token } : {}) }),
  };
  return ctx;
}

export type Handler = (ctx: Ctx) => Promise<void>;

/** Fixed-width text table for human output. */
export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0]?.map((_c, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ").trimEnd()).join("\n");
}

export function requirePos(ctx: Ctx, index: number, what: string): string {
  const v = ctx.pos[index];
  if (v === undefined || v.length === 0) throw usageError(`missing ${what}`);
  return v;
}

export function unexpectedError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  return new CliError(EXIT.unexpected, "internal", e instanceof Error ? e.message : "unexpected error");
}
