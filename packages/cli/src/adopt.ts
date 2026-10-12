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
import { confirm, mergeJsonConfig, mergeTomlConfig, planConnect, readExisting, writeAtomic } from "./connect.ts";
import type { Ctx, Handler } from "./ctx.ts";
import { CliError, EXIT, usageError } from "./io.ts";
import { agentLogin, probeAgent } from "./lead.ts";
import { pickAgentItem } from "./relay-main.ts";
import { AGENT_ITEM_PREFIX } from "./store.ts";
import { heartbeatPath, pidPath, readHeartbeat, readPid } from "./supervise.ts";

export const ADOPT_HARNESSES = ["claude-sdk", "claude-code", "claude-desktop", "codex", "command"] as const;
export type AdoptHarness = (typeof ADOPT_HARNESSES)[number];

/** credential-like by NAME (§2, F3): never opened, never copied, only listed */
const CREDENTIAL_NAME = [/\.key$/i, /credentials/i, /-url\.txt$/i, /^portal-grants\.json$/i, /\.pem$/i, /^\.env/i, /token/i, /secret/i];
const CREDENTIAL_DIR = new Set([".tealbrick", "traces", "sessions"]);
/** v1 built-ins that a Teal Brick agent must not get by default (shell, sub-agents) (§6, F8) */
const DROPPED_BUILTINS = new Set(["Bash", "BashOutput", "KillShell", "KillBash", "Agent", "Task", "NotebookEdit"]);
/** §6: known v1 → opt2 tool names (extend as the mapping is confirmed; unknown references go to the review list) */
export const TOOL_REWRITES: Readonly<Record<string, string>> = {};
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
        if (CREDENTIAL_DIR.has(e.name)) out.push({ path: p, reason: "credential/session folder (by name)" });
        else await walk(p, depth + 1);
      } else if (CREDENTIAL_NAME.some((r) => r.test(e.name))) out.push({ path: p, reason: "credential-like file (by name)" });
    }
  };
  await walk(dir, 0);
  return out;
}

