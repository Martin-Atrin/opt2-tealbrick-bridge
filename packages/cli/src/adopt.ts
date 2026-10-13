/**
 * `tealbrick adopt` phase 1 (C96/C106, ADOPT-DESIGN §1–§3, §5–§12): onboard an agent that
 * already runs on this machine with one command and one owner approval (the existing device flow).
 *
 * detect → plan → (--dry-run stops) → approve → wire → serve config → verify → report.
 * Safety (§11): names and paths only, never a secret value (credential-like files are classified by NAME and never
 * opened); never copies v1 credentials, grants, channel bindings or sessions; never stops or signals a process it did
 * not start (L20: own pidfile only); backs up every config file before its first edit; --dry-run writes nothing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { confirm, desktopConfigPath, mergeJsonConfig, mergeTomlConfig, planConnect, readExisting, writeAtomic } from "./connect.ts";
import type { Ctx, Handler } from "./ctx.ts";
import { CliError, EXIT, usageError } from "./io.ts";
import { type AdoptSuggestion, agentLogin, probeAgent, selfRevoke, startDetached } from "./lead.ts";
import { pickAgentItem } from "./relay-main.ts";
import { AGENT_ITEM_PREFIX } from "./store.ts";
import { heartbeatPath, isAlive, pidPath, readHeartbeat, readPid, stopLoop } from "./supervise.ts";

export const ADOPT_HARNESSES = ["claude-sdk", "claude-code", "claude-desktop", "codex", "command"] as const;
export type AdoptHarness = (typeof ADOPT_HARNESSES)[number];

/**
 * credential-like by NAME (§2, F3): never opened, never copied, only listed.
 * F29 — the ONLY files adopt opens inside a v1 `.tealbrick/` folder are {@link V1_READ_ALLOWLIST}: the serve config
 * (paths and settings, no secret values) and the agent's own pid files (an integer, existence check only). Every other
 * entry of `.tealbrick/`, `traces/` and `sessions/` is listed by name and never opened.
 */
export const V1_READ_ALLOWLIST = [".tealbrick/native-serve.json", ".tealbrick/native-serve.pid", ".tealbrick/serve.pid", ".tealbrick/agent.pid"] as const;
const CREDENTIAL_NAME = [/\.key$/i, /credentials/i, /-url\.txt$/i, /^portal-grants\.json$/i, /\.pem$/i, /^\.env/i, /token/i, /secret/i];
const CREDENTIAL_DIR = new Set([".tealbrick", "traces", "sessions"]);
/** v1 built-ins that a Teal Brick agent must not get by default (shell, sub-agents) (§6, F8) */
const DROPPED_BUILTINS = new Set(["Bash", "BashOutput", "KillShell", "KillBash", "Agent", "Task", "NotebookEdit"]);
/**
 * §6 v1 → opt2 tool names (from a real v1 recipe + persona, onboarding lead). Applied ONLY to whole identifiers inside a
 * code span (`name`) or after `mcp__<server>__`, never inside words or prose; every rewrite is listed for review.
 */
export const TOOL_REWRITES: Readonly<Record<string, string>> = {
  list_collections: "knowledge__collections_list",
  create_collection: "knowledge__collection_create",
  create_document: "knowledge__document_create",
  get_document: "knowledge__document_get",
  update_document: "knowledge__document_update",
  search: "knowledge__documents_search",
  memory_recall: "knowledge__recall",
  memory_native_query: "knowledge__recall",
  buzz_send_message: "connect__buzz_post",
  buzz_read_messages: "connect__buzz_read",
};
/** v1 names with no opt2 agent tool, or a different contract: listed for review, never rewritten */
export const TOOL_REVIEW_NOTES: Readonly<Record<string, string>> = {
  delete_document: "no opt2 agent tool",
  buzz_list_members: "no opt2 tool (connect__buzz_channels lists channels only)",
  memory_native_query: "rewritten to knowledge__recall; engine-native query is knowledge__gb_query",
  buzz_send_message: "rewritten to connect__buzz_post; opt2 mentions go in the text (nostr:npub…)",
  buzz_read_messages: "rewritten to connect__buzz_read; it needs a channel",
};

/** effects of one v1 MCP server: `tools` as an array or an object keyed by tool name; `effects` as a string or a list */
export function serverEffects(server: unknown): string[] {
  const out: string[] = [];
  const add = (e: unknown) => {
    if (typeof e === "string") out.push(e);
    else if (Array.isArray(e)) for (const x of e) if (typeof x === "string") out.push(x);
  };
  if (!server || typeof server !== "object") return out;
  const sv = server as { effects?: unknown; tools?: unknown };
  add(sv.effects);
  const tools = sv.tools;
  const list = Array.isArray(tools) ? tools : tools && typeof tools === "object" ? Object.values(tools as Record<string, unknown>) : [];
  for (const t of list) if (t && typeof t === "object") add((t as { effects?: unknown }).effects);
  return out;
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One line rewritten per the rule above; returns the new line and the rewrites made. */
export function rewriteLine(line: string): { line: string; rewrites: string[] } {
  const rewrites: string[] = [];
  let out = line;
  for (const [from, to] of Object.entries(TOOL_REWRITES)) {
    const span = new RegExp(`\`${escapeRe(from)}\``, "g");
    const mcp = new RegExp(`\\bmcp__[A-Za-z0-9_-]+__${escapeRe(from)}\\b`, "g");
    if (span.test(out) || mcp.test(out)) {
      out = out.replace(new RegExp(`\`${escapeRe(from)}\``, "g"), `\`${to}\``).replace(new RegExp(`\\bmcp__[A-Za-z0-9_-]+__${escapeRe(from)}\\b`, "g"), to);
      rewrites.push(`${from} → ${to}${TOOL_REVIEW_NOTES[from] ? ` (${TOOL_REVIEW_NOTES[from]})` : ""}`);
    }
  }
  return { line: out, rewrites };
}
const REVIEW_LINE = /\bmcp__[a-z0-9_]+|\b(publish|send|post|email|tweet)\b|\bnpub1[0-9a-z]{20,}|\bsk-[A-Za-z0-9]/i;

export interface Detection {
  harness: { chosen: AdoptHarness | null; candidates: AdoptHarness[]; reason: string };
  modelAuth: { anthropicKeyEnv: boolean; openaiKeyEnv: boolean; claudeCli: boolean; claudeLoginFile: boolean; codexCli: boolean; codexLoginFile: boolean };
  persona: { files: string[]; skipped: { path: string; reason: string }[] };
  settings: { model?: string; effort?: string; maxTurns?: number; maxBudgetUsd?: number; timeoutSeconds?: number; unknown: string[] };
  builtinTools: { proposed: string[]; dropped: string[] };
  mcpServers: { name: string; reason: string }[];
  notCopied: { path: string; reason: string }[];
  memoryExport: string | null;
  v1: { dir: string; agentName: string | null; running: boolean | null } | null;
}

const isExecutableOnPath = async (env: Record<string, string | undefined>, name: string): Promise<boolean> => {
  for (const d of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      const s = await stat(join(d, name));
      if (s.isFile() && (s.mode & 0o111) !== 0) return true;
    } catch {
      /* not here */
    }
  }
  return false;
};

