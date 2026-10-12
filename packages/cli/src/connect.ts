import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { Ctx, Handler } from "./ctx.ts";
import { requirePos } from "./ctx.ts";
import { unifiedDiff } from "./diff.ts";
import { CliError, EXIT, isRecord, usageError } from "./io.ts";
import { normalizePortalOrigin } from "./portal.ts";
import type { CredentialStore } from "./store.ts";
import { createFileStore, isAgentItem, relayStoreArgs } from "./store.ts";
import { TomlError, tomlString, upsertMcpTable } from "./toml.ts";

/**
 * `tealbrick connect <harness>` (CLI.md section 6). Prints by default; `--write` previews a diff,
 * asks, then writes atomically with a timestamped backup. No Portal call. The person item is never loaded.
 */

const HARNESSES = ["claude-desktop", "codex", "claude-code", "generic"] as const;
type Harness = (typeof HARNESSES)[number];
const AGENT_ID = /^agt_[A-Za-z0-9]+$/;

interface AgentInfo {
  agt: string | undefined;
  bridgeUrl: string | undefined;
}

/** Pick only agt and bridgeUrl from agent items; key material in the item is never kept. */
async function readAgentInfo(ctx: Ctx): Promise<AgentInfo> {
  const want = ctx.g.agent;
  const bridge = ctx.v.bridge;
  if (want !== undefined && bridge !== undefined) return { agt: want, bridgeUrl: bridge };

  const stores: CredentialStore[] = [ctx.store()];
  if (ctx.store().kind !== "file") stores.push(createFileStore(ctx.configDir()));
  const found: AgentInfo[] = [];
  for (const store of stores) {
    for (const name of await store.list().catch(() => [])) {
      if (!isAgentItem(name)) continue;
      const raw = await store.get(name).catch(() => null);
      if (!raw) continue;
      try {
        const item: unknown = JSON.parse(raw);
        if (!isRecord(item)) continue;
        const agt = typeof item.agt === "string" ? item.agt : typeof item.agentId === "string" ? item.agentId : undefined;
        const bridgeUrl = typeof item.bridgeUrl === "string" ? item.bridgeUrl : undefined;
        found.push({ agt, bridgeUrl });
      } catch {
        // unreadable item: skip
      }
    }
  }
  const pick = want !== undefined ? found.find((f) => f.agt === want) : found.length === 1 ? found[0] : undefined;
  if (want === undefined && found.length > 1) throw usageError("several agent items exist; pass --agent <agt> (or set TB_AGENT)");
  const agt = want ?? pick?.agt;
  const bridgeUrl = bridge ?? pick?.bridgeUrl;
  return { agt, bridgeUrl };
}

function mcpUrl(bridgeUrl: string | undefined): string {
  if (!bridgeUrl) throw usageError("no bridge URL: sign in an agent first (agent item) or pass --bridge <url>");
  const origin = normalizePortalOrigin(bridgeUrl);
  const path = new URL(bridgeUrl).pathname.replace(/\/+$/, "");
  return `${origin}${path.endsWith("/mcp") ? path : `${path}/mcp`}`;
}

function needAgent(agt: string | undefined): string {
  if (!agt) throw usageError("this form needs the agent id: pass --agent <agt_…> (or have one agent item)");
  if (!AGENT_ID.test(agt)) throw usageError("agent id must look like agt_…");
  return agt;
}

export interface ConnectPlan {
  harness: Harness;
  mode: "remote" | "local" | "print";
  url: string | null;
  /** The mcpServers entry (JSON harnesses) or null. */
  entry: Record<string, unknown> | null;
  /** codex: TOML body lines under [mcp_servers.tealbrick]. */
  toml: string[] | null;
  /** Where --write would write, or null. */
  target: string | null;
  text: string;
}

function homeDir(ctx: Ctx): string {
  const h = ctx.io.env.HOME;
  return h && h.length > 0 ? h : homedir();
}

