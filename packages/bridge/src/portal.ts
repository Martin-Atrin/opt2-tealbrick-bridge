/**
 * Outbound-only link to Portal Core (BRIDGE §4–§5): enrolment, signed config long-poll, status report.
 * Every request after enrolment carries a bridge assertion (`TB-Assert`, typ tb-bridge-assert+jwt).
 * Portal never connects in.
 */
import type { AppEntry, EnrolRequest, EnrolResponse, StatusReport, WorkspaceConfig } from "@opt2-tealbrick/spec/bridge";
import { LIFETIME_S, TYP } from "@opt2-tealbrick/spec/credentials";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { isRefusal, type Json } from "./api.ts";
import { BRIDGE_VERSION, type BridgeContext, MCP_VERSIONS, SDK_MAJORS } from "./context.ts";
import { remintStandalone } from "./standalone.ts";
import { buildTable, internalUrlAllowed, portalKeySet, type Table } from "./table.ts";
import { BridgeError, isRecord, jitter, nowS, sleep } from "./util.ts";

const API = "/api/v1";
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
/** Pause between pulls after a refused config document (tight-loop guard). */
export const REFUSED_PULL_DELAY_MS = 5_000;
/** Minimum spacing of config pulls (BSD-09); a long-poll normally takes up to 60 s anyway. */
export const MIN_PULL_INTERVAL_MS = 5_000;

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

async function portalRequest(ctx: BridgeContext, method: "GET" | "POST", pathAndQuery: string, body?: unknown, timeoutMs = 30_000, abort?: AbortSignal): Promise<Response> {
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
    signal: abort ? AbortSignal.any([abort, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
}

/**
 * C57: an app whose manifest could not be fetched during a config apply (e.g. restarting after an update) is
 * retried in the background with backoff (2 s → 60 s), independent of config revisions. A new manifestDigest in
 * a later config is a new retry key (refetch). On success the runtime entry in the CURRENT table is filled in
 * place and listeners are told (MCP tool lists refresh, list_changed).
 */
export function startManifestRetry(ctx: BridgeContext, signal: AbortSignal): void {
  const attempts = new Map<string, { at: number; delay: number }>();
  let running = false;
  const tick = async () => {
    const t = ctx.table;
    if (!t || signal.aborted || running) return;
    running = true;
    let fixed = false;
    try {
      for (const app of t.apps.values()) {
        if (!app.down || app.refused) continue;
        const key = `${app.entry.ins}|${app.entry.manifestDigest}`;
        const a = attempts.get(key) ?? { at: 0, delay: 2_000 };
        if (Date.now() < a.at) continue;
        try {
          const m = await fetchManifestFrom(ctx, app.entry);
          const got = ctx.api.manifestDigest(m);
          if (got !== app.entry.manifestDigest) throw new ManifestError("manifest_mismatch", got);
          app.manifest = m;
          app.ops = new Map(ctx.api.withStandardOps(m).map((op) => [op.id, op]));
          app.scopeTypes = (m.scopes ?? []).map((sc) => sc.type);
          app.down = false;
          attempts.delete(key);
          fixed = true;
          ctx.log.info("bridge.manifest.recovered", { ins: app.entry.ins });
        } catch (e) {
          const next = Math.min(a.delay * 2, 60_000);
          attempts.set(key, { at: Date.now() + a.delay, delay: next });
          logManifestFailure(ctx, app.entry, e);
        }
      }
    } finally {
      running = false;
    }
    if (fixed && ctx.table === t) ctx.emit("table", t, t);
  };
  const timer = setInterval(() => void tick(), 1_000);
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer));
}

export class ManifestError extends Error {
  readonly served: string | undefined;
  constructor(code: string, served?: string) {
    super(code);
    this.served = served;
  }
}