const insideHome = async (home: string, p: string): Promise<boolean> => {
  try {
    const real = await realpath(p);
    const h = await realpath(home);
    return real === h || real.startsWith(`${h}/`);
  } catch {
    return false;
  }
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Credential-like files under `dir` by NAME (depth ≤ 4); never opened. */
async function credentialNames(dir: string): Promise<{ path: string; reason: string }[]> {
  const out: { path: string; reason: string }[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > 4 || out.length > 200) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (CREDENTIAL_DIR.has(e.name)) out.push({ path: p, reason: e.name === ".tealbrick" ? "v1 identity/credential folder: only the serve config and pid files are read (F29)" : "credential/session folder (by name)" });
        // F42: older v1 identity folders (.tealbrick.pre-reenroll-<date>, .tealbrick-old …) are one entry, never read
        else if (/^\.tealbrick[.\-_]/.test(e.name)) out.push({ path: p, reason: "older v1 identity/credential folder (by name): not read" });
        else await walk(p, depth + 1);
      } else if (CREDENTIAL_NAME.some((r) => r.test(e.name))) out.push({ path: p, reason: "credential-like file (by name)" });
    }
  };
  await walk(dir, 0);
  return out;
}

/** §2 detect: read-only. Reads the v1 serve config and persona text; everything credential-like by NAME only. */
export async function detect(env: Record<string, string | undefined>, cwd: string, o: { harness?: string; fromV1?: string; persona?: string; personaAppend?: boolean }): Promise<Detection> {
  const home = env.HOME ?? "";
  const modelAuth = {
    anthropicKeyEnv: !!env.ANTHROPIC_API_KEY,
    openaiKeyEnv: !!env.OPENAI_API_KEY,
    claudeCli: await isExecutableOnPath(env, "claude"),
    claudeLoginFile: existsSync(join(home, ".claude", ".credentials.json")),
    codexCli: await isExecutableOnPath(env, "codex"),
    codexLoginFile: existsSync(join(home, ".codex", "auth.json")),
  };
  const d: Detection = {
    harness: { chosen: null, candidates: [], reason: "" },
    modelAuth,
    persona: { files: [], skipped: [] },
    settings: { unknown: [] },
    builtinTools: { proposed: [], dropped: [] },
    mcpServers: [],
    notCopied: [],
    memoryExport: null,
    v1: null,
  };
  if (o.fromV1) {
    const base = basename(o.fromV1) === ".tealbrick" ? dirname(o.fromV1) : o.fromV1;
    const servePath = join(base, ".tealbrick", "native-serve.json");
    if (!existsSync(servePath)) throw usageError(`--from-v1: no .tealbrick/native-serve.json under ${base}`);
    const cfg = JSON.parse(await readFile(servePath, "utf8")) as { agent?: { name?: unknown }; claude?: Record<string, unknown> };
    const c = cfg.claude ?? {};
    d.v1 = { dir: base, agentName: str(cfg.agent?.name) ?? null, running: null };
    // settings: inline (claude.*) or from the recipe (claude.recipe {path, agent})
    let s: Record<string, unknown> = c;
    const recipe = c.recipe as { path?: unknown; agent?: unknown } | undefined;
    if (recipe && typeof recipe.path === "string") {
      const rp = isAbsolute(recipe.path) ? recipe.path : resolve(dirname(servePath), recipe.path);
      if (existsSync(rp) && (await insideHome(home, rp))) {
        try {
          const r = JSON.parse(await readFile(rp, "utf8")) as Record<string, unknown>;
          const agents = (r.agents ?? r) as Record<string, unknown>;
          // F41: the top level holds the defaults (model/effort/maxTurns/maxBudgetUsd/timeoutSeconds…); the agent
          // block under agents.<name> overrides them; inline claude.* overrides both
          const { agents: _blocks, ...top } = r;
          const block = typeof recipe.agent === "string" && agents[recipe.agent] && typeof agents[recipe.agent] === "object" ? (agents[recipe.agent] as Record<string, unknown>) : {};
          s = { ...top, ...block, ...c };
        } catch {
          d.settings.unknown.push("recipe (not readable JSON)");
        }
      } else d.settings.unknown.push("recipe (missing or outside $HOME)");
    }
    // never crash on an unknown recipe shape (F28): each field is read on its own; a field that cannot be read is
    // reported ("could not read recipe: <field>") and adopt continues
    const field = (name: string, read: () => void) => {
      try {
        read();
      } catch {
        d.settings.unknown.push(`could not read recipe: ${name}`);
      }
    };
    d.settings.model = str(s.model);
    d.settings.effort = str(s.effort);
    d.settings.maxTurns = num(s.maxTurns);
    d.settings.maxBudgetUsd = num(s.maxBudgetUsd);
    d.settings.timeoutSeconds = num(s.timeoutSeconds);
    for (const k of Object.keys(s)) if (["tealbrickSdkConfig", "tealbrickCalls", "standingGrants", "contracts", "requireSubscription", "workspace"].includes(k)) d.settings.unknown.push(`${k} (v1-only; not carried over)`);
    field("defaultTools", () => {
      const tools = Array.isArray(s.defaultTools) ? s.defaultTools.filter((t): t is string => typeof t === "string") : [];
      d.builtinTools.proposed = tools.filter((t) => !DROPPED_BUILTINS.has(t));
      d.builtinTools.dropped = tools.filter((t) => DROPPED_BUILTINS.has(t));
    });
    const servers = s.mcpServers && typeof s.mcpServers === "object" && !Array.isArray(s.mcpServers) ? (s.mcpServers as Record<string, unknown>) : {};
    if (s.mcpServers !== undefined && servers !== s.mcpServers) d.settings.unknown.push("could not read recipe: mcpServers");
    for (const name of Object.keys(servers)) {
      let effects: string[] = [];
      field(`mcpServers.${name}`, () => {
        effects = serverEffects(servers[name]);
      });
      const outward = effects.some((e) => e === "outward" || e === "money");
      const writes = effects.some((e) => e === "write" || e === "writes");
      d.mcpServers.push({ name, reason: outward ? "has outward/money tools: use Teal Brick apps (grants, holds, Rules) instead" : `not carried over (${writes ? "writes" : "read-only"}): agent serve wires only Teal Brick` });
    }
    const instr = str(c.instructionsFile);
    if (instr) {
      const p = isAbsolute(instr) ? instr : resolve(base, instr);
      if (!existsSync(p)) d.persona.skipped.push({ path: p, reason: "instructions file missing" });
      else if (!(await insideHome(home, p))) d.persona.skipped.push({ path: p, reason: "outside $HOME (links are not followed)" });
      else d.persona.files.push(p);
    }
    d.notCopied.push(...(await credentialNames(base)));
    const exp = join(base, "work", "knowledge-export");
    if (existsSync(exp)) d.memoryExport = exp;
    // is the v1 agent running? only its own pid files, existence check only (never a signal)
    for (const n of ["native-serve.pid", "serve.pid", "agent.pid"]) {
      const pf = join(base, ".tealbrick", n);
      if (!existsSync(pf)) continue;
      const pid = Number((await readFile(pf, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          d.v1.running = true;
        } catch (e) {
          d.v1.running = (e as NodeJS.ErrnoException).code === "EPERM";
        }
      }
    }
  }
  if (o.persona) {
    const p = resolve(cwd, o.persona);
    if (!existsSync(p)) throw usageError(`--persona: ${p} does not exist`);
    if (!(await insideHome(home, p))) throw usageError("--persona must be under $HOME (links are not followed)");
    // F61: --persona IS the persona; the detected instructions are kept only with --persona-append
    if (!o.personaAppend) {
      for (const f of d.persona.files) d.persona.skipped.push({ path: f, reason: "replaced by --persona (add --persona-append to keep it)" });
      d.persona.files = [];
    }
    d.persona.files.push(p);
  } else if (o.personaAppend) {
    throw usageError("--persona-append needs --persona <file>");
  } else if (!o.fromV1) {
    for (const n of ["CLAUDE.md", "AGENTS.md"]) if (existsSync(join(cwd, n))) d.persona.files.push(join(cwd, n));
  }
  // harness
  if (o.harness && o.harness !== "auto") {
    if (!(ADOPT_HARNESSES as readonly string[]).includes(o.harness)) throw usageError(`--harness must be auto or one of ${ADOPT_HARNESSES.join(", ")}`);
    d.harness = { chosen: o.harness as AdoptHarness, candidates: [o.harness as AdoptHarness], reason: "--harness" };
  } else if (o.fromV1) d.harness = { chosen: "claude-sdk", candidates: ["claude-sdk"], reason: "v1 agent (Claude Agent SDK)" };
  else {
    const c: AdoptHarness[] = [];
    if (existsSync(join(home, ".codex", "config.toml"))) c.push("codex");
    if (existsSync(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")) || existsSync(join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json"))) c.push("claude-desktop");
    if (modelAuth.claudeCli) c.push("claude-code");
    d.harness = c.length === 1 ? { chosen: c[0] as AdoptHarness, candidates: c, reason: "detected" } : { chosen: null, candidates: c, reason: c.length ? "several harnesses found: pass --harness" : "no harness found: pass --harness" };
  }
  return d;
}