function desktopConfigPath(ctx: Ctx): string {
  const home = homeDir(ctx);
  switch (ctx.platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(ctx.io.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(ctx.io.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
  }
}

/** Relay args for a harness config; carries the file-store choice (the harness starts the relay with its own env). */
export function stdioArgs(agt: string, env: Record<string, string | undefined> = {}): string[] {
  return ["bridge", "serve", "--stdio", "--agent", agt, ...relayStoreArgs(env)];
}

export async function planConnect(ctx: Ctx, harness: Harness): Promise<ConnectPlan> {
  if (ctx.v.remote === true && ctx.v.local === true) throw usageError("pass --remote or --local, not both");
  const info = await readAgentInfo(ctx);
  const stdio = (): Record<string, unknown> => ({ command: "tealbrick", args: stdioArgs(needAgent(info.agt), ctx.io.env) });
  switch (harness) {
    case "claude-desktop": {
      if (ctx.v.local !== true) {
        const url = mcpUrl(info.bridgeUrl);
        return {
          harness,
          mode: "remote",
          url,
          entry: null,
          toml: null,
          target: null,
          text: `Bridge MCP URL: ${url}\n1. In Claude Desktop open Settings, then Connectors.\n2. Choose Add custom connector and paste the URL.\n3. Approve in Portal.`,
        };
      }
      const entry = stdio();
      return { harness, mode: "local", url: null, entry, toml: null, target: desktopConfigPath(ctx), text: JSON.stringify({ mcpServers: { tealbrick: entry } }, null, 2) };
    }
    case "codex": {
      const target = join(homeDir(ctx), ".codex", "config.toml");
      if (ctx.v.remote === true) {
        const url = mcpUrl(info.bridgeUrl);
        const toml = [`url = ${tomlString(url)}`];
        return { harness, mode: "remote", url, entry: null, toml, target, text: `[mcp_servers.tealbrick]\n${toml.join("\n")}` };
      }
      const s = stdio() as { command: string; args: string[] };
      const toml = [`command = ${tomlString(s.command)}`, `args = [${s.args.map(tomlString).join(", ")}]`];
      return { harness, mode: "local", url: null, entry: null, toml, target, text: `[mcp_servers.tealbrick]\n${toml.join("\n")}` };
    }
    case "claude-code": {
      const target = resolve(ctx.cwd(), ".mcp.json");
      if (ctx.v.remote === true) {
        const url = mcpUrl(info.bridgeUrl);
        const entry = { type: "http", url };
        return { harness, mode: "remote", url, entry, toml: null, target, text: `${JSON.stringify({ mcpServers: { tealbrick: entry } }, null, 2)}\n\nOr: claude mcp add --transport http --scope user tealbrick ${url}` };
      }
      const agt = needAgent(info.agt);
      const entry = stdio();
      return {
        harness,
        mode: "local",
        url: null,
        entry,
        toml: null,
        target,
        text: `claude mcp add --scope user tealbrick -- tealbrick ${stdioArgs(agt, ctx.io.env).join(" ")}\n\nOr put this in ./.mcp.json:\n${JSON.stringify({ mcpServers: { tealbrick: entry } }, null, 2)}`,
      };
    }
    case "generic": {
      const out: Record<string, unknown> = {};
      if (info.agt) out.stdio = { command: "tealbrick", args: stdioArgs(needAgent(info.agt), ctx.io.env) };
      if (info.bridgeUrl) out.remote = { url: mcpUrl(info.bridgeUrl) };
      if (Object.keys(out).length === 0) throw usageError("nothing to print: pass --agent <agt_…> and/or --bridge <url>");
      return { harness, mode: "print", url: info.bridgeUrl ? mcpUrl(info.bridgeUrl) : null, entry: out, toml: null, target: null, text: JSON.stringify(out, null, 2) };
    }
  }
}

// ───────────────────────────── --write ─────────────────────────────

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function confirm(ctx: Ctx, question: string): Promise<boolean> {
  if (ctx.g.yes) return true;
  if (ctx.io.stdin.isTTY !== true) {
    throw new CliError(EXIT.usage, "bad_request", "confirmation needed: run in a terminal or pass --yes");
  }
  ctx.io.stderr.write(`${question} [y/N] `);
  const rl = createInterface({ input: ctx.io.stdin as unknown as Readable, terminal: false });
  const answer = await new Promise<string>((res) => {
    rl.once("line", res);
    rl.once("close", () => res(""));
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(EXIT.unexpected, "internal", `cannot read ${path}`);
  }
}

function jsonIndent(old: string | null): string | number {
  const m = old ? /\n([ \t]+)"/.exec(old) : null;
  return m?.[1] ?? 2;
}

/** New text of a JSON config with `mcpServers.tealbrick` set. Throws exit 8 when the file does not parse. */
export function mergeJsonConfig(old: string | null, entry: Record<string, unknown>, path: string): string {
  let root: Record<string, unknown> = {};
  if (old !== null && old.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(old.replace(/^﻿/, ""));
    } catch {
      throw new CliError(EXIT.validation, "validation_failed", `${path} does not parse as JSON; not touching it`);
    }
    if (!isRecord(parsed)) throw new CliError(EXIT.validation, "validation_failed", `${path} is not a JSON object; not touching it`);
    root = parsed;
  }
  if (root.mcpServers !== undefined && !isRecord(root.mcpServers)) {
    throw new CliError(EXIT.validation, "validation_failed", `mcpServers in ${path} is not an object; not touching it`);
  }
  const servers = (isRecord(root.mcpServers) ? root.mcpServers : {}) as Record<string, unknown>;
  servers.tealbrick = entry;
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, jsonIndent(old))}\n`;
}

export function mergeTomlConfig(old: string | null, body: string[], path: string): string {
  try {
    return upsertMcpTable(old ?? "", body);
  } catch (e) {
    if (e instanceof TomlError) throw new CliError(EXIT.validation, "validation_failed", `${path}: ${e.message}; not touching it`);
    throw e;
  }
}

async function writeAtomic(ctx: Ctx, path: string, oldText: string | null, newText: string): Promise<string | null> {
  await mkdir(dirname(path), { recursive: true });
  let mode = 0o644;
  let backup: string | null = null;
  if (oldText !== null) {
    mode = (await stat(path)).mode & 0o777;
    const stamp = utcStamp(ctx.now());
    for (let i = 0; i < 100; i++) {
      const candidate = `${path}.bak-${stamp}${i === 0 ? "" : `-${i}`}`;
      try {
        await copyFile(path, candidate, 1 /* COPYFILE_EXCL */);
        backup = candidate;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    if (!backup) throw new CliError(EXIT.unexpected, "internal", "could not create a backup file");
  }
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tmp, newText, { mode });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return backup;
}

export const connect: Handler = async (ctx) => {
  const name = requirePos(ctx, 1, "harness (claude-desktop | codex | claude-code | generic)");
  if (!(HARNESSES as readonly string[]).includes(name)) throw usageError(`unknown harness: ${name}`);
  const harness = name as Harness;
  const plan = await planConnect(ctx, harness);
  const write = ctx.v.write === true;

  if (!write) {
    ctx.emit({ harness, mode: plan.mode, url: plan.url, entry: plan.entry ?? undefined, toml: plan.toml ? `[mcp_servers.tealbrick]\n${plan.toml.join("\n")}` : undefined, target: plan.target, written: false }, plan.text);
    return;
  }

  if (plan.target === null || (harness === "claude-desktop" && plan.mode === "remote")) {
    throw usageError(harness === "claude-desktop" ? "claude-desktop --write needs --local (the remote form has no file)" : `${harness} has no file to write; it prints only`);
  }
  const target = plan.target;
  const old = await readExisting(target);
  const next = harness === "codex" ? mergeTomlConfig(old, plan.toml ?? [], target) : mergeJsonConfig(old, plan.entry ?? {}, target);
  if (old === next) {
    ctx.say(`${target} already has this entry; nothing to write.`);
    ctx.emit({ harness, target, written: false, unchanged: true, backup: null }, "unchanged");
    return;
  }
  ctx.say(unifiedDiff(old ?? "", next, target));
  if (!(await confirm(ctx, `Write ${target}?`))) {
    ctx.say("Not written.");
    ctx.emit({ harness, target, written: false, backup: null }, "not written");
    return;
  }
  const backup = await writeAtomic(ctx, target, old, next);
  ctx.say(`Wrote ${target}${backup ? ` (backup: ${backup})` : ""}.`);
  ctx.emit({ harness, target, written: true, backup }, `wrote ${target}`);
};

