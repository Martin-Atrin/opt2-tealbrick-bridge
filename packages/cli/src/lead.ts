/**
 * Agent mode, local bridge relay, own-infrastructure bridge, standalone admin (CLI.md §3 standalone
 * rows, §4, §5). Agent paths load agent items only — never the person item (R-P1, CLI rule 1).
 */
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { hostname as osHostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  enrolBridge,
  type ManifestApi,
  manifestApi,
  ownInfraEnv,
  startBridge,
} from "@opt2-tealbrick/bridge";
import type { AgentId, Ed25519PublicJwk } from "@opt2-tealbrick/spec/credentials";
import { type DeviceAgentTokenResult, type DeviceStart, type DeviceStartAgentInput, type DeviceTokenInput, HARNESS_OPTION_IDS, type HarnessOptionId, isHarnessOptionId } from "@opt2-tealbrick/spec/routes";
import { cliEntry, relayCommand } from "./connect.ts";
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
export const pickAgent = (ctx: Ctx): Promise<AgentItem> => pickAgentItem(ctx.store(), ctx.g.agent);

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

/**
 * F39 (bridge ≥ 0.1.18): revoke THIS agent's own key connection at its bridge (`POST /agent/connection/revoke`, an
 * agent assertion signed by the connection key). The bridge refuses it locally at once and reports it to Portal
 * (client_revoke). Never throws: the caller prints the owner step when `ok` is false.
 */
export async function selfRevoke(ctx: Ctx, item: AgentItem): Promise<{ ok: true; already: boolean } | { ok: false; reason: string }> {
  const now = Math.floor(ctx.now() / 1000);
  let url: string;
  try {
    url = new URL("/agent/connection/revoke", item.tokenEndpoint).toString();
  } catch {
    return { ok: false, reason: "no bridge address in the local agent item" };
  }
  try {
    const key = await keyOf(item);
    const assertion = await api().signAssertion(
      "tb-agent-assert+jwt",
      { iss: `tb:agt:${item.agt}`, sub: `tb:agt:${item.agt}`, aud: `tb:brg:${item.bridgeId}`, iat: now, exp: now + 60, jti: api().ulid(), con: item.con },
      key,
    );
    const res = await ctx.io.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion }), redirect: "error", signal: AbortSignal.timeout(20_000) });
    const body = (await res.json().catch(() => ({}))) as { con?: string; status?: string; already?: boolean };
    if (res.ok && body.con === item.con && body.status === "revoked") return { ok: true, already: body.already === true };
    if (res.status === 404) return { ok: false, reason: "the bridge is older than 0.1.18 (no self-revoke)" };
    return { ok: false, reason: `the bridge refused the revoke (HTTP ${res.status})` };
  } catch {
    return { ok: false, reason: "bridge unreachable" };
  }
}

/** spec 0.1.14 allows 1..80; live Core (3230e69) accepts ≤ 60, so the CLI stays at 60 until they agree */
const CARD_NAME_MAX = 60;
const CARD_PURPOSE_MAX = 280;

// ── agent login (CLI.md §4; one device request for 1..64 agents, C16 S4) ──
/**
 * C106a (Core 1527fe8): `agents[].adopt` — a SUGGESTION the owner's approval page pre-fills (grants, channel, wake);
 * the owner decides. Typed locally until spec 0.1.18 (Core shape, coordination REQUESTS "C106a adopt").
 */
export interface AdoptSuggestion {
  grants: { product: string; crud?: ("create" | "read" | "update" | "delete")[]; operations?: string[] }[];
  channel?: { kind: "buzz_channel" | "connect_inbox"; id?: string; createName?: string };
  wake?: "serve" | "poll" | "none";
}

/**
 * BRG-01 (F75, spec 0.1.27): THE map from a local runner kind (`adopt --harness`, `connect <harness>`) to the Portal
 * harness option id that device.start sends. A runner kind is never sent as is: `claude-sdk` and `command` are runner
 * kinds of a `tealbrick-cli` agent, not harness options (no aliases, C133). The ids come from the spec list only (L1).
 */
export const PORTAL_HARNESS_ID = {
  "claude-sdk": "tealbrick-cli",
  command: "tealbrick-cli",
  codex: "codex-desktop",
  "claude-desktop": "claude-desktop",
  "claude-code": "claude-code",
  generic: "generic-mcp",
} as const satisfies Record<string, HarnessOptionId>;