export interface AdoptPlan {
  name: string;
  purpose: string | null;
  harness: AdoptHarness;
  detection: Detection;
  serve: boolean;
  wake: "mentions" | "all";
  /** F30: Buzz channel ids to listen on (connect__buzz_read) */
  buzzChannels: string[];
}

/** §3: the one-screen plan (names and paths only). */
export function planText(p: AdoptPlan, files: string[]): string {
  const d = p.detection;
  const auth = Object.entries(d.modelAuth)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");
  const lines = [
    `Adopt plan for "${p.name}"${p.purpose ? ` — ${p.purpose}` : ""}`,
    `  harness        ${p.harness} (${d.harness.reason})`,
    `  model auth     ${auth || "NONE FOUND — set ANTHROPIC_API_KEY or sign in to the harness first"}`,
    `  persona        ${d.persona.files.length ? d.persona.files.join(", ") : "none"}`,
    ...d.persona.skipped.map((x) => `  persona skip   ${x.path} (${x.reason})`),
    ...(d.settings.model || d.settings.maxTurns ? [`  settings       ${[d.settings.model && `model ${d.settings.model}`, d.settings.effort && `effort ${d.settings.effort}`, d.settings.maxTurns && `maxTurns ${d.settings.maxTurns}`, d.settings.maxBudgetUsd && `budget $${d.settings.maxBudgetUsd}`, d.settings.timeoutSeconds && `timeout ${d.settings.timeoutSeconds}s`].filter(Boolean).join(", ")}`] : []),
    ...(d.builtinTools.proposed.length || d.builtinTools.dropped.length ? [`  built-in tools ${d.builtinTools.proposed.join(", ") || "none"}${d.builtinTools.dropped.length ? ` (dropped: ${d.builtinTools.dropped.join(", ")})` : ""}`] : []),
    ...d.mcpServers.map((m) => `  MCP not wired  ${m.name}: ${m.reason}`),
    `  connection     one owner approval in Portal (device flow); card "${p.name}"`,
    `  inbox          ${p.serve ? `${p.buzzChannels.length ? `Buzz ${p.buzzChannels.join(", ")}` : "auto: the Buzz channel you choose at approval, else Buzz DMs, else the chat-bot inbox (or --inbox buzz:<channel>)"}, wake: ${p.wake}` : "none (this harness runs itself)"}`,
    `  files to write ${files.join(", ") || "none"} (each existing file is backed up first)`,
    ...d.notCopied.slice(0, 20).map((x) => `  not copied     ${x.path} (${x.reason})`),
    ...(d.notCopied.length > 20 ? [`  not copied     … ${d.notCopied.length - 20} more`] : []),
    ...d.settings.unknown.map((u) => `  not carried    ${u}`),
    ...(d.memoryExport ? [`  memory export  ${d.memoryExport} found: NOT imported (owner decision, later)`] : []),
    ...(d.v1?.running ? ["  v1 agent       still running: adopt does not stop it (stop it yourself when the new agent works)"] : []),
  ];
  return lines.join("\n");
}

