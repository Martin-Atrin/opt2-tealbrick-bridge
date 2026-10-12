/**
 * Agent mode, local bridge relay, own-infrastructure bridge, standalone admin (CLI.md §3 standalone
 * rows, §4, §5). Agent paths load agent items only — never the person item (R-P1, CLI rule 1).
 */
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrolBridge,
  type ManifestApi,
  manifestApi,
  ownInfraEnv,
  startBridge,
} from "@opt2-tealbrick/bridge";
import type { AgentId, Ed25519PublicJwk } from "@opt2-tealbrick/spec/credentials";
import type { DeviceAgentTokenResult, DeviceStart, DeviceStartAgentInput, DeviceTokenInput } from "@opt2-tealbrick/spec/routes";
import type { Ctx, Handler } from "./ctx.ts";
import { requirePos } from "./ctx.ts";
import { CliError, EXIT, isRecord, usageError } from "./io.ts";
import { defaultOpenUrl } from "./owner.ts";
import { type AgentItem, pickAgentItem, readAgentItems as readItems, serveRelay } from "./relay-main.ts";
import { requireSession } from "./session.ts";
import { AGENT_ITEM_PREFIX } from "./store.ts";
import { CLIENT_ID } from "./version.ts";

let apiCache: ManifestApi | undefined;
const api = (): ManifestApi => {
  apiCache ??= manifestApi();
  return apiCache;
};

const MAX_AGENTS = 64;
const MIN_INTERVAL_S = 5;
const SLOW_DOWN_S = 5;

const readAgentItems = (ctx: Ctx): Promise<AgentItem[]> => readItems(ctx.store());
const pickAgent = (ctx: Ctx): Promise<AgentItem> => pickAgentItem(ctx.store(), ctx.g.agent);

async function keyOf(item: AgentItem) {
  return api().importKeyPair(new Uint8Array(Buffer.from(item.privateKey, "base64url")));
}