/** `--harness` of agent login: a spec harness option id (default tealbrick-cli); anything else is a usage error. */
export function portalHarnessId(raw: unknown): HarnessOptionId {
  const id = raw ?? "tealbrick-cli";
  if (isHarnessOptionId(id)) return id;
  const kind = typeof id === "string" && Object.hasOwn(PORTAL_HARNESS_ID, id) ? PORTAL_HARNESS_ID[id as keyof typeof PORTAL_HARNESS_ID] : undefined;
  throw usageError(`--harness must be a Portal harness option id: ${HARNESS_OPTION_IDS.join(", ")}${kind ? ` ("${String(id)}" is a runner kind; its harness id is ${kind})` : ""}`);
}

export async function agentLogin(ctx: Ctx, extra: { adopt?: AdoptSuggestion } = {}): Promise<void> {
  if (ctx.v.code !== undefined) throw usageError("agent login takes no code (the owner approves in the browser)");
  // C96/C133/BRG-01: a spec harness option id only (Core accepts canonical ids, no aliases), checked before any call
  const harness = portalHarnessId(ctx.v.harness);
  const origin = ctx.portalOrigin();
  const label = (ctx.v.label ?? ctx.io.hostname ?? osHostname()).slice(0, 64) || "machine";
  // Every slot names an existing card (`id`) or asks for a new one (`create: true`): an approval must never
  // create cards by accident (QA S2: entries without ids produced duplicate cards). Ids come from the owner's
  // `tealbrick agents export --file <agents.json>`; agent mode cannot read the card list itself.
  let slots: { agt?: AgentId; name?: string; purpose?: string }[] = ctx.g.agents.map((a) => ({ agt: a as AgentId }));
  if (ctx.v.file) {
    const { readFile } = await import("node:fs/promises");
    const doc = JSON.parse(await readFile(ctx.v.file, "utf8")) as { format?: string; agents?: { name?: unknown; id?: unknown; create?: unknown; purpose?: unknown }[] };
    if (doc.format !== "tealbrick.agents/1" || !Array.isArray(doc.agents)) throw new CliError(EXIT.validation, "input_invalid", "file is not tealbrick.agents/1");
    const problems: string[] = [];
    slots = doc.agents.map((a, i) => {
      const name = typeof a.name === "string" && a.name ? a.name : `#${i + 1}`;
      if (typeof a.id === "string" && a.create === true) problems.push(`${name}: has both id and create`);
      else if (typeof a.id === "string") return { agt: a.id as AgentId, name };
      else if (a.create !== true) problems.push(`${name}: no id (run \`tealbrick agents export --file ${ctx.v.file}\` as the owner) and no "create": true`);
      return { name, ...(typeof a.purpose === "string" && a.purpose ? { purpose: a.purpose } : {}) };
    });
    if (problems.length) throw new CliError(EXIT.validation, "input_invalid", `refusing to start: every entry needs an agent id or "create": true — ${problems.join("; ")}`);
  }
  if (slots.length === 0) {
    if (ctx.v.create !== true) throw usageError("pass --agent <agt_…> (an existing card) or --create (choose or create the card at approval)");
    slots = [{}];
  }
  if (ctx.v.name !== undefined || ctx.v.purpose !== undefined) {
    if (slots.length !== 1) throw usageError("--name/--purpose describe one agent; use the name/purpose fields of --file for several");
    if (ctx.v.name !== undefined) (slots[0] as { name?: string }).name = String(ctx.v.name);
    if (ctx.v.purpose !== undefined) (slots[0] as { purpose?: string }).purpose = String(ctx.v.purpose);
  }
  for (const s of slots as { purpose?: string }[]) {
    if (s.purpose !== undefined && (s.purpose.trim().length === 0 || s.purpose.length > CARD_PURPOSE_MAX)) throw usageError(`agent purpose must be 1–${CARD_PURPOSE_MAX} characters`);
  }
  for (const s of slots) {
    if (s.name !== undefined && (s.name.trim().length === 0 || s.name.length > CARD_NAME_MAX)) throw usageError(`agent name must be 1–${CARD_NAME_MAX} characters: ${s.name.slice(0, 80)}`);
  }
  // F63/F64: a NEW agent gets the same one-form approval as adopt: app access (pre-ticked reads for --grant products,
  // every other deployed app listed unticked) and the channel it joins, so it does not start with 0 tools
  const suggestion = extra.adopt ?? (ctx.v.create === true && slots.length === 1 && !ctx.v.file ? createSuggestion(ctx) : undefined);
  if (!extra.adopt && (ctx.v.grant !== undefined || ctx.v.channel !== undefined) && !suggestion) throw usageError("--grant/--channel belong to agent login --create (one new agent)");
  const ids = slots.map((x) => x.agt).filter((x): x is AgentId => !!x);
  if (new Set(ids).size !== ids.length) throw new CliError(EXIT.validation, "input_invalid", "the same agent id appears twice");
  if (slots.length > MAX_AGENTS) throw new CliError(EXIT.validation, "input_invalid", `at most ${MAX_AGENTS} agents per request`);
  for (const s of slots) if (s.agt && !/^agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(s.agt)) throw usageError(`not an agent id: ${s.agt}`);
  const keys = await Promise.all(slots.map(() => api().generateKeyPair()));
  const client = ctx.client(origin);
  const startInput: DeviceStartAgentInput & { agents: (DeviceStartAgentInput["agents"][number] & { adopt?: AdoptSuggestion })[] } = {
    scope: "agent",
    client_id: CLIENT_ID,
    machine_label: label,
    harness,
    // C96: the slot's suggested card name, so the owner approves a NAMED card in one click (GUI prefills it).
    // Placeholder names of unnamed file entries (`#3`) are never sent.
    agents: slots.map((s, i) => ({
      ...(suggestion && i === 0 ? { adopt: suggestion } : {}),
      ...(s.agt ? { agt: s.agt } : {}),
      ...(s.name && !/^#\d+$/.test(s.name) ? { name: s.name.trim() } : {}),
      ...((s as { purpose?: string }).purpose ? { purpose: ((s as { purpose?: string }).purpose as string).trim() } : {}),
      public_key: (keys[i] as { publicJwk: Ed25519PublicJwk }).publicJwk as never,
    })),
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
  // F64: the owner named a Buzz channel: is the agent a member? Membership is the Buzz relay's (the channel admin adds
  // the agent's npub); when it is missing, say exactly which npub to add. Never blocks the login.
  const asked = suggestion?.channel?.kind === "buzz_channel" ? suggestion.channel : undefined;
  if (!extra.adopt && asked && created.length === 1 && ready.length === 1) {
    const item = (await readAgentItems(ctx)).find((i) => i.con === created[0]?.con);
    if (item) await channelMembership(ctx, item, asked).then((line) => line && ctx.say(line));
  }
  ctx.say(`Connected ${created.length} agent(s). Next: tealbrick connect <harness> --agent <agt> --local${ctx.v.create === true ? ", or write an agent-serve.json (assets/agent-serve.example.json) and run tealbrick agent serve --file <it> --detach" : ""}`);
  ctx.emit({ workspace: result.workspace_id, bridgeId: result.bridge_id, mcpUrl: result.mcp_url, connections: created.map((c) => ({ ...c, ready: ready.includes(c.con) })) }, created.map((c) => `${c.agt}  ${c.con}${ready.includes(c.con) ? "" : "  (not ready yet)"}`).join("\n"));
}

const CRUD = ["create", "read", "update", "delete"] as const;

/** F63: `--grant <product>[:read+create+…],…` (repeatable) and `--channel buzz:<id>|new:<name>`. */
export function createSuggestion(ctx: Ctx): AdoptSuggestion {
  const grants: AdoptSuggestion["grants"] = [];
  for (const raw of ctx.v.grant ?? []) {
    for (const part of String(raw).split(",").map((x) => x.trim()).filter(Boolean)) {
      const [product, verbs] = part.split(":") as [string, string | undefined];
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(product)) throw usageError(`--grant takes <product>[:read+create+update+delete],…: ${part}`);
      const crud = verbs ? verbs.split("+").filter(Boolean) : ["read"];
      if (!crud.every((c) => (CRUD as readonly string[]).includes(c))) throw usageError(`--grant ${part}: access must be read, create, update or delete`);
      if (grants.some((g) => g.product === product)) throw usageError(`--grant names ${product} twice`);
      grants.push({ product, crud: crud as AdoptSuggestion["grants"][number]["crud"] });
    }
  }
  if (grants.length > 16) throw usageError("--grant: at most 16 products");
  const ch = ctx.v.channel === undefined ? undefined : String(ctx.v.channel);
  let channel: AdoptSuggestion["channel"] = { kind: "buzz_channel" };
  if (ch !== undefined) {
    const m = /^(buzz|new):(.{1,200})$/.exec(ch);
    if (!m) throw usageError("--channel takes buzz:<channel id> or new:<name>");
    channel = m[1] === "buzz" ? { kind: "buzz_channel", id: m[2] as string } : { kind: "buzz_channel", createName: (m[2] as string).slice(0, 60) };
  }
  return { grants, channel, wake: "serve" };
}

/** F64: one owner line when the agent is not a member of the asked Buzz channel (or its npub when that is unknown). */
async function channelMembership(ctx: Ctx, item: AgentItem, asked: NonNullable<AdoptSuggestion["channel"]>): Promise<string | null> {
  const { withAgentMcp } = await import("./tool.ts");
  try {
    return await withAgentMcp(
      ctx,
      async (mcp) => {
        const tools = new Set((await mcp.listTools()).map((t) => t.name));
        if (!tools.has("connect__buzz_identity")) return "The agent has no Connect read access, so it cannot use Buzz yet (owner: tick Connect on the card).";
        const id = (await mcp.callTool("connect__buzz_identity", {})).structuredContent as { npub?: string | null } | undefined;
        const npub = id?.npub ?? null;
        if (!npub) return null;
        const list = tools.has("connect__buzz_channels") ? ((await mcp.callTool("connect__buzz_channels", {})).structuredContent as { channels?: { id?: string; name?: string }[] } | undefined) : undefined;
        const channels = list?.channels ?? [];
        const member = channels.some((c) => (asked.id ? c.id === asked.id : c.name === asked.createName));
        if (member) return `The agent is a member of Buzz channel ${asked.id ?? asked.createName}.`;
        if (!asked.id && !asked.createName) return channels.length ? null : `The agent is in no Buzz channel yet. Owner: add ${npub} to a channel in Buzz.`;
        return `The agent is NOT a member of Buzz channel ${asked.id ?? asked.createName} yet. Owner: add ${npub} to that channel in Buzz (channel admin).`;
      },
      item,
    );
  } catch {
    return null;
  }
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

/** One MCP round trip as the agent: is the bridge reachable, connected/paused, and how many tools are granted. */
export async function probeAgent(ctx: Ctx, item: AgentItem): Promise<{ reachable: boolean; state: string; tools: number | null }> {
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
  return { reachable, state, tools };
}

async function agentStatus(ctx: Ctx): Promise<void> {
  const item = await pickAgent(ctx);
  const { reachable, state, tools } = await probeAgent(ctx, item);
  // C96 §8: is `agent serve` running for this connection, and when did it last poll?
  const sup = await import("./supervise.ts");
  const hb = await sup.readHeartbeat(sup.heartbeatPath(ctx.configDir(), item.con));
  const holder = await sup.readPid(sup.pidPath(ctx.configDir(), item.con));
  let running = false;
  if (holder) {
    try {
      process.kill(holder.pid, 0);
      running = true;
    } catch (e) {
      running = (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  // BRG-02/03 (C151 D): unanswered turns and a refused start, from the heartbeat (else the state file), no log reading
  let health = hb?.health;
  if (!health) {
    try {
      const { readFile } = await import("node:fs/promises");
      const st = JSON.parse(await readFile(join(ctx.configDir(), `agent-serve-${item.con}.json`), "utf8")) as { health?: unknown };
      if (isRecord(st.health)) health = st.health as unknown as typeof health;
    } catch {
      /* no state yet, or unreadable: the refused line says so when serve tried */
    }
  }
  const refused = hb?.refused;
  const serveInfo = { running, ...(holder ? { pid: holder.pid, mode: holder.role } : {}), lastPollAt: hb?.lastPollAt ?? null, phase: hb?.phase ?? null, ...(health ? { health } : {}), ...(refused ? { refused } : {}) };
  ctx.emit(
    { agent: item.agt, connection: item.con, bridge: item.bridgeUrl, reachable, state, tools, serve: serveInfo },
    [
      `agent ${item.agt}`,
      `connection ${item.con}`,
      `bridge ${item.bridgeUrl} (${state})`,
      `tools ${tools ?? "-"}`,
      `serve ${running ? `running (${serveInfo.mode} pid ${serveInfo.pid})` : "not running"}; last poll ${serveInfo.lastPollAt ?? "never"}`,
      ...(refused ? [refusedLine(refused)] : []),
      ...(health ? [healthLine(health)] : []),
    ].join("\n"),
  );
}

const hhmm = (iso: string) => (/T(\d\d:\d\d)/.exec(iso)?.[1] ?? iso).concat("Z");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** BRG-03: the `agent status` line of a refused start. */
export function refusedLine(r: { path: string; reason: string; at: string }): string {
  return `serve refused to start ${hhmm(r.at)}: state file unreadable (${r.path}: ${r.reason}); fix or restore the file, or start serve with --accept-state-loss`;
}

/** BRG-02 (C151 D): the `agent status` line of the unanswered-turn counters. */
export function healthLine(h: { failed: number; uncertain: number; gaveUp: number; routinesSkipped?: number; last?: { at: string; kind: string; tool: string; items: number; code?: string } }): string {
  const parts = [plural(h.failed, "failed turn"), plural(h.uncertain, "uncertain turn"), plural(h.gaveUp, "gave-up item"), ...(h.routinesSkipped ? [`${plural(h.routinesSkipped, "routine run")} skipped (state lost)`] : [])];
  if (!h.failed && !h.uncertain && !h.gaveUp && !h.routinesSkipped) return "unanswered: none";
  const what: Record<string, string> = { failed: "turn failed", uncertain: "turn uncertain (serve restarted during it)", gave_up: "gave up (harness did not start)", routine_skipped: "routine skipped (state lost)" };
  const l = h.last;
  return `unanswered: ${parts.join(", ")}${l ? `; last: ${what[l.kind] ?? l.kind} ${hhmm(l.at)} (${l.tool}${l.items ? `, ${plural(l.items, "item")}` : ""}${l.code ? `, ${l.code}` : ""})` : ""}`;
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
  const sup = await import("./supervise.ts");
  const pidfile = sup.pidPath(ctx.configDir(), item.con);
  // F66: --detach starts `agent serve --supervise` in the background (same as adopt --start) and returns
  if (ctx.v.detach === true) {
    const file = resolve(ctx.v.file as string);
    const started = await startDetached(ctx, { file, agt: item.agt, con: item.con, log: ctx.v.log ? resolve(ctx.v.log) : join(dirname(file), "serve.log"), ...(ctx.v["accept-state-loss"] === true ? { acceptStateLoss: true } : {}) });
    if (!started.pid) throw new CliError(EXIT.unexpected, "internal", "agent serve did not start");
    ctx.emit({ agent: item.agt, connection: item.con, started }, `started agent serve for ${item.agt} (supervisor pid ${started.pid}), log ${started.log}; stop: tealbrick agent stop --agent ${item.agt}`);
    return;
  }
  // F72: --log <file>: the serve log goes there (appended), and the harness's relay appends its retry lines to it
  const logFile = ctx.v.log ? resolve(ctx.v.log) : undefined;
  const { appendFileSync } = await import("node:fs");
  // synchronous appends: a line written just before an exit (stall, stop) is never lost
  const logOut: { write(s: string): unknown } = logFile ? { write: (line: string) => appendFileSync(logFile, line, { mode: 0o600 }) } : ctx.io.stderr;
  const logLine = (event: string, fields: Record<string, unknown> = {}) => logOut.write(`${JSON.stringify({ ts: new Date().toISOString(), event, agent: item.agt, ...fields })}\n`);
  // C96 §8: `--supervise` runs this same command as a child and restarts it (own pidfile, own child only, L20)
  if (ctx.v.supervise === true && ctx.v["supervised-child"] !== true) {
    const args = [process.argv[1] ?? "tealbrick", ...process.argv.slice(2).filter((a) => a !== "--supervise"), "--supervised-child"];
    ctx.say(`supervising agent serve for ${item.agt} (restart with backoff); Ctrl-C to stop`);
    const last = await sup.supervise({ command: process.execPath, args, pidfile, log: logLine });
    if (last === sup.EXIT_STATE_UNREADABLE) throw new CliError(sup.EXIT_STATE_UNREADABLE, "state_unreadable", "agent serve refused to start: its state file is unreadable (see the log line serve.state.unreadable, or tealbrick agent status); fix or restore the file, or start serve with --accept-state-loss");
    return;
  }
  // one loop per connection: a plain serve takes the pidfile (a supervised child runs under its supervisor's)
  const releasePid = ctx.v["supervised-child"] === true ? async () => undefined : await sup.acquirePidfile(pidfile, "serve").catch((e: Error) => {
    throw new CliError(EXIT.validation, "already_running", e.message);
  });
  // BRG-03: read the state BEFORE anything connects. Only "no file yet" is a fresh start; any other read problem refuses
  // to start (exit EXIT_STATE_UNREADABLE, the supervisor does not restart) unless the owner passed --accept-state-loss.
  const statePath = join(ctx.configDir(), `agent-serve-${item.con}.json`);
  const stateFile = serve.fileState(statePath);
  let initialState: Awaited<ReturnType<typeof stateFile.loadState>>;
  try {
    initialState = await stateFile.loadState();
    if (ctx.v["accept-state-loss"] === true) logLine("serve.state.reset_not_needed", { path: statePath });
  } catch (e) {
    if (!(e instanceof serve.StateUnreadableError)) throw e;
    if (ctx.v["accept-state-loss"] !== true) {
      logLine("serve.state.unreadable", { path: e.path, reason: e.reason });
      await sup.writeRefused(sup.heartbeatPath(ctx.configDir(), item.con), { code: "state_unreadable", path: e.path, reason: e.reason, at: new Date(ctx.now()).toISOString() }, ctx.v["supervised-child"] === true ? process.ppid : undefined);
      await releasePid();
      throw new CliError(
        sup.EXIT_STATE_UNREADABLE,
        "state_unreadable",
        `agent serve cannot read its state file ${e.path} (${e.reason}). The file holds the routine ledger and the inbox cursors, so serve does not start with an empty one. Either fix or restore the file and start serve again, or start serve with --accept-state-loss: inboxes then start at the serve start (no backlog) and routine runs due before now are reported uncertain and not run.`,
      );
    }
    // keep the unreadable file for the owner; start fresh but safe (C151 C)
    const { rename } = await import("node:fs/promises");
    const kept = `${statePath}.unreadable-${ctx.now()}`;
    const keptOk = await rename(statePath, kept).then(
      () => true,
      () => false,
    );
    initialState = { ...serve.freshState(), stateLostAt: ctx.now() };
    cfg.backlog = false;
    logLine("serve.state.reset_accepted", { path: statePath, reason: e.reason, ...(keptOk ? { kept } : {}) });
  }
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
    onStatus: (s) => logLine("serve.relay", { status: s }),
    // F72: a re-send during a bridge drain is one log line (tool name, code, Retry-After, attempt)
    onEvent: (event, fields) => logLine(event, fields),
    stdin: toRelay,
    stdout: fromRelay,
  });
  const mcp = connectMcp({ streams: { input: fromRelay, output: toRelay } });
  await mcp.initialize("tealbrick-agent-serve");
  // the harness starts this relay with a filtered env (no TB_*, no XDG_CONFIG_HOME): the store choice travels as argv
  // F77: this install's own node + main.js (absolute), never a bare `tealbrick` or argv[1]
  const base = relayCommand(item.agt, ctx.io.env);
  const relayCmd = { command: base.command, args: [...base.args, ...(logFile ? ["--log-file", logFile] : [])] };
  const configDir = dirname(resolve(ctx.v.file as string));
  const runTurn =
    cfg.harness.kind === "claude"
      ? await serve.claudeRunner(cfg.harness, item.agt, relayCmd, configDir, { log: logLine })
      : cfg.harness.kind === "claude-code"
        ? await serve.claudeCodeRunner(cfg.harness, relayCmd, configDir, { log: logLine })
        : await serve.commandRunner(cfg.harness, [relayCmd.command, ...relayCmd.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" "), { log: logLine });
  const abort = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.once(sig, () => {
      abort.abort();
      // F56: never linger after a stop (open relay sockets, a running turn): release the pidfile and exit within
      // the supervisor's grace, whatever is still in flight
      setTimeout(() => {
        void releasePid().finally(() => process.exit(0));
      }, sup.STOP_GRACE_MS - 1_000).unref();
    });
  // heartbeat for `agent status` + watchdog: a loop that stopped moving exits so its supervisor restarts it
  const live = sup.liveness({
    path: sup.heartbeatPath(ctx.configDir(), item.con),
    pollMs: Math.max(cfg.pollSeconds ?? 20, 5) * 1000,
    turnLimitMs: (cfg.harness.turnTimeoutSeconds ?? 3600) * 1000,
    // F38: a supervised child names its supervisor (the pidfile holder), so --undo can confirm and stop it
    ...(ctx.v["supervised-child"] === true ? { supervisorPid: process.ppid } : {}),
    onStall: () => {
      logLine("serve.stalled");
      void releasePid().finally(() => process.exit(sup.EXIT_STALLED));
    },
  });
  await live.beat("poll");
  ctx.say(`serving agent ${item.agt}: ${cfg.inboxes.length} inbox(es), ${(cfg.routines ?? []).length} routine source(s), harness ${cfg.harness.kind}; Ctrl-C to stop`);
  await serve.serveLoop(
    cfg,
    {
      mcp,
      runTurn,
      loadState: async () => initialState,
      saveState: stateFile.saveState,
      log: logLine,
      sleep: (ms, signal) =>
        new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            r();
          }, { once: true });
        }),
      now: () => Date.now(),
      reconnect: async () => {
        await mcp.initialize("tealbrick-agent-serve");
      },
      heartbeat: (phase) => live.beat(phase),
      health: (h) => live.health(h),
    },
    abort.signal,
  );
  live.stop();
  await releasePid();
  mcp.close();
  relay.stop();
  // F56: keep-alive sockets of the relay must not hold the process for a minute after a clean stop
  setTimeout(() => process.exit(0), 200).unref();
}