// ── state (§10) ──
export interface AdoptState {
  v: 1;
  name: string;
  harness: AdoptHarness;
  agt: string;
  con: string;
  wired: { target: string; backup: string | null; created: boolean; digest: string }[];
  persona: { path: string; digest: string } | null;
  serve: { path: string; digest: string } | null;
  createdAt: string;
  updatedAt: string;
}

const digestOf = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const adoptRoot = (ctx: Ctx) => join(ctx.configDir(), "adopt");

async function findState(ctx: Ctx, name: string | undefined, harness: string | undefined, agt?: string): Promise<{ dir: string; state: AdoptState } | null> {
  let names: string[];
  try {
    names = await readdir(adoptRoot(ctx));
  } catch {
    return null;
  }
  for (const n of names) {
    const p = join(adoptRoot(ctx), n, "adopt.json");
    if (!existsSync(p)) continue;
    const s = JSON.parse(await readFile(p, "utf8")) as AdoptState;
    if ((agt && s.agt === agt) || (!agt && s.name === name && (!harness || harness === "auto" || s.harness === harness))) return { dir: join(adoptRoot(ctx), n), state: s };
  }
  return null;
}

async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

/** §6 persona: one file under the adopt dir, with a header and the v1 → opt2 rewrites; risky lines listed for review. */
export async function buildPersona(files: string[], plan: Pick<AdoptPlan, "name" | "wake">): Promise<{ text: string; review: string[] }> {
  const parts: string[] = [];
  const review: string[] = [];
  const reviewOnly = Object.keys(TOOL_REVIEW_NOTES).filter((k) => !(k in TOOL_REWRITES));
  for (const f of files) {
    const lines = (await readFile(f, "utf8")).split("\n");
    const outLines = lines.map((line, i) => {
      const r = rewriteLine(line);
      const where = `${basename(f)}:${i + 1}`;
      for (const w of r.rewrites) review.push(`${where}: rewrote ${w}`);
      const missing = reviewOnly.filter((k) => new RegExp(`\\b${k}\\b`).test(r.line));
      if (missing.length) review.push(`${where}: ${missing.map((k) => `${k} (${TOOL_REVIEW_NOTES[k]})`).join("; ")}: ${r.line.trim().slice(0, 120)}`);
      else if (!r.rewrites.length && REVIEW_LINE.test(r.line)) review.push(`${where}: ${r.line.trim().slice(0, 160)}`);
      return r.line;
    });
    parts.push(outLines.join("\n").trim());
  }
  const header = [
    `<!-- adopted by tealbrick adopt for "${plan.name}" -->`,
    "You act through Teal Brick tools only. Outward actions (messages, posts, payments) go through Teal Brick apps, where the owner's grants and holds apply.",
    `You are woken by ${plan.wake === "mentions" ? "direct messages and mentions" : "every channel message"} in your Teal Brick inbox.`,
  ].join("\n");
  return { text: `${header}\n\n${parts.join("\n\n---\n\n")}\n`, review };
}

/** Writes `text` to `path` only when it changed; an existing file is backed up first. */
async function writeIfChanged(ctx: Ctx, path: string, text: string): Promise<{ changed: boolean; backup: string | null; created: boolean }> {
  const old = await readExisting(path);
  if (old === text) return { changed: false, backup: null, created: false };
  const backup = await writeAtomic(ctx, path, old, text);
  return { changed: true, backup, created: old === null };
}

/**
 * F32: Teal Brick entries that already exist in the harness config — NAME, the card id when the entry names one
 * (`--agent agt_…` in a stdio entry), and whether it is a remote (URL/OAuth) entry. No other value is kept.
 */
export interface ExistingEntry {
  name: string;
  agt: string | null;
  remote: boolean;
}