/** One line per app + reason per minute: fetch failure vs digest mismatch (with both digests — public values). */
export function logManifestFailure(ctx: BridgeContext, app: AppEntry, e: unknown): void {
  const mismatch = e instanceof ManifestError && e.message === "manifest_mismatch";
  ctx.log.warn("bridge.manifest.unavailable", {
    ins: app.ins,
    product: app.product,
    code: mismatch ? "manifest_mismatch" : e instanceof ManifestError ? e.message : "fetch_failed",
    expected: app.manifestDigest,
    ...(mismatch ? { served: (e as ManifestError).served } : {}),
  });
}

async function fetchManifestFrom(ctx: BridgeContext, app: AppEntry): Promise<Manifest> {
  const res = await ctx.fetch(new URL("/tb/v1/manifest", app.internalUrl), { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new ManifestError(`fetch_http_${res.status}`);
  const v = ctx.api.validateManifest(await res.json());
  if (!v.ok) throw new ManifestError("manifest_invalid");
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
  // BSD-03: the boot copy (S2 on the volume) is verified with the TRUSTED set like any pulled document; the ONLY
  // waived check is time (an S2 older than 12 h still loads, and then fails closed for calls, §5.4). A document
  // that fails any other check (signature, unknown kid, audience, workspace) is not loaded at all.
  const peekedExp = (peekBody(jws) as { exp?: unknown } | undefined)?.exp;
  const verifyNow = opts.boot && typeof peekedExp === "number" ? Math.min(now, peekedExp - 1) : now;
  const v = ctx.api.verifyConfig(jws, { now: verifyNow, self: ctx.bridgeRef, issuers });
  if (isRefusal(v)) {
    ctx.reject({ kind: "config", code: v.code, detail: `${v.reason}; rev ${peekRev(jws)}; trusted ${id.portalKeys.length}${opts.boot ? "; boot copy refused" : ""}` });
    return false;
  }
  const body = v.body as WorkspaceConfig | undefined;
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
    internalUrlAllowed: (u) => internalUrlAllowed(u, ctx.form, ctx.appHosts),
    onManifestFailure: (app, e) => logManifestFailure(ctx, app, e),
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

function peekRev(jws: string): number | undefined {
  const b = peekBody(jws) as { rev?: unknown } | undefined;
  return typeof b?.rev === "number" ? b.rev : undefined;
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
      if (ctx.state.reports.pairingJtis[con] !== undefined) {
        delete ctx.state.reports.pairingJtis[con];
        ctx.state.saveReports();
      }
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
/**
 * C62 BSD-08/BSD-15 (Core REQUESTS): two additive fields Core reads when present. Not yet in spec 0.1.2's
 * StatusReport type (requested from Specs); remove this extension when the spec carries them.
 */
export type StatusReportV12 = Omit<StatusReport, "apps"> & {
  /** JCS digest of the portalKeys array the bridge trusts after applying `rev` */
  portalKeysDigest: string;
  apps: (StatusReport["apps"][number] & { sliceRevision?: number })[];
};

export function buildStatusReport(ctx: BridgeContext): StatusReportV12 {
  const t = ctx.table;
  const id = ctx.identity;
  if (!id) throw new Error("not enrolled");
  const now = nowS();
  const apps: StatusReportV12["apps"] = (t ? [...t.apps.values()] : []).map((a) => {
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
      // the slice revision the app last reported it holds (AppStatus.sliceRevision); omitted before its first report
      ...(typeof h?.status.sliceRevision === "number" ? { sliceRevision: h.status.sliceRevision } : {}),
    };
  });
  const keys = (t?.config.keyRequirements ?? [])
    .filter((k) => k.source === "account_default")
    .map((k) => ({ name: k.name, ins: k.ins, set: Object.hasOwn(ctx.state.keyStore.values, k.name) }));
  const connectionsCreated = [...ctx.state.connections.values()]
    .filter((r) => !r.reported)
    .map((r) => {
      if (!reportedAtS.has(r.con)) reportedAtS.set(r.con, now);
      return { con: r.con, agt: r.agt, method: "pairing" as const, clientName: r.clientName, createdAt: new Date(r.createdAt * 1000).toISOString(), pairingJti: ctx.state.reports.pairingJtis[r.con] ?? "" };
    });
  return {
    rev: t?.rev ?? 0,
    appliedAt: new Date().toISOString(),
    bridge: { id: id.bridgeId, version: BRIDGE_VERSION, form: ctx.form, boot: ctx.boot, sdkMajors: SDK_MAJORS, mcpVersions: MCP_VERSIONS },
    portalReachable: ctx.portalReachable(now),
    portalKeysDigest: ctx.api.digest(id.portalKeys as unknown as Json),
    apps,
    keys,
    scopeSummaries: [...ctx.scopeSummaries.values()],
    connectionsCreated,
    connectionsRevoked: [...ctx.state.reports.revoked],
    claims: ctx.state.claims.map(({ reported: _r, ...c }) => c),
    rejected: [...ctx.rejected.entries()].map(([k, count]) => {
      const [kind, code] = k.split("|") as [StatusReport["rejected"][number]["kind"], string];
      return { kind, code, count };
    }),
    toolsOmitted: [...ctx.toolsOmitted.values()],
  };
}


export async function sendStatus(ctx: BridgeContext): Promise<boolean> {
  if (!ctx.identity || ctx.table?.standalone) return true;
  const report = buildStatusReport(ctx);
  try {
    const res = await portalRequest(ctx, "POST", ctx.identity.ackPath, report);
    if (res.ok) {
      // Portal recorded the revocations it was told about (BSD-11: kept on the volume until then)
      if (ctx.state.reports.revoked.length) {
        const sent = new Set(report.connectionsRevoked.map((r) => r.con));
        ctx.state.reports.revoked = ctx.state.reports.revoked.filter((r) => !sent.has(r.con));
        ctx.state.saveReports();
      }
      ctx.rejected.clear();
    } else ctx.log.warn("bridge.status.failed", { code: `http_${res.status}` });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    ctx.log.warn("bridge.status.failed", { code: "portal_unreachable" });
    return false;
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
    if (d === lastDigest && !(ctx.state.reports.revoked.length || ctx.rejected.size)) return;
    lastDigest = d;
    if (await sendStatus(ctx)) {
      retryMs = 15_000;
      return;
    }
    // a report Portal did not receive is retried (revocations and claims must arrive, BSD-11)
    lastDigest = "";
    if (!timer && !signal.aborted) timer = setTimeout(fire, retryMs);
    retryMs = Math.min(retryMs * 2, 300_000);
  };
  let retryMs = 15_000;
  const poke = () => {
    if (!timer && !signal.aborted) timer = setTimeout(fire, 2_000);
  };
  // first report right after start (the boot config was applied before this loop listened)
  poke();
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
    const started = Date.now();
    // BSD-09: whatever the answer, never pull more than once per ~5 s (a Portal or proxy that ignores `wait`
    // would otherwise make every bridge loop signed requests at network speed)
    const pace = async () => {
      if (Date.now() - started < MIN_PULL_INTERVAL_MS) await sleep(jitter(MIN_PULL_INTERVAL_MS), signal);
    };
    try {
      const res = await portalRequest(ctx, "GET", `${id.configPath}?after=${after}&wait=60`, undefined, 75_000, signal);
      if (res.status === 304) {
        ctx.lastPull = nowS();
        backoff = 15_000;
        await pace();
        continue;
      }
      if (res.status === 200) {
        const jws = (await res.text()).trim();
        ctx.lastPull = nowS();
        backoff = 15_000;
        const sameRev = peekRev(jws) === ctx.table?.rev;
        const applied = await applyConfig(ctx, jws);
        // A refused document would be served again at once (`after` is unchanged): wait before the next pull
        // instead of re-pulling it in a tight loop. Pause/revoke in the next valid revision is still picked up ≤ ~6 s.
        // A document with the revision we already run is a no-op, not a refusal: only a short pause.
        if (!applied && !sameRev) await sleep(jitter(REFUSED_PULL_DELAY_MS), signal);
        else await pace();
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