/** §2 detect: read-only. Reads the v1 serve config and persona text; everything credential-like by NAME only. */
export async function detect(env: Record<string, string | undefined>, cwd: string, o: { harness?: string; fromV1?: string; persona?: string }): Promise<Detection> {
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
          s = { ...(typeof recipe.agent === "string" && typeof agents[recipe.agent] === "object" ? (agents[recipe.agent] as Record<string, unknown>) : r), ...c };
        } catch {
          d.settings.unknown.push("recipe (not readable JSON)");
        }
      } else d.settings.unknown.push("recipe (missing or outside $HOME)");
    }
    d.settings.model = str(s.model);
    d.settings.effort = str(s.effort);
    d.settings.maxTurns = num(s.maxTurns);
    d.settings.maxBudgetUsd = num(s.maxBudgetUsd);
    d.settings.timeoutSeconds = num(s.timeoutSeconds);
    for (const k of Object.keys(s)) if (["tealbrickSdkConfig", "tealbrickCalls", "standingGrants", "contracts", "requireSubscription", "workspace"].includes(k)) d.settings.unknown.push(`${k} (v1-only; not carried over)`);
    const tools = Array.isArray(s.defaultTools) ? s.defaultTools.filter((t): t is string => typeof t === "string") : [];
    d.builtinTools.proposed = tools.filter((t) => !DROPPED_BUILTINS.has(t));
    d.builtinTools.dropped = tools.filter((t) => DROPPED_BUILTINS.has(t));
    for (const name of Object.keys((s.mcpServers as Record<string, unknown>) ?? {})) {
      const t = (s.mcpServers as Record<string, { tools?: { effects?: string[] }[]; effects?: string[] }>)[name];
      const effects = [...(t?.effects ?? []), ...(t?.tools ?? []).flatMap((x) => x.effects ?? [])];
      const outward = effects.some((e) => e === "outward" || e === "money");
      d.mcpServers.push({ name, reason: outward ? "has outward/money tools: use Teal Brick apps (grants, holds, Rules) instead" : "not carried over: agent serve wires only Teal Brick" });
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
    d.persona.files.push(p);
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
    ...(d.settings.model || d.settings.maxTurns ? [`  settings       ${[d.settings.model && `model ${d.settings.model}`, d.settings.effort && `effort ${d.settings.effort}`, d.settings.maxTurns && `maxTurns ${d.settings.maxTurns}`, d.settings.maxBudgetUsd && `budget $${d.settings.maxBudgetUsd}`, d.settings.timeoutSeconds && `timeout ${d.settings.timeoutSeconds}s`].filter(Boolean).join(", ")}`] : []),
    ...(d.builtinTools.proposed.length || d.builtinTools.dropped.length ? [`  built-in tools ${d.builtinTools.proposed.join(", ") || "none"}${d.builtinTools.dropped.length ? ` (dropped: ${d.builtinTools.dropped.join(", ")})` : ""}`] : []),
    ...d.mcpServers.map((m) => `  MCP not wired  ${m.name}: ${m.reason}`),
    `  connection     one owner approval in Portal (device flow); card "${p.name}"`,
    `  inbox          ${p.serve ? `Connect channel inbox, wake: ${p.wake}` : "none (this harness runs itself)"}`,
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
  for (const f of files) {
    let t = await readFile(f, "utf8");
    for (const [from, to] of Object.entries(TOOL_REWRITES)) t = t.split(from).join(to);
    t.split("\n").forEach((line, i) => {
      if (REVIEW_LINE.test(line)) review.push(`${basename(f)}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
    parts.push(t.trim());
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

/** `tealbrick adopt` */
export const adopt: Handler = async (ctx) => {
  if (ctx.v.undo === true) return adoptUndo(ctx);
  const home = ctx.io.env.HOME ?? "";
  if (!home) throw usageError("HOME is not set");
  const d = await detect(ctx.io.env, ctx.cwd(), { ...(ctx.v.harness ? { harness: String(ctx.v.harness) } : {}), ...(ctx.v["from-v1"] ? { fromV1: resolve(ctx.cwd(), String(ctx.v["from-v1"])) } : {}), ...(ctx.v.persona ? { persona: String(ctx.v.persona) } : {}) });
  if (!d.harness.chosen) throw usageError(`${d.harness.reason}${d.harness.candidates.length ? ` (${d.harness.candidates.join(", ")})` : ""}`);
  const harness = d.harness.chosen;
  const name = String(ctx.v.name ?? d.v1?.agentName ?? "").trim();
  if (!name) throw usageError("pass --name <card name> (no v1 agent name found)");
  const wake = ctx.v.wake === "all" ? "all" : "mentions";
  if (ctx.v.wake !== undefined && ctx.v.wake !== "all" && ctx.v.wake !== "mentions") throw usageError("--wake must be mentions or all");
  const serveDefault = harness === "claude-sdk";
  const serve = ctx.v["no-serve"] === true ? false : ctx.v.serve === true ? true : serveDefault;
  if (serve && harness !== "claude-sdk") throw usageError("--serve (agent serve config) is for the claude-sdk harness in phase 1; other harnesses run themselves");
  const plan: AdoptPlan = { name, purpose: ctx.v.purpose ? String(ctx.v.purpose) : null, harness, detection: d, serve, wake };
  const prior = await findState(ctx, name, harness);
  const dirFor = (agt: string) => join(adoptRoot(ctx), agt);
  const planned = [...(serve ? ["<adopt>/serve.json"] : []), ...(d.persona.files.length ? ["<adopt>/persona/persona.md"] : []), ...(harness === "claude-code" || harness === "claude-desktop" || harness === "codex" ? [`${harness} MCP config (entry "tealbrick")`] : [])];
  const text = planText(plan, planned);

  if (ctx.v["dry-run"] === true) {
    ctx.emit({ dryRun: true, plan: { ...plan, files: planned }, existing: prior ? { agent: prior.state.agt, connection: prior.state.con } : null }, `${text}\n\n--dry-run: nothing was written.`);
    return;
  }
  ctx.say(text);
  if (ctx.v.yes !== true && !(await confirm(ctx, "Go ahead? This asks the owner for ONE approval in Portal."))) throw new CliError(EXIT.usage, "cancelled", "adopt cancelled; nothing was written");

  // §10 / §4: re-use a valid connection; otherwise ONE device flow for the card (same card id on a re-run)
  let item = prior ? await pickAgentItem(ctx.store(), prior.state.con).catch(() => null) : null;
  if (!item) {
    const captured: { connections?: { con: string; agt: string }[] }[] = [];
    const sub: Ctx = { ...ctx, v: { ...ctx.v, ...(prior ? { create: undefined } : { create: true }), name, ...(plan.purpose ? { purpose: plan.purpose } : {}) }, g: { ...ctx.g, agents: prior ? [prior.state.agt] : [], agent: prior?.state.agt }, emit: (r) => void captured.push(r as never) };
    if (prior) delete (sub.v as Record<string, unknown>).create;
    await agentLogin(sub);
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
  if (harness === "claude-code" || harness === "claude-desktop" || harness === "codex") {
    const sub: Ctx = { ...ctx, v: { ...ctx.v, local: true, remote: undefined }, g: { ...ctx.g, agent: item.agt, agents: [item.agt] } };
    const cp = await planConnect(sub, harness);
    if (!cp.target) throw new CliError(EXIT.unexpected, "internal", `no config path for ${harness}`);
    const old = await readExisting(cp.target);
    const next = cp.toml ? mergeTomlConfig(old, cp.toml, cp.target) : mergeJsonConfig(old, cp.entry as Record<string, unknown>, cp.target);
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
      modelKeyEnv: "ANTHROPIC_API_KEY",
      ...(state.persona ? { appendSystemPromptFile: relative(adir, state.persona.path) } : {}),
      ...(d.settings.model ? { model: d.settings.model } : {}),
      ...(d.settings.effort && ["low", "medium", "high", "xhigh", "max"].includes(d.settings.effort) ? { effort: d.settings.effort } : {}),
      ...(d.settings.maxTurns ? { maxTurns: d.settings.maxTurns } : {}),
      ...(d.settings.maxBudgetUsd ? { maxBudgetUsd: d.settings.maxBudgetUsd } : {}),
      ...(d.settings.timeoutSeconds && d.settings.timeoutSeconds >= 10 ? { turnTimeoutSeconds: Math.min(d.settings.timeoutSeconds, 86_400) } : {}),
      ...(d.builtinTools.proposed.length ? { builtinTools: d.builtinTools.proposed } : {}),
    };
    const cfg = { format: "tealbrick.agent-serve/1", harness: harnessCfg, pollSeconds: 30, holds: true, inboxes: [{ tool: "connect__channel_inbox", cursor: { param: "sinceSeq", from: "nextSeq" }, id: "seq", wake }] };
    const text2 = `${JSON.stringify(cfg, null, 2)}\n`;
    const path = join(adir, "serve.json");
    if (state.serve?.digest !== digestOf(text2) || !existsSync(path)) {
      await writePrivate(path, text2);
      changes.push(path);
    }
    state.serve = { path, digest: digestOf(text2) };
  }

  state.updatedAt = new Date(ctx.now()).toISOString();
  await writePrivate(join(adir, "adopt.json"), `${JSON.stringify(state, null, 2)}\n`);

  // §9 verify (reads only; writes need the owner's write grant)
  const probe = await probeAgent(ctx, item);
  const serveCmd = state.serve ? `tealbrick agent serve --file ${state.serve.path} --agent ${item.agt} --supervise` : null;
  const report = {
    agent: item.agt,
    connection: item.con,
    harness,
    reused: !!prior,
    probe,
    changed: changes,
    backups: state.wired.filter((x) => x.backup).map((x) => x.backup),
    personaReview,
    serve: serveCmd,
    notCopied: d.notCopied.map((x) => x.path),
  };
  ctx.emit(
    report,
    [
      `adopted ${item.agt} (${item.con}) — ${prior ? "re-run, connection reused" : "new connection"}`,
      `bridge ${probe.state}, tools ${probe.tools ?? "-"}`,
      changes.length ? `changed: ${changes.join(", ")}` : "nothing changed (already adopted)",
      ...(report.backups.length ? [`backups: ${report.backups.join(", ")}`] : []),
      ...(personaReview.length ? ["review these persona lines (tool or channel references):", ...personaReview.map((l) => `  ${l}`)] : []),
      ...(serveCmd ? [`run: ${serveCmd}`] : []),
      "test: ask the owner to send the agent a message in the Teal Brick inbox; writes need the owner's write grant.",
    ].join("\n"),
  );
};

/** §10 --undo: own pidfile only (L20), restore backups, remove the local key; the owner revokes in Portal. */
async function adoptUndo(ctx: Ctx): Promise<void> {
  const found = await findState(ctx, ctx.v.name ? String(ctx.v.name) : undefined, ctx.v.harness ? String(ctx.v.harness) : undefined, ctx.g.agent);
  if (!found) throw usageError("nothing to undo: pass --name or --agent of an adopted agent");
  const { dir, state } = found;
  const done: string[] = [];
  const left: string[] = [];
  // stop the serve loop of THIS connection via its own pidfile (never by name)
  const pf = pidPath(ctx.configDir(), state.con);
  const holder = await readPid(pf);
  if (holder) {
    // L20: signal only when the heartbeat of THIS connection names the same pid and is recent (a stale pidfile may
    // name a pid the OS gave to an unrelated process)
    const hb = await readHeartbeat(heartbeatPath(ctx.configDir(), state.con));
    const recent = hb && Date.parse(hb.since) > ctx.now() - 15 * 60_000;
    if (hb && hb.pid === holder.pid && recent) {
      try {
        process.kill(holder.pid, "SIGTERM");
        done.push(`stopped agent serve (pid ${holder.pid})`);
      } catch {
        /* not running */
      }
    } else if (holder.role === "supervisor") left.push(`agent serve supervisor pid ${holder.pid}: not confirmed by a recent heartbeat; stop it yourself if it still runs`);
    await rm(pf, { force: true });
    await rm(heartbeatPath(ctx.configDir(), state.con), { force: true });
  }
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
  ctx.emit({ undone: state.agt, connection: state.con, done, left }, [...done, ...left.map((l) => `left: ${l}`), "Owner: revoke the connection in Portal → the agent card → Connections."].join("\n"));
}