export async function existingTealbrickEntries(harness: AdoptHarness, target: string): Promise<ExistingEntry[]> {
  const text = await readExisting(target);
  if (text === null) return [];
  const out: ExistingEntry[] = [];
  const agtOf = (s: string) => /--agent["',\s=]+(agt_[0-9A-HJKMNP-TV-Z]{26})/.exec(s)?.[1] ?? null;
  if (harness === "codex") {
    for (const m of text.matchAll(/^\s*\[mcp_servers\.("?)([^\]"]+)\1\]\s*$/gm)) {
      const name = m[2] as string;
      const start = (m.index ?? 0) + m[0].length;
      const next = text.slice(start).search(/^\s*\[/m);
      const body = text.slice(start, next < 0 ? undefined : start + next);
      if (/tealbrick/i.test(name) || /tealbrick|\/mcp\b.*bridge|bridge.*\/mcp\b/i.test(body)) out.push({ name, agt: agtOf(body), remote: /^\s*url\s*=/m.test(body) });
    }
  } else {
    try {
      const servers = (JSON.parse(text) as { mcpServers?: Record<string, { command?: unknown; args?: unknown; url?: unknown }> }).mcpServers ?? {};
      for (const [name, v] of Object.entries(servers)) {
        const flat = JSON.stringify([v?.command, v?.args, v?.url]);
        if (/tealbrick/i.test(name) || /tealbrick/i.test(flat)) out.push({ name, agt: agtOf(flat), remote: typeof v?.url === "string" });
      }
    } catch {
      /* not JSON: the wiring step reports it */
    }
  }
  return out;
}

async function askLine(ctx: Ctx, question: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  ctx.io.stderr.write(question);
  const rl = createInterface({ input: ctx.io.stdin as unknown as NodeJS.ReadableStream, terminal: false });
  const answer = await new Promise<string>((res) => {
    rl.once("line", res);
    rl.once("close", () => res(""));
  });
  rl.close();
  return answer.trim();
}

/** F46: Teal Brick product ids and the product NAMES that mean them in prose (case-sensitive, whole words) */
const PRODUCT_IDS = ["connect", "evolution", "fleet", "inbox", "kanban", "knowledge", "rules"];
const PRODUCT_NAMES: Readonly<Record<string, string>> = { Knowledge: "knowledge", Kanban: "kanban", Connect: "connect", Buzz: "connect", Evolution: "evolution" };

/**
 * F46: the Teal Brick products the persona refers to, in any form: `<product>__<op>` (after the rewrites),
 * `mcp__<product>__…` or `mcp__tealbrick__<product>__…` (v1 names), or the product's name in prose ("Kanban").
 * Unknown v1 servers (`mcp__mail__send`) never become a product.
 */
export async function referencedProducts(files: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const f of files) {
    for (const raw of (await readFile(f, "utf8")).split("\n")) {
      const line = rewriteLine(raw).line;
      for (const m of line.matchAll(/\bmcp__([A-Za-z0-9_-]+)/g)) {
        const parts = (m[1] as string).split("__");
        const product = parts[0] === "tealbrick" ? parts[1] : parts[0];
        if (product && PRODUCT_IDS.includes(product)) out.add(product);
      }
      const plain = line.replace(/\bmcp__[A-Za-z0-9_-]+/g, " ");
      for (const m of plain.matchAll(/\b([a-z][a-z0-9-]{1,31})__[a-z][a-z0-9_]{1,63}\b/g)) out.add(m[1] as string);
      for (const [name, product] of Object.entries(PRODUCT_NAMES)) if (new RegExp(`\\b${name}\\b`).test(plain)) out.add(product);
    }
  }
  return [...out].sort();
}

/**
 * C106a/F46: the grant SUGGESTION sent with the device request — read for every Teal Brick product the persona refers
 * to (Connect always when serving, for its inbox). It never names write ops: Core lists every deployed app and its
 * manifest ops on the approval page, and the owner ticks writes there.
 */
export function adoptSuggestion(products: string[], plan: Pick<AdoptPlan, "serve" | "buzzChannels">): AdoptSuggestion {
  const all = new Set(products);
  if (plan.serve) all.add("connect");
  const grants = [...all].sort().slice(0, 16).map((product) => ({ product, crud: ["read" as const] }));
  return {
    grants,
    // F35: the owner picks (or creates) the Buzz channel in the approval form when none is named
    ...(plan.buzzChannels.length ? { channel: { kind: "buzz_channel" as const, id: plan.buzzChannels[0] as string } } : plan.serve ? { channel: { kind: "buzz_channel" as const } } : {}),
    wake: plan.serve ? "serve" : "none",
  };
}

/** F44: is `agent serve` running for this connection (own pidfile), and when did it last poll? */
async function serveRunning(ctx: Ctx, con: string): Promise<{ pid: number; lastPollAt: string | null } | null> {
  const held = await readPid(pidPath(ctx.configDir(), con));
  if (!held || !isAlive(held.pid)) return null;
  const hb = await readHeartbeat(heartbeatPath(ctx.configDir(), con));
  return { pid: held.pid, lastPollAt: hb?.lastPollAt ?? null };
}

