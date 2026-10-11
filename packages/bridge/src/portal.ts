/**
 * Outbound-only link to Portal Core (BRIDGE §4–§5): enrolment, signed config long-poll, status report.
 * Every request after enrolment carries a bridge assertion (`TB-Assert`, typ tb-bridge-assert+jwt).
 * Portal never connects in.
 */
import type { AppEntry, EnrolRequest, EnrolResponse, StatusReport, WorkspaceConfig } from "@opt2-tealbrick/spec/bridge";
import { LIFETIME_S, TYP } from "@opt2-tealbrick/spec/credentials";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { isRefusal } from "./api.ts";
import { BRIDGE_VERSION, type BridgeContext, MCP_VERSIONS, SDK_MAJORS } from "./context.ts";
import { remintStandalone } from "./standalone.ts";
import { buildTable, portalKeySet, type Table } from "./table.ts";
import { BridgeError, isRecord, jitter, nowS, sleep } from "./util.ts";

const API = "/api/v1";
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/** BRIDGE §4.1: first start, or re-enrolment when TB_ENROL_CODE changed (§4.3). */
export async function ensureEnrolled(ctx: BridgeContext, enrolCode: string | undefined): Promise<void> {
  const existing = await ctx.state.loadIdentity();
  const codeDigest = enrolCode ? ctx.api.opaqueDigest(enrolCode) : undefined;
  if (existing && (!codeDigest || ctx.api.digestEqual(codeDigest, existing.enrolCodeDigest))) {
    ctx.identity = existing;
    return;
  }
  if (!enrolCode || !codeDigest) throw new BridgeError("not_enrolled", 500, "TB_ENROL_CODE is required for the first start");
  const key = await ctx.api.generateKeyPair();
  const body: EnrolRequest = {
    code: enrolCode,
    publicKey: key.publicJwk,
    version: BRIDGE_VERSION,
    sdkMajors: SDK_MAJORS,
    form: ctx.form,
    publicOrigin: ctx.publicUrl,
  };
  const res = await ctx.fetch(new URL(`${API}/bridge/enrol`, ctx.portalUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new BridgeError("enrol_failed", 502, `Portal refused enrolment (${res.status})`);
  const r = (await res.json()) as EnrolResponse;
  if (!r || typeof r.bridgeId !== "string" || typeof r.workspaceId !== "string" || !Array.isArray(r.portalKeys)) {
    throw new BridgeError("enrol_failed", 502, "malformed enrolment response");
  }
  if (existing && existing.bridgeId !== r.bridgeId) throw new BridgeError("enrol_failed", 502, "Portal returned another bridge id");
  ctx.identity = {
    bridgeId: r.bridgeId,
    workspaceId: r.workspaceId,
    key,
    portalKeys: r.portalKeys,
    enrolCodeDigest: codeDigest,
    configPath: r.configPath,
    ackPath: r.ackPath,
  };
  await ctx.state.saveIdentity(ctx.identity);
  ctx.log.info("bridge.enrolled", { bridge: r.bridgeId, ws: r.workspaceId, reenrol: !!existing });
}

async function portalRequest(ctx: BridgeContext, method: "GET" | "POST", pathAndQuery: string, body?: unknown, timeoutMs = 30_000): Promise<Response> {
  const id = ctx.identity;
  if (!id) throw new BridgeError("not_enrolled", 500);
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
  const now = nowS();
  const ref = ctx.bridgeRef;
  const assertion = await ctx.api.signAssertion(
    TYP.bridgeAssertion,
    { iss: ref, sub: ref, aud: "tb:portal", iat: now, exp: now + LIFETIME_S.proof, jti: ctx.api.ulid() },
    id.key,
    { method, pathAndQuery, ...(raw ? { body: raw } : {}) },
  );
  return ctx.fetch(new URL(pathAndQuery, ctx.portalUrl), {
    method,
    headers: { "TB-Assert": assertion, ...(raw ? { "content-type": "application/json" } : {}) },
    ...(raw ? { body: raw } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function fetchManifestFrom(ctx: BridgeContext, app: AppEntry): Promise<Manifest> {
  const res = await ctx.fetch(new URL("/tb/v1/manifest", app.internalUrl), { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const v = ctx.api.validateManifest(await res.json());
  if (!v.ok) throw new Error("manifest_invalid");
  return v.manifest;
}

/**
 * BRIDGE §5.2 + §5.3: verify a config JWS and swap the routing table. Returns false when the document
 * is dropped (S2 kept). Used for pulled configs and for the S2 reload at boot (`boot: true` allows
 * equal rev and an expired document, which then fails closed per §5.4).
 */
export async function applyConfig(ctx: BridgeContext, jws: string, opts: { boot?: boolean } = {}): Promise<boolean> {
  const id = ctx.identity;
  if (!id) return false;
  const now = nowS();
  if (Buffer.byteLength(jws) > MAX_CONFIG_BYTES) {
    ctx.reject({ kind: "config", code: "payload_too_large" });
    return false;
  }
  const issuers = portalKeySet(ctx.api, id.portalKeys);
  const v = ctx.api.verifyConfig(jws, { now, self: ctx.bridgeRef, issuers });
  if (isRefusal(v)) {
    if (!opts.boot) ctx.reject({ kind: "config", code: v.code });
    // At boot an S2 older than 12 h fails verification on time; load it anyway so person paths work (§5.4).
    if (!opts.boot) return false;
  }
  const body = (isRefusal(v) ? peekBody(jws) : v.body) as WorkspaceConfig | undefined;
  if (!body || !isRecord(body)) return false;
  const current = ctx.table?.rev ?? -1;
  if (body.v !== 1 || body.ws !== id.workspaceId || body.sub !== ctx.bridgeRef || body.aud !== ctx.bridgeRef) {
    ctx.reject({ kind: "config", code: "config_mismatch" });
    return false;
  }
  if (!opts.boot && body.rev <= current) {
    if (body.rev < current) ctx.reject({ kind: "config", code: "rev_lower" });
    return false;
  }
  if (!opts.boot && body.exp <= now) {
    ctx.reject({ kind: "config", code: "config_expired" });
    return false;
  }
  const nextKeys = body.portalKeys.length ? body.portalKeys : id.portalKeys;
  const table: Table = await buildTable({
    api: ctx.api,
    config: body,
    jws,
    bridgeId: id.bridgeId,
    ownKeys: ctx.ownKeySet(),
    issuers: portalKeySet(ctx.api, nextKeys),
    previous: ctx.table,
    fetchManifest: (app) => fetchManifestFrom(ctx, app),
    now,
    reject: (r) => ctx.reject(r),
  });
  if (!opts.boot) ctx.state.saveConfigJws(jws);
  if (body.portalKeys.length && JSON.stringify(nextKeys) !== JSON.stringify(id.portalKeys)) {
    id.portalKeys = nextKeys;
    await ctx.state.saveIdentity(id);
  }
  reconcileConnections(ctx, table);
  ctx.swapTable(table);
  ctx.log.info("bridge.config.applied", { rev: body.rev, apps: body.apps.length, agents: body.agents.length, boot: !!opts.boot });
  // final Portal config with `standalone`: freeze it and become the issuer (BRIDGE §11)
  if (body.standalone) await remintStandalone(ctx);
  return true;
}

function peekBody(jws: string): unknown {
  const p = jws.split(".")[1];
  if (!p) return undefined;
  try {
    return JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * S4 housekeeping after a new config (BRIDGE §5.3, §6): mark locally created pairing connections that
 * the config now lists; drop those the config revoked; drop reported ones Core refused (a config issued
 * after the report omits them).
 */
function reconcileConnections(ctx: BridgeContext, table: Table): void {
  let changed = false;
  for (const [con, rec] of ctx.state.connections) {
    const listed = table.connections.get(con);
    const agentGone = !table.agents.has(rec.agt);
    if ((listed && listed.status === "revoked") || agentGone) {
      ctx.state.connections.delete(con);
      changed = true;
      continue;
    }
    if (listed && !rec.reported) {
      rec.reported = true;
      changed = true;
      continue;
    }
    const reportedAt = reportedAtS.get(con);
    if (!listed && rec.reported) {
      ctx.state.connections.delete(con);
      changed = true;
    } else if (!listed && reportedAt !== undefined && table.config.iat > reportedAt) {
      ctx.state.connections.delete(con);
      changed = true;
    }
  }
  if (changed) ctx.state.saveConnections();
  // pending claims Core now lists in instanceKeys are cleared
  const before = ctx.state.claims.length;
  ctx.state.claims = ctx.state.claims.filter((c) => !table.instanceKeys.has(`${c.ins}|${c.service ?? ""}`));
  if (ctx.state.claims.length !== before) ctx.state.saveClaims();
}

/** con → epoch s of the status report that first carried it (memory; re-reported after restart). */
const reportedAtS = new Map<string, number>();

/** BRIDGE §5.6. */
export function buildStatusReport(ctx: BridgeContext): StatusReport {
  const t = ctx.table;
  const id = ctx.identity;
  if (!id) throw new Error("not enrolled");
  const now = nowS();
  const apps: StatusReport["apps"] = (t ? [...t.apps.values()] : []).map((a) => {
    const h = ctx.health.get(a.entry.ins);
    const claimed = !!t?.instanceKeys.has(`${a.entry.ins}|`);
    const stale = !h || now - h.lastSeen > 150;
    const state: StatusReport["apps"][number]["state"] = t?.pausedInstances.has(a.entry.ins)
      ? "paused"
      : !claimed
        ? "unclaimed"
        : a.down || stale
          ? "down"
          : h.status.readiness === "needs_keys"
            ? "needs_keys"
            : h.status.readiness === "degraded"
              ? "degraded"
              : "ok";
    return {
      ins: a.entry.ins,
      state,
      version: h?.status.version ?? null,
      sdkVersion: h?.status.sdkVersion ?? null,
      manifestDigest: a.manifest ? a.entry.manifestDigest : null,
      lastSeen: h ? new Date(h.lastSeen * 1000).toISOString() : null,
      pendingHolds: h?.status.pendingHolds ?? 0,
    };
  });
  const keys = (t?.config.keyRequirements ?? [])
    .filter((k) => k.source === "account_default")
    .map((k) => ({ name: k.name, ins: k.ins, set: Object.hasOwn(ctx.state.keyStore.values, k.name) }));
  const connectionsCreated = [...ctx.state.connections.values()]
    .filter((r) => !r.reported)
    .map((r) => {
      if (!reportedAtS.has(r.con)) reportedAtS.set(r.con, now);
      return { con: r.con, agt: r.agt, method: "pairing" as const, clientName: r.clientName, createdAt: new Date(r.createdAt * 1000).toISOString(), pairingJti: pairingJtis.get(r.con) ?? "" };
    });
  return {
    rev: t?.rev ?? 0,
    appliedAt: new Date().toISOString(),
    bridge: { id: id.bridgeId, version: BRIDGE_VERSION, form: ctx.form, boot: ctx.boot, sdkMajors: SDK_MAJORS, mcpVersions: MCP_VERSIONS },
    portalReachable: ctx.portalReachable(now),
    apps,
    keys,
    scopeSummaries: [...ctx.scopeSummaries.values()],
    connectionsCreated,
    connectionsRevoked: ctx.connectionsRevoked,
    claims: ctx.state.claims.map(({ reported: _r, ...c }) => c),
    rejected: [...ctx.rejected.entries()].map(([k, count]) => {
      const [kind, code] = k.split("|") as [StatusReport["rejected"][number]["kind"], string];
      return { kind, code, count };
    }),
    toolsOmitted: [...ctx.toolsOmitted.values()],
  };
}

/** Pairing-code jti per locally created connection (reported once). */
export const pairingJtis = new Map<string, string>();

export async function sendStatus(ctx: BridgeContext): Promise<void> {
  if (!ctx.identity || ctx.table?.standalone) return;
  const report = buildStatusReport(ctx);
  try {
    const res = await portalRequest(ctx, "POST", ctx.identity.ackPath, report);
    if (res.ok) {
      ctx.connectionsRevoked = [];
      ctx.rejected.clear();
    }
    await res.body?.cancel().catch(() => undefined);
  } catch {
    ctx.log.warn("bridge.status.failed", { code: "portal_unreachable" });
  }
}

/** Debounced status sender: after each applied rev, on content change (2 s) and every 5 min (§5.6). */
export function startStatusLoop(ctx: BridgeContext, signal: AbortSignal): { poke(): void } {
  let timer: NodeJS.Timeout | undefined;
  let lastDigest = "";
  const fire = async () => {
    timer = undefined;
    if (signal.aborted || !ctx.identity) return;
    const r = buildStatusReport(ctx);
    const { appliedAt: _a, ...stable } = r;
    const d = ctx.api.digest(stable as never);
    if (d === lastDigest && !(ctx.connectionsRevoked.length || ctx.rejected.size)) return;
    lastDigest = d;
    await sendStatus(ctx);
  };
  const poke = () => {
    if (!timer && !signal.aborted) timer = setTimeout(fire, 2_000);
  };
  const periodic = setInterval(() => {
    lastDigest = "";
    poke();
  }, 300_000);
  signal.addEventListener("abort", () => {
    clearInterval(periodic);
    if (timer) clearTimeout(timer);
  });
  ctx.on("table", poke);
  return { poke };
}

/** BRIDGE §5.1: long-poll loop. Errors never extend or replace S2. */
export async function runConfigLoop(ctx: BridgeContext, signal: AbortSignal): Promise<void> {
  let backoff = 15_000;
  while (!signal.aborted) {
    if (ctx.table?.standalone) return;
    const id = ctx.identity;
    if (!id) return;
    const after = ctx.table?.rev ?? 0;
    try {
      const res = await portalRequest(ctx, "GET", `${id.configPath}?after=${after}&wait=60`, undefined, 75_000);
      if (res.status === 304) {
        ctx.lastPull = nowS();
        backoff = 15_000;
        continue;
      }
      if (res.status === 200) {
        const jws = (await res.text()).trim();
        ctx.lastPull = nowS();
        backoff = 15_000;
        await applyConfig(ctx, jws);
        continue;
      }
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(Math.max(ra, 30), 900) * 1000 : 30_000;
        await sleep(wait, signal);
        continue;
      }
      ctx.log.warn("bridge.config.pull_failed", { code: `http_${res.status}` });
    } catch {
      ctx.log.warn("bridge.config.pull_failed", { code: "network" });
    }
    await sleep(jitter(backoff), signal);
    backoff = Math.min(backoff * 2, 240_000);
  }
}