/**
 * F66 (and adopt --start): start `agent serve --supervise` detached, its output appended to `log` (0600). One loop per
 * connection: refuses while the connection's pidfile names a live process.
 */
export async function startDetached(ctx: Ctx, o: { file: string; agt: string; con: string; log: string; cwd?: string; acceptStateLoss?: boolean }): Promise<{ pid: number | null; log: string }> {
  const sup = await import("./supervise.ts");
  const held = await sup.readPid(sup.pidPath(ctx.configDir(), o.con));
  if (held && sup.isAlive(held.pid)) throw new CliError(EXIT.conflict, "already_running", `agent serve already runs for ${o.agt} (pid ${held.pid}); stop it with tealbrick agent stop --agent ${o.agt}`);
  const { openSync, closeSync } = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const fd = openSync(o.log, "a", 0o600);
  try {
    // this package's own entry (dist/main.js next to this file; main.ts when run from source), never argv[1]
    const entry = cliEntry();
    const child = spawn(process.execPath, [entry, "agent", "serve", "--file", o.file, "--agent", o.agt, "--supervise", "--log", o.log, ...(o.acceptStateLoss ? ["--accept-state-loss"] : [])], { detached: true, cwd: o.cwd ?? dirname(o.file), stdio: ["ignore", fd, fd], env: ctx.io.env as NodeJS.ProcessEnv });
    child.unref();
    return { pid: child.pid ?? null, log: o.log };
  } finally {
    closeSync(fd);
  }
}

/** F66: stop this connection's serve loop via its own pidfile (L20), and report it only when the process is gone (L28). */
async function agentStop(ctx: Ctx): Promise<void> {
  const item = await pickAgent(ctx);
  const sup = await import("./supervise.ts");
  const r = await sup.stopLoop({ pidfile: sup.pidPath(ctx.configDir(), item.con), heartbeat: sup.heartbeatPath(ctx.configDir(), item.con), nowMs: ctx.now() });
  if (r.left) throw new CliError(EXIT.conflict, "still_running", r.left);
  ctx.emit({ agent: item.agt, connection: item.con, stopped: r.stopped }, r.stopped ? `stopped agent serve of ${item.agt} (pid ${r.stopped})` : `agent serve was not running for ${item.agt}`);
}

export const agent: Handler = async (ctx) => {
  const cmd = requirePos(ctx, 1, "agent command (login|status|serve|stop|logout|list)");
  if (cmd === "serve") return agentServe(ctx);
  if (cmd === "stop") return agentStop(ctx);
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