/** `tealbrick adopt` */
export const adopt: Handler = async (ctx) => {
  if (ctx.v.undo === true) return adoptUndo(ctx);
  const home = ctx.io.env.HOME ?? "";
  if (!home) throw usageError("HOME is not set");
  const d = await detect(ctx.io.env, ctx.cwd(), { ...(ctx.v.harness ? { harness: String(ctx.v.harness) } : {}), ...(ctx.v["from-v1"] ? { fromV1: resolve(ctx.cwd(), String(ctx.v["from-v1"])) } : {}), ...(ctx.v.persona ? { persona: String(ctx.v.persona) } : {}), ...(ctx.v["persona-append"] === true ? { personaAppend: true } : {}) });
  if (!d.harness.chosen) {
    const why: Record<string, string> = { codex: "~/.codex/config.toml found", "claude-desktop": "Claude Desktop config found", "claude-code": "`claude` on PATH" };
    const choices: AdoptHarness[] = [...d.harness.candidates, ...(d.harness.candidates.includes("claude-sdk") ? [] : (["claude-sdk"] as AdoptHarness[]))];
    // F31: in a terminal, ask; otherwise refuse with one line per choice
    if (ctx.io.stdin.isTTY === true && ctx.g.yes !== true && !ctx.g.json) {
      ctx.say([d.harness.reason.replace(": pass --harness", ""), ...choices.map((c, i) => `  ${i + 1}) ${c.padEnd(14)} ${why[c] ?? "a Claude Agent SDK agent (tealbrick agent serve)"}`)].join("\n"));
      const pick = await askLine(ctx, `Which harness? [1-${choices.length}] `);
      const n = Number(pick);
      if (!Number.isInteger(n) || n < 1 || n > choices.length) throw usageError("no harness chosen");
      d.harness = { chosen: choices[n - 1] as AdoptHarness, candidates: choices, reason: "chosen in the terminal" };
    } else throw usageError([d.harness.reason, ...choices.map((c) => `  --harness ${c.padEnd(14)} ${why[c] ?? "a Claude Agent SDK agent (tealbrick agent serve)"}`)].join("\n"));
  }
  if (!d.harness.chosen) throw usageError("no harness chosen");
  const harness = d.harness.chosen;
  const name = String(ctx.v.name ?? d.v1?.agentName ?? "").trim();
  if (!name) throw usageError("pass --name <card name> (no v1 agent name found)");
  const wake = ctx.v.wake === "all" ? "all" : "mentions";
  if (ctx.v.wake !== undefined && ctx.v.wake !== "all" && ctx.v.wake !== "mentions") throw usageError("--wake must be mentions or all");
  const serveDefault = harness === "claude-sdk";
  const serve = ctx.v["no-serve"] === true ? false : ctx.v.serve === true ? true : serveDefault;
  if (serve && harness !== "claude-sdk") throw usageError("--serve (agent serve config) is for the claude-sdk harness in phase 1; other harnesses run themselves");
  // F30: Buzz inboxes in addition to (or instead of) Connect's bot channel inbox
  const buzzChannels = String(ctx.v.inbox ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^buzz:([A-Za-z0-9_-]{1,128})$/.exec(x);
      if (!m) throw usageError(`--inbox takes buzz:<channel id> (comma-separated): ${x}`);
      return m[1] as string;
    });
  const plan: AdoptPlan = { name, purpose: ctx.v.purpose ? String(ctx.v.purpose) : null, harness, detection: d, serve, wake, buzzChannels };
  const prior = await findState(ctx, name, harness);
  // F32: the target config and the Teal Brick entries it already has. One existing entry → adopt REUSES it: the same
  // entry name and, when known, the same card (no second entry, no second card).
  const target = harness === "codex" ? join(home, ".codex", "config.toml") : harness === "claude-desktop" ? desktopConfigPath(ctx) : null;
  const existing = target ? await existingTealbrickEntries(harness, target) : [];
  const reuse = existing.length === 1 ? existing[0] : undefined;
  const entryName = reuse?.name ?? "tealbrick";
  const reuseCard = prior?.state.agt ?? ctx.g.agent ?? reuse?.agt ?? null;
  const dirFor = (agt: string) => join(adoptRoot(ctx), agt);
  // F47: REUSE keeps the existing entry's transport; a remote (URL/OAuth) entry becomes the local stdio relay ONLY with
  // --switch-to-stdio (that ends the harness's own OAuth login for the entry)
  const switchToStdio = ctx.v["switch-to-stdio"] === true;
  const keepRemote = !!reuse?.remote && !switchToStdio;
  const wires = (harness === "claude-code" || harness === "claude-desktop" || harness === "codex") && !keepRemote;
  const planned = [...(serve ? ["<adopt>/serve.json"] : []), ...(d.persona.files.length ? ["<adopt>/persona/persona.md"] : []), ...(wires ? [`${target ?? `${harness} MCP config`} (entry "${entryName}")`] : [])];
  const transport = (e: ExistingEntry) => (e.remote ? (switchToStdio ? "remote/OAuth → switched to the local stdio relay (--switch-to-stdio)" : "kept: remote OAuth (pass --switch-to-stdio to use the local relay)") : "kept: local stdio relay");
  const existingLines = existing.map((e) => `  EXISTING       ${target}: Teal Brick entry "${e.name}" (${e.remote ? "remote/OAuth" : "local relay"}${e.agt ? `, card ${e.agt}` : ""})${reuse ? ` → adopt REUSES it${reuseCard ? ` and card ${reuseCard}` : " (card unknown: pass --agent <agt_…> to keep the same card)"}; ${transport(e)}` : ""}`);
  if (existing.length > 1) existingLines.push(`  CHOOSE         several Teal Brick entries: remove the ones you do not need, or pass --keep-existing to add "tealbrick" next to them`);
  // F46: the grant suggestion (products the persona refers to; read only — the owner ticks writes in Portal)
  const suggestion = adoptSuggestion(await referencedProducts(d.persona.files), plan);
  const suggestLines = [`  access asked   read: ${suggestion.grants.map((g) => g.product).join(", ") || "none"} (Portal lists every deployed app; you tick any write access there)`];
  const text = [planText(plan, planned), ...suggestLines, ...existingLines].join("\n");

  if (ctx.v["dry-run"] === true) {
    // F43: the persona is built in memory, so the rewrite and review lists show before anything is written
    const preview = d.persona.files.length ? await buildPersona(d.persona.files, plan) : { review: [] as string[] };
    const reviewText = preview.review.length ? ["", "persona rewrites and lines to review:", ...preview.review.map((l) => `  ${l}`)] : [];
    ctx.emit(
      { dryRun: true, plan: { ...plan, files: planned }, existing: prior ? { agent: prior.state.agt, connection: prior.state.con } : null, existingEntries: existing, target, entry: entryName, card: reuseCard, transport: reuse ? (keepRemote ? "remote" : "stdio") : null, suggestion, personaReview: preview.review },
      `${text}${reviewText.length ? `\n${reviewText.join("\n")}` : ""}\n\n--dry-run: nothing was written.`,
    );
    return;
  }
  ctx.say(text);
  if (existing.length > 1 && ctx.v["keep-existing"] !== true) throw new CliError(EXIT.validation, "existing_entry", `${target} has several Teal Brick entries (${existing.map((e) => e.name).join(", ")}); remove the ones you do not need or pass --keep-existing`);
  if (reuse && !reuseCard && ctx.v["keep-existing"] !== true) throw new CliError(EXIT.validation, "existing_entry", `${target} has the Teal Brick entry "${reuse.name}" for a card adopt cannot see; pass --agent <agt_…> (owner: tealbrick agents export) to keep that card, or --keep-existing for a new card`);
  if (ctx.v.yes !== true && !(await confirm(ctx, "Go ahead? This asks the owner for ONE approval in Portal."))) throw new CliError(EXIT.usage, "cancelled", "adopt cancelled; nothing was written");

  // §10 / §4: re-use a valid connection; otherwise ONE device flow for the card (same card id on a re-run)
  let item = prior ? await pickAgentItem(ctx.store(), prior.state.con).catch(() => null) : null;
  // F40: "reused" means the CONNECTION was reused (no device flow), not that adopt ran before
  const connectionReused = !!item;
  if (!item) {
    const captured: { connections?: { con: string; agt: string }[] }[] = [];
    const card = ctx.v["keep-existing"] === true && !prior && !ctx.g.agent ? null : reuseCard;
    const sub: Ctx = { ...ctx, v: { ...ctx.v, ...(card ? {} : { create: true }), name, ...(plan.purpose ? { purpose: plan.purpose } : {}) }, g: { ...ctx.g, agents: card ? [card] : [], agent: card ?? undefined }, emit: (r) => void captured.push(r as never) };
    if (card) delete (sub.v as Record<string, unknown>).create;
    await agentLogin(sub, { adopt: suggestion });
    const con = captured.flatMap((c) => c.connections ?? [])[0]?.con;
    if (!con) throw new CliError(EXIT.unexpected, "internal", "the device flow returned no connection");
    item = await pickAgentItem(ctx.store(), con);
  }
  const adir = dirFor(item.agt);
  const state: AdoptState = prior?.state ?? { v: 1, name, harness, agt: item.agt, con: item.con, wired: [], persona: null, serve: null, createdAt: new Date(ctx.now()).toISOString(), updatedAt: "" };
  state.con = item.con;
  const changes: string[] = [];

  // §6 persona
  let personaReview: string[] = [];
  if (d.persona.files.length) {
    const persona = await buildPersona(d.persona.files, plan);
    personaReview = persona.review;
    const path = join(adir, "persona", "persona.md");
    if (state.persona?.digest !== digestOf(persona.text) || !existsSync(path)) {
      await writePrivate(path, persona.text);
      changes.push(path);
    }
    state.persona = { path, digest: digestOf(persona.text) };
  }

  // §5 wire MCP (one "tealbrick" entry; backup first; unchanged → no write)
  if (wires) {
    const sub: Ctx = { ...ctx, v: { ...ctx.v, local: true, remote: undefined }, g: { ...ctx.g, agent: item.agt, agents: [item.agt] } };
    const cp = await planConnect(sub, harness);
    if (!cp.target) throw new CliError(EXIT.unexpected, "internal", `no config path for ${harness}`);
    const old = await readExisting(cp.target);
    const name2 = ctx.v["keep-existing"] === true && existing.length > 1 ? "tealbrick" : entryName;
    const next = cp.toml ? mergeTomlConfig(old, cp.toml, cp.target, name2) : mergeJsonConfig(old, cp.entry as Record<string, unknown>, cp.target, name2);
    const w = await writeIfChanged(ctx, cp.target, next);
    const known = state.wired.find((x) => x.target === cp.target);
    if (w.changed) {
      changes.push(cp.target);
      if (known) known.digest = digestOf(next);
      else state.wired.push({ target: cp.target, backup: w.backup, created: w.created, digest: digestOf(next) });
    }
  }

  // §8 serve config (claude-sdk): persona by file, v1 settings mapped, wake
  if (serve) {
    const harnessCfg: Record<string, unknown> = {
      kind: "claude",
      // F45: the harness works in <adopt dir>/work (0700), never in the shell's cwd
      cwd: "work",
      // F48: no SDK transcript under ~/.claude/projects/; turns are logged inside the adopt dir instead
      transcripts: "transcripts",
      modelKeyEnv: "ANTHROPIC_API_KEY",
      ...(state.persona ? { appendSystemPromptFile: relative(adir, state.persona.path) } : {}),
      ...(d.settings.model ? { model: d.settings.model } : {}),
      ...(d.settings.effort && ["low", "medium", "high", "xhigh", "max"].includes(d.settings.effort) ? { effort: d.settings.effort } : {}),
      ...(d.settings.maxTurns ? { maxTurns: d.settings.maxTurns } : {}),
      ...(d.settings.maxBudgetUsd ? { maxBudgetUsd: d.settings.maxBudgetUsd } : {}),
      ...(d.settings.timeoutSeconds && d.settings.timeoutSeconds >= 10 ? { turnTimeoutSeconds: Math.min(d.settings.timeoutSeconds, 86_400) } : {}),
      ...(d.builtinTools.proposed.length ? { builtinTools: d.builtinTools.proposed } : {}),
    };
    // F35: with --inbox buzz:<ch> the agent listens there; otherwise the serve-time auto inbox (joined Buzz channel →
    // Buzz DMs → the bot channel inbox only when a chat bot exists), re-resolved while serve runs
    const inboxes = [
      ...(plan.buzzChannels.length ? [] : [{ auto: "connect", wake }]),
      ...plan.buzzChannels.map((channel) => ({ tool: "connect__buzz_read", args: { channel }, cursor: { param: "since", from: "max:createdAt" }, items: "messages", id: "id", skipIf: { fromSelf: true }, wake })),
    ];
    const cfg = { format: "tealbrick.agent-serve/1", harness: harnessCfg, pollSeconds: 30, holds: true, inboxes };
    await mkdir(join(adir, "work"), { recursive: true, mode: 0o700 });
    await chmod(join(adir, "work"), 0o700);
    const text2 = `${JSON.stringify(cfg, null, 2)}\n`;
    const path = join(adir, "serve.json");
    if (state.serve?.digest !== digestOf(text2) || !existsSync(path)) {
      await writePrivate(path, text2);
      changes.push(path);
    }
    state.serve = { path, digest: digestOf(text2) };
  }

  // a no-op re-run writes nothing (not even a new timestamp)
  const statePath = join(adir, "adopt.json");
  const before = await readExisting(statePath);
  const { updatedAt: _u, ...stable } = state;
  const prevStable = before ? (({ updatedAt: _p, ...rest }) => rest)(JSON.parse(before) as AdoptState) : null;
  if (!prevStable || JSON.stringify(prevStable) !== JSON.stringify(stable)) {
    state.updatedAt = new Date(ctx.now()).toISOString();
    await writePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
    if (before !== null) changes.push(statePath);
  }

  // F33: --start runs `agent serve --supervise` in the background (log next to the config); the connection's pidfile
  // keeps it to one loop
  let started: { pid: number | null; log: string } | null = null;
  if (ctx.v.start === true && state.serve) {
    const held = await readPid(pidPath(ctx.configDir(), state.con));
    if (!held || !isAlive(held.pid)) started = await startDetached(ctx, { file: state.serve.path, agt: item.agt, con: item.con, log: join(adir, "serve.log"), cwd: adir });
  }

  // §9 verify (reads only; writes need the owner's write grant)
  const probe = await probeAgent(ctx, item);
  const running = started ? null : await serveRunning(ctx, item.con);
  const serveCmd = state.serve ? `tealbrick agent serve --file ${state.serve.path} --agent ${item.agt} --supervise` : null;
  const report = {
    agent: item.agt,
    connection: item.con,
    harness,
    reused: connectionReused,
    sameCard: !!prior,
    probe,
    toolsReady: (probe.tools ?? 0) > 0,
    changed: changes,
    backups: state.wired.filter((x) => x.backup).map((x) => x.backup),
    personaReview,
    serve: serveCmd,
    started,
    running,
    notCopied: d.notCopied.map((x) => x.path),
  };
  ctx.emit(
    report,
    [
      `adopted ${item.agt} (${item.con}) — ${connectionReused ? "connection reused" : prior ? "same card, NEW connection" : "new card and connection"}`,
      `bridge ${probe.state}, tools ${probe.tools ?? "-"}${probe.tools === 0 ? " — NO TOOLS: the approval granted no operations (owner: tick the grants on the card)" : ""}`,
      changes.length ? `changed: ${changes.join(", ")}` : "nothing changed (already adopted)",
      ...(report.backups.length ? [`backups: ${report.backups.join(", ")}`] : []),
      ...(personaReview.length ? ["review these persona lines (tool or channel references):", ...personaReview.map((l) => `  ${l}`)] : []),
      ...(started ? [`started agent serve (supervisor pid ${started.pid ?? "?"}), log ${started.log}`] : running ? [`serve running (supervisor pid ${running.pid}, last poll ${running.lastPollAt ?? "never"})`] : serveCmd ? [`run: ${serveCmd}  (or re-run adopt with --start)`] : []),
      "test: ask the owner to send the agent a message in the Teal Brick inbox; writes need the owner's write grant.",
    ].join("\n"),
  );
};