/** K4 agent assertion → K5 access token at the bridge (jwt-bearer). Returns the token or throws. */
async function accessToken(ctx: Ctx, item: AgentItem): Promise<string> {
  const now = Math.floor(ctx.now() / 1000);
  const key = await keyOf(item);
  const assertion = await api().signAssertion(
    "tb-agent-assert+jwt",
    { iss: `tb:agt:${item.agt}`, sub: `tb:agt:${item.agt}`, aud: `tb:brg:${item.bridgeId}`, iat: now, exp: now + 60, jti: api().ulid(), con: item.con },
    key,
  );
  let res: Response;
  try {
    res = await ctx.io.fetch(item.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new CliError(EXIT.network, "upstream_timeout", "bridge unreachable");
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (res.ok && body.access_token) return body.access_token;
  if (body.error_description === "connection_unknown") throw new CliError(EXIT.refused, "connection_unknown", "the bridge does not know this connection yet (it arrives with the next config, ≤ 60 s)");
  throw new CliError(EXIT.refused, "invalid_grant", "the bridge refused this agent connection (revoked or paused)");
}

// ── agent login (CLI.md §4; one device request for 1..64 agents, C16 S4) ──
async function agentLogin(ctx: Ctx): Promise<void> {
  if (ctx.v.code !== undefined) throw usageError("agent login takes no code (the owner approves in the browser)");
  const origin = ctx.portalOrigin();
  const harness = ctx.v.harness ?? "tealbrick_cli";
  const label = (ctx.v.label ?? ctx.io.hostname ?? osHostname()).slice(0, 64) || "machine";
  // Every slot names an existing card (`id`) or asks for a new one (`create: true`): an approval must never
  // create cards by accident (QA S2: entries without ids produced duplicate cards). Ids come from the owner's
  // `tealbrick agents export --file <agents.json>`; agent mode cannot read the card list itself.
  let slots: { agt?: AgentId; name?: string }[] = ctx.g.agents.map((a) => ({ agt: a as AgentId }));
  if (ctx.v.file) {
    const { readFile } = await import("node:fs/promises");
    const doc = JSON.parse(await readFile(ctx.v.file, "utf8")) as { format?: string; agents?: { name?: unknown; id?: unknown; create?: unknown }[] };
    if (doc.format !== "tealbrick.agents/1" || !Array.isArray(doc.agents)) throw new CliError(EXIT.validation, "input_invalid", "file is not tealbrick.agents/1");
    const problems: string[] = [];
    slots = doc.agents.map((a, i) => {
      const name = typeof a.name === "string" && a.name ? a.name : `#${i + 1}`;
      if (typeof a.id === "string" && a.create === true) problems.push(`${name}: has both id and create`);
      else if (typeof a.id === "string") return { agt: a.id as AgentId, name };
      else if (a.create !== true) problems.push(`${name}: no id (run \`tealbrick agents export --file ${ctx.v.file}\` as the owner) and no "create": true`);
      return { name };
    });
    if (problems.length) throw new CliError(EXIT.validation, "input_invalid", `refusing to start: every entry needs an agent id or "create": true — ${problems.join("; ")}`);
  }
  if (slots.length === 0) {
    if (ctx.v.create !== true) throw usageError("pass --agent <agt_…> (an existing card) or --create (choose or create the card at approval)");
    slots = [{}];
  }
  const ids = slots.map((x) => x.agt).filter((x): x is AgentId => !!x);
  if (new Set(ids).size !== ids.length) throw new CliError(EXIT.validation, "input_invalid", "the same agent id appears twice");
  if (slots.length > MAX_AGENTS) throw new CliError(EXIT.validation, "input_invalid", `at most ${MAX_AGENTS} agents per request`);
  for (const s of slots) if (s.agt && !/^agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(s.agt)) throw usageError(`not an agent id: ${s.agt}`);
  const keys = await Promise.all(slots.map(() => api().generateKeyPair()));
  const client = ctx.client(origin);
  const startInput: DeviceStartAgentInput = {
    scope: "agent",
    client_id: CLIENT_ID,
    machine_label: label,
    harness,
    agents: slots.map((s, i) => ({ ...(s.agt ? { agt: s.agt } : {}), public_key: (keys[i] as { publicJwk: Ed25519PublicJwk }).publicJwk as never })),
  };
  const start = await client.call<DeviceStart>("device.start", startInput as unknown as Record<string, unknown>);
  ctx.say(`Open this URL to connect ${slots.length} agent(s) on "${label}":\n  ${start.verification_uri_complete}\nCheck that the code shown there is: ${start.user_code}`);
  for (const [i, s] of slots.entries()) ctx.say(`  #${i + 1}: ${s.agt ?? s.name ?? "(choose a card)"}`);
  if (ctx.v.open === true) await (ctx.io.openUrl ?? ((u: string) => defaultOpenUrl(u, ctx.platform())))(start.verification_uri_complete).catch(() => ctx.say("Could not open a browser; open the URL yourself."));
  const result = await pollAgent(ctx, client, start);
  const byThumb = new Map(keys.map((k) => [api().thumbprint(k.publicJwk), k]));
  const store = ctx.store();
  const created: { con: string; agt: string }[] = [];
  for (const c of result.connections) {
    const key = byThumb.get(c.public_key_thumbprint);
    if (!key) continue;
    const item: AgentItem = {
      v: 1,
      kind: "agent",
      con: c.connection_id,
      agt: c.agent_id,
      ws: result.workspace_id,
      bridgeId: result.bridge_id,
      bridgeUrl: new URL(result.mcp_url).origin,
      tokenEndpoint: result.token_endpoint,
      harness,
      label,
      publicJwk: key.publicJwk,
      privateKey: Buffer.from(await api().exportPrivateKey(key)).toString("base64url"),
      createdAt: new Date(ctx.now()).toISOString(),
    };
    await store.put(`${AGENT_ITEM_PREFIX}${item.con}`, JSON.stringify(item));
    created.push({ con: item.con, agt: item.agt });
  }
  // wait until the bridge accepts each connection (it arrives with the next config, backoff ≤ 60 s)
  const ready: string[] = [];
  for (const c of created) {
    const item = (await readAgentItems(ctx)).find((i) => i.con === c.con) as AgentItem;
    let wait = 2_000;
    const deadline = ctx.now() + 5 * 60_000;
    for (;;) {
      try {
        await accessToken(ctx, item);
        ready.push(c.con);
        break;
      } catch (e) {
        if (!(e instanceof CliError) || e.code !== "connection_unknown" || ctx.now() > deadline) {
          ctx.say(`agent ${c.agt}: ${e instanceof Error ? e.message : "not accepted yet"}`);
          break;
        }
        await ctx.sleep(wait);
        wait = Math.min(wait * 2, 60_000);
      }
    }
  }
  ctx.say(`Connected ${created.length} agent(s). Next: tealbrick connect <harness> --agent <agt> --local`);
  ctx.emit({ workspace: result.workspace_id, bridgeId: result.bridge_id, mcpUrl: result.mcp_url, connections: created.map((c) => ({ ...c, ready: ready.includes(c.con) })) }, created.map((c) => `${c.agt}  ${c.con}${ready.includes(c.con) ? "" : "  (not ready yet)"}`).join("\n"));
}

async function pollAgent(ctx: Ctx, client: ReturnType<Ctx["client"]>, start: DeviceStart): Promise<DeviceAgentTokenResult> {
  let interval = Math.max(MIN_INTERVAL_S, Number.isFinite(start.interval) ? start.interval : MIN_INTERVAL_S);
  const deadline = ctx.now() + (Number.isFinite(start.expires_in) ? start.expires_in : 600) * 1000;
  const body: DeviceTokenInput = { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code, client_id: CLIENT_ID };
  for (;;) {
    await ctx.sleep(interval * 1000);
    if (ctx.now() >= deadline) throw new CliError(EXIT.deviceDenied, "expired_token", "the request expired before it was approved");
    try {
      const res = await client.call<unknown>("device.token", body as unknown as Record<string, unknown>);
      if (!isRecord(res) || res.scope !== "agent" || !Array.isArray(res.connections) || typeof res.bridge_id !== "string") {
        // an owner token here would be a person credential: never stored by agent mode
        throw new CliError(EXIT.wrongKind, "wrong_credential_kind", "the Portal did not return agent connections");
      }
      return res as unknown as DeviceAgentTokenResult;
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      if (e.code === "authorization_pending") continue;
      if (e.code === "slow_down") {
        interval += SLOW_DOWN_S;
        continue;
      }
      if (e.code === "access_denied") throw new CliError(EXIT.deviceDenied, "access_denied", "the request was denied in the browser");
      if (e.code === "expired_token") throw new CliError(EXIT.deviceDenied, "expired_token", "the request expired before it was approved");
      throw e;
    }
  }
}

async function agentStatus(ctx: Ctx): Promise<void> {
  const item = await pickAgent(ctx);
  let reachable = false;
  let tools: number | null = null;
  let state = "unknown";
  try {
    const token = await accessToken(ctx, item);
    reachable = true;
    const post = async (body: unknown, sid?: string) =>
      ctx.io.fetch(`${item.bridgeUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tealbrick-cli" } } });
    const sid = init.headers.get("mcp-session-id") ?? undefined;
    const initBody = (await init.json()) as { result?: { instructions?: string } };
    const list = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sid)).json()) as { result?: { tools?: unknown[] } };
    tools = list.result?.tools?.length ?? 0;
    state = /paused/.test(initBody.result?.instructions ?? "") ? "paused" : "connected";
    if (sid) await ctx.io.fetch(`${item.bridgeUrl}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": sid } }).catch(() => undefined);
  } catch (e) {
    state = e instanceof CliError ? e.code : "offline";
  }
  ctx.emit({ agent: item.agt, connection: item.con, bridge: item.bridgeUrl, reachable, state, tools }, `agent ${item.agt}\nconnection ${item.con}\nbridge ${item.bridgeUrl} (${state})\ntools ${tools ?? "-"}`);
}

async function agentList(ctx: Ctx): Promise<void> {
  const items = await readAgentItems(ctx);
  ctx.emit(
    { agents: items.map((i) => ({ agent: i.agt, connection: i.con, method: "key", bridge: i.bridgeUrl, harness: i.harness })) },
    items.length ? items.map((i) => `${i.agt}  ${i.con}  ${i.bridgeUrl}`).join("\n") : "no agent items on this machine",
  );
}

async function agentLogout(ctx: Ctx): Promise<void> {
  const item = await pickAgent(ctx);
  await ctx.store().delete(`${AGENT_ITEM_PREFIX}${item.con}`);
  ctx.say(`Deleted the key of ${item.agt}. To revoke the connection everywhere, open Portal → the agent card → Connections (owner, in the browser).`);
  ctx.emit({ deleted: item.con, agent: item.agt });
}

/** `tealbrick agent serve --file <agent-serve.json> [--agent <agt>]` (C58): see serve.ts. */
async function agentServe(ctx: Ctx): Promise<void> {
  if (!ctx.v.file) throw usageError("agent serve needs --file <agent-serve.json> (format tealbrick.agent-serve/1)");
  const { readFile } = await import("node:fs/promises");
  const { PassThrough } = await import("node:stream");
  const { connectMcp, startRelay } = await import("@opt2-tealbrick/bridge");
  const serve = await import("./serve.ts");
  let cfg: ReturnType<typeof serve.validateServeConfig>;
  try {
    cfg = serve.validateServeConfig(JSON.parse(await readFile(ctx.v.file, "utf8")));
  } catch (e) {
    throw new CliError(EXIT.validation, "input_invalid", e instanceof Error ? e.message : "invalid config");
  }
  const item = await pickAgent(ctx);
  const key = await keyOf(item);
  // in-process relay: the watcher's MCP connection to the deployed bridge, as this agent
  const toRelay = new PassThrough();
  const fromRelay = new PassThrough();
  const relay = startRelay({
    api: api(),
    bridgeUrl: item.bridgeUrl,
    connection: { con: item.con, agt: item.agt, bridgeId: item.bridgeId },
    signer: {
      sign: async (input) => Buffer.from(await crypto.subtle.sign("Ed25519", key.privateKey, new TextEncoder().encode(input))).toString("base64url"),
      publicJwk: () => item.publicJwk,
    },
    onStatus: (s) => ctx.say(JSON.stringify({ event: "serve.relay", status: s })),
    stdin: toRelay,
    stdout: fromRelay,
  });
  const mcp = connectMcp({ streams: { input: fromRelay, output: toRelay } });
  await mcp.initialize("tealbrick-agent-serve");
  const relayCmd = { command: process.execPath, args: [process.argv[1] ?? "tealbrick", "bridge", "serve", "--stdio", "--agent", item.agt] };
  const runTurn =
    cfg.harness.kind === "claude"
      ? await serve.claudeRunner(cfg.harness, item.agt, relayCmd)
      : await serve.commandRunner(cfg.harness, [relayCmd.command, ...relayCmd.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" "));
  const { join } = await import("node:path");
  const abort = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => abort.abort());
  ctx.say(`serving agent ${item.agt}: ${cfg.inboxes.length} inbox(es), harness ${cfg.harness.kind}; Ctrl-C to stop`);
  await serve.serveLoop(
    cfg,
    {
      mcp,
      runTurn,
      ...serve.fileState(join(ctx.configDir(), `agent-serve-${item.con}.json`)),
      log: (event, fields = {}) => ctx.io.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, agent: item.agt, ...fields })}\n`),
      sleep: (ms, signal) =>
        new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            r();
          }, { once: true });
        }),
      now: () => Date.now(),
    },
    abort.signal,
  );
  mcp.close();
  relay.stop();
}

export const agent: Handler = async (ctx) => {
  const cmd = requirePos(ctx, 1, "agent command (login|status|serve|logout|list)");
  if (cmd === "serve") return agentServe(ctx);
  if (cmd === "login") return agentLogin(ctx);
  if (cmd === "status") return agentStatus(ctx);
  if (cmd === "logout") return agentLogout(ctx);
  if (cmd === "list") return agentList(ctx);
  throw usageError(`unknown agent command: ${cmd}`);
};

// ── bridge serve --stdio (relay, C5/C24) | enrol | run (own infrastructure) ──
export const bridge: Handler = async (ctx) => {
  const cmd = requirePos(ctx, 1, "bridge command (serve|enrol|run)");
  if (cmd === "serve") {
    if (ctx.v.stdio !== true) throw usageError("bridge serve needs --stdio (the relay has no listener)");
    await serveRelay({ store: ctx.store(), agent: ctx.g.agent, stderr: ctx.io.stderr });
    return;
  }
  const dataDir = ctx.v["data-dir"] ?? ctx.io.env.TB_DATA_DIR;
  if (!dataDir) throw usageError("--data-dir (or TB_DATA_DIR) is required for a full bridge");
  const env = ownInfraEnv({ ...process.env, TB_DATA_DIR: dataDir }, api());
  if (cmd === "enrol") {
    const code = await readCode(ctx);
    if (!code.startsWith("tbe_")) throw new CliError(EXIT.validation, "input_invalid", "not an enrolment code (tbe_…)");
    const r = await enrolBridge({ api: api(), env: { ...env, TB_ENROL_CODE: code }, form: "own_infra" });
    ctx.emit(r, `enrolled bridge ${r.bridgeId} for workspace ${r.workspaceId}; start it with: tealbrick bridge run --data-dir ${dataDir}`);
    return;
  }
  if (cmd === "run") {
    const running = await startBridge({ api: api(), env, form: "own_infra" });
    ctx.say(`bridge ${running.ctx.identity?.bridgeId} running (data ${dataDir})`);
    await new Promise<void>((resolve) => {
      const stop = () => void running.stop().then(resolve);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  throw usageError(`unknown bridge command: ${cmd}`);
};

async function readCode(ctx: Ctx): Promise<string> {
  const raw = ctx.g.code;
  if (raw === undefined) throw usageError("--code - is required (read from stdin)");
  if (raw !== "-") {
    ctx.say("warning: a code on the command line stays in shell history; prefer --code - and stdin");
    return raw.trim();
  }
  let text = "";
  for await (const chunk of ctx.io.stdin) text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  return text.trim();
}

// ── standalone owner key + 4 admin ops (CREDENTIALS §17, C16 B7) ──
interface OwnerKeyItem {
  v: 1;
  kind: "owner-key";
  ws: string;
  per: string;
  publicJwk: Ed25519PublicJwk;
  privateKey: string;
}

export const standalone: Handler = async (ctx) => {
  const cmd = requirePos(ctx, 1, "standalone command (owner-key)");
  if (cmd !== "owner-key") throw usageError(`unknown standalone command: ${cmd}`);
  // the person id comes from the owner's own session (a read); the key itself is local
  const s = await requireSession(ctx);
  const me = await s.client.call<{ person?: { id?: string } }>("account.me");
  const per = me.person?.id;
  const ws = ctx.g.ws;
  if (!ws) throw usageError("--ws <ws_…> is required");
  if (typeof per !== "string" || !per.startsWith("per_")) throw new CliError(EXIT.unexpected, "internal", "could not read the person id");
  const key = await api().generateKeyPair();
  const item: OwnerKeyItem = { v: 1, kind: "owner-key", ws, per, publicJwk: key.publicJwk, privateKey: Buffer.from(await api().exportPrivateKey(key)).toString("base64url") };
  await ctx.store().put(`tealbrick.owner-key.${ws}`, JSON.stringify(item));
  ctx.say("Paste this public key into Portal → Workspace → Leave Portal (browser). The private key stays in your keychain.");
  ctx.emit({ ws, publicJwk: key.publicJwk }, JSON.stringify(key.publicJwk));
};

export const admin: Handler = async (ctx) => {
  const cmd = requirePos(ctx, 1, "admin command (pause|resume|revoke-connection|ticket)");
  const ws = ctx.g.ws;
  if (!ws) throw usageError("--ws <ws_…> is required");
  const bridgeUrl = ctx.v.bridge;
  if (!bridgeUrl) throw usageError("--bridge <https://…> (the standalone bridge) is required");
  const raw = await ctx.store().get(`tealbrick.owner-key.${ws}`);
  if (!raw) throw new CliError(EXIT.notSignedIn, "unauthenticated", "no standalone owner key for this workspace; run tealbrick standalone owner-key");
  const item = JSON.parse(raw) as OwnerKeyItem;
  let path: string;
  let body: Record<string, unknown> = {};
  if (cmd === "pause" || cmd === "resume") {
    path = `/admin/v1/${cmd}`;
    if (ctx.g.agent) body = { agt: ctx.g.agent };
  } else if (cmd === "revoke-connection") {
    path = "/admin/v1/revoke-connection";
    body = { con: requirePos(ctx, 2, "connection id") };
  } else if (cmd === "ticket") {
    path = "/admin/v1/ticket";
    const pur = requirePos(ctx, 2, "launch|keys");
    body = pur === "keys" ? { pur: "keys" } : { pur: "launch", product: requirePos(ctx, 3, "product"), ...(ctx.v.path ? { path: ctx.v.path } : {}) };
  } else throw usageError(`unknown admin command: ${cmd}`);
  const origin = new URL(bridgeUrl).origin;
  const raw2 = Buffer.from(JSON.stringify(body), "utf8");
  const now = Math.floor(ctx.now() / 1000);
  const key = await api().importKeyPair(new Uint8Array(Buffer.from(item.privateKey, "base64url")));
  const assertion = await api().signAssertion(
    "tb-owner-assert+jwt",
    { iss: `tb:per:${item.per}`, sub: `tb:per:${item.per}`, aud: `tb:brg:${await bridgeIdOf(ctx, origin)}`, iat: now, exp: now + 60, jti: api().ulid() },
    key,
    { method: "POST", pathAndQuery: path, body: raw2 },
  );
  const res = await ctx.io.fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": assertion }, body: raw2, redirect: "error" });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new CliError(res.status === 401 ? EXIT.notSignedIn : res.status === 404 ? EXIT.notFound : EXIT.refused, String((out.error as { code?: string })?.code ?? "refused"), "the bridge refused the admin request");
  if (cmd === "ticket" && typeof out.ticket === "string" && typeof out.url === "string") {
    // the ticket must be form-POSTed (never in a URL): a one-shot local page does that
    const dir = await mkdtemp(join(tmpdir(), "tealbrick-"));
    const file = join(dir, "open.html");
    const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
    await writeFile(file, `<!doctype html><meta charset="utf-8"><form id="f" method="post" action="${esc(out.url)}"><input type="hidden" name="ticket" value="${esc(out.ticket)}"><button>Open</button></form><script>document.getElementById("f").submit()</script>`, { mode: 0o600 });
    await chmod(file, 0o600);
    ctx.say(`Open within 60 s: ${file}`);
    if (ctx.v.open === true) await (ctx.io.openUrl ?? ((u: string) => defaultOpenUrl(u, ctx.platform())))(`file://${file}`).catch(() => undefined);
    ctx.emit({ file, url: out.url });
    return;
  }
  ctx.emit(out, "ok");
};

/** The bridge id (assertion `aud`) comes from an agent item of the same bridge on this machine. */
async function bridgeIdOf(ctx: Ctx, origin: string): Promise<string> {
  const items = await readAgentItems(ctx);
  const hit = items.find((i) => i.bridgeUrl === origin);
  const id = hit?.bridgeId;
  if (!id) throw usageError("cannot tell the bridge id: sign in an agent of this workspace on this machine first");
  return id;
}

export const leadGroups: Record<string, Handler> = { agent, bridge, admin, standalone };