/** §10 --undo: own pidfile only (L20), restore backups, revoke the own connection at the bridge (F39), remove the local key. */
async function adoptUndo(ctx: Ctx): Promise<void> {
  const found = await findState(ctx, ctx.v.name ? String(ctx.v.name) : undefined, ctx.v.harness ? String(ctx.v.harness) : undefined, ctx.g.agent);
  if (!found) throw usageError("nothing to undo: pass --name or --agent of an adopted agent");
  const { dir, state } = found;
  const done: string[] = [];
  const left: string[] = [];
  // stop the serve loop of THIS connection via its own pidfile (never by name)
  const pf = pidPath(ctx.configDir(), state.con);
  const stop = await stopLoop({ pidfile: pf, heartbeat: heartbeatPath(ctx.configDir(), state.con), nowMs: ctx.now() });
  if (stop.stopped) done.push(`stopped agent serve (pid ${stop.stopped})`);
  if (stop.left) left.push(stop.left);
  for (const w of state.wired) {
    const now = await readExisting(w.target);
    const unchanged = now !== null && digestOf(now) === w.digest;
    if (w.backup && existsSync(w.backup) && unchanged) {
      await copyFile(w.backup, w.target);
      done.push(`restored ${w.target} from ${w.backup}`);
    } else if (w.created && unchanged) {
      await rm(w.target, { force: true });
      done.push(`removed ${w.target} (adopt created it)`);
    } else left.push(`${w.target}: changed since adopt; remove the "tealbrick" entry yourself`);
  }
  if (state.serve) await rm(state.serve.path, { force: true });
  // F39: the agent revokes its OWN connection with its own key, BEFORE the key is deleted (bridge ≥ 0.1.18)
  const item = await pickAgentItem(ctx.store(), state.con).catch(() => null);
  const revoked = item ? await selfRevoke(ctx, item) : ({ ok: false, reason: "the local key is already gone" } as const);
  if (revoked.ok) done.push(`revoked connection ${state.con} at the bridge${revoked.already ? " (it was already revoked)" : ""}; Portal lists it revoked with the next config`);
  else left.push(`revoke of ${state.con} failed: ${revoked.reason}`);
  await ctx.store().delete(`${AGENT_ITEM_PREFIX}${state.con}`);
  done.push(`deleted the local key of ${state.con}`);
  if (ctx.v.purge === true) {
    const st = await lstat(dir).catch(() => null);
    if (st?.isDirectory()) await rm(dir, { recursive: true, force: true });
    done.push(`removed ${dir}`);
  } else {
    state.wired = [];
    state.serve = null;
    await writePrivate(join(dir, "adopt.json"), `${JSON.stringify({ ...state, undone: new Date(ctx.now()).toISOString() }, null, 2)}\n`);
  }
  // the owner step only when the self-revoke failed (the connection stays valid on the server until then)
  const ownerStep = revoked.ok ? [] : [`Owner: revoke connection ${state.con} of agent ${state.agt} in Portal → the agent card → Connections (the local key is gone; the server connection stays valid until then).`];
  ctx.emit({ undone: state.agt, connection: state.con, revoked: revoked.ok, revokeNeeded: !revoked.ok, done, left }, [...done, ...left.map((l) => `left: ${l}`), ...ownerStep].join("\n"));
}

