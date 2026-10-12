/**
 * Internal listener (private network only, BRIDGE §3.2): app claim, status push + slice/keys
 * long-poll, key fetch, app→app companion call, metrics. Callers prove themselves with instance
 * assertions (`TB-Assert`, typ tb-instance-assert+jwt, bound to method, path and body).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppStatus, AppStatusResponse, CallEnvelope, ClaimRequest, ClaimResponse, KeyFetchResponse } from "@opt2-tealbrick/spec/bridge";
import { type InstanceAssertionClaims, type InstanceId, LIFETIME_S, TYP } from "@opt2-tealbrick/spec/credentials";
import type { KeyRequirement, Manifest } from "@opt2-tealbrick/spec/manifest";
import { isRefusal, type Json, type KeySet } from "./api.ts";
import type { CallRouter } from "./calls.ts";
import { type BridgeContext, SDK_CURRENT_MAJOR } from "./context.ts";
import type { AppRuntime, Table } from "./table.ts";
import { BridgeError, envelope, headerValue, isRecord, nowS, parseJson, readBody, sendError, sendJson, statusFor } from "./util.ts";

interface InstanceCaller {
  ins: InstanceId;
  svc: string | undefined;
}

export class InternalApi {
  private readonly ctx: BridgeContext;
  private readonly router: CallRouter;
  private readonly seenJtis = new Map<string, number>();
  private readonly waiters = new Set<() => void>();

  constructor(ctx: BridgeContext, router: CallRouter) {
    this.ctx = ctx;
    this.router = router;
    ctx.on("table", () => this.wake());
    ctx.on("keys", () => this.wake());
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Verifies the instance assertion against config `instanceKeys` or a pending claim (S5). */
  private assertCaller(req: IncomingMessage, body: Buffer): InstanceCaller {
    const token = headerValue(req, "tb-assert") ?? "";
    const parts = token.split(".");
    let peek: Partial<InstanceAssertionClaims> = {};
    try {
      peek = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    } catch {
      throw new BridgeError("unauthenticated", 401);
    }
    const ins = typeof peek.iss === "string" && peek.iss.startsWith("tb:ins:") ? (peek.iss.slice(7) as InstanceId) : undefined;
    if (!ins) throw new BridgeError("unauthenticated", 401);
    const svc = typeof peek.svc === "string" ? peek.svc : undefined;
    const keys = this.keysFor(ins, svc);
    if (!keys) throw new BridgeError("unauthenticated", 401);
    const now = nowS();
    const v = this.ctx.api.verifyAssertion<InstanceAssertionClaims>(token, keys, {
      typ: TYP.instanceAssertion,
      aud: this.ctx.bridgeRef,
      iss: [`tb:ins:${ins}`],
      now,
      maxLifetimeS: LIFETIME_S.proof,
      request: { method: req.method ?? "GET", pathAndQuery: req.url ?? "/", ...(body.length ? { body } : {}) },
    });
    if (isRefusal(v) || (v.claims.svc ?? undefined) !== svc) {
      this.ctx.reject({ kind: "assertion", code: "invalid_token" });
      throw new BridgeError("unauthenticated", 401);
    }
    for (const [k, e] of this.seenJtis) if (e <= now) this.seenJtis.delete(k);
    if (this.seenJtis.has(v.claims.jti)) throw new BridgeError("unauthenticated", 401);
    this.seenJtis.set(v.claims.jti, v.claims.exp + 30);
    return { ins, svc };
  }

  private keysFor(ins: InstanceId, svc: string | undefined): KeySet | undefined {
    const listed = this.ctx.table?.instanceKeys.get(`${ins}|${svc ?? ""}`);
    if (listed) return listed;
    const pending = this.ctx.state.claims.find((c) => c.ins === ins && (c.service ?? undefined) === svc);
    return pending ? this.ctx.api.keySetFrom({ keys: [pending.publicKey] }, `tb:ins:${ins}`) : undefined;
  }

  private paused(ins: InstanceId): boolean {
    const t = this.ctx.table;
    return !!t && (t.pausedWorkspace || t.pausedInstances.has(ins));
  }

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    try {
      if (req.method === "POST" && url.pathname === "/tb/v1/claim") return await this.claim(req, res);
      if (req.method === "POST" && url.pathname === "/tb/v1/status") return await this.status(req, res, url);
      if (req.method === "GET" && url.pathname.startsWith("/tb/v1/keys/")) return await this.keyFetch(req, res, decodeURIComponent(url.pathname.slice(12)));
      if (req.method === "POST" && url.pathname === "/tb/v1/call") return await this.companionCall(req, res, requestId);
      if (req.method === "GET" && url.pathname === "/metrics") return this.metrics(res);
      sendJson(res, 404, envelope("not_found", "not found", requestId));
    } catch (e) {
      if (e instanceof BridgeError && e.status === 400 && statusFor(e.code) !== 400) return sendError(res, new BridgeError(e.code, statusFor(e.code), e.message), requestId);
      const retry: Record<string, string> = e instanceof BridgeError && e.status === 503 ? { "retry-after": "5" } : {};
      sendError(res, e, requestId, retry);
    }
  }

  // ── §10.1 claim ──
  private async claim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = this.ctx;
    const t = ctx.table;
    const id = ctx.identity;
    if (!t || !id) throw new BridgeError("app_unavailable", 503, "bridge has no config yet");
    const body = parseJson(await readBody(req, 64 * 1024));
    if (!isRecord(body)) throw new BridgeError("input_invalid", 400);
    const r = body as unknown as ClaimRequest;
    if (typeof r.code !== "string" || !r.instancePublicKey || typeof r.manifestDigest !== "string") throw new BridgeError("input_invalid", 400);
    const codeDigest = ctx.api.opaqueDigest(r.code);
    const now = nowS();
    const entry = t.config.enrolCodes.find((e) => ctx.api.digestEqual(e.digest, codeDigest) && e.exp > now);
    if (!entry || ctx.state.claims.some((c) => ctx.api.digestEqual(c.codeDigest, codeDigest))) {
      ctx.reject({ kind: "claim", code: "code_invalid" });
      throw new BridgeError("code_invalid", 403);
    }
    if (typeof r.sdkVersion !== "string" || !ctx.api.sdkMajorServed(r.sdkVersion, SDK_CURRENT_MAJOR)) throw new BridgeError("sdk_major_unsupported", 400);
    const service = entry.kind === "service" ? entry.service : undefined;
    if ((r.service ?? undefined) !== service) throw new BridgeError("code_invalid", 403);
    const app = t.apps.get(entry.ins);
    let manifest: Manifest | undefined = app?.manifest;
    let internalUrl: string | undefined;
    if (entry.kind === "neighbour") {
      if (typeof r.internalUrl !== "string") throw new BridgeError("input_invalid", 400, "internalUrl required for neighbours");
      internalUrl = new URL(r.internalUrl).origin;
      const res2 = await ctx.fetch(new URL("/tb/v1/manifest", internalUrl), { redirect: "error", signal: AbortSignal.timeout(10_000) });
      const v = ctx.api.validateManifest(await res2.json());
      if (!v.ok || v.digest !== r.manifestDigest) throw new BridgeError("manifest_mismatch", 409);
      manifest = v.manifest;
    } else if (!app || app.entry.manifestDigest !== r.manifestDigest) {
      throw new BridgeError("manifest_mismatch", 409);
    }
    // Build the COMPLETE answer first; record the claim and consume the one-time code only when it is complete.
    const out: ClaimResponse = { ins: entry.ins, bridge: { id: id.bridgeId, publicKey: id.key.publicJwk, internalUrl: ctx.internalUrl } };
    const keyListed = t.instanceKeys.has(`${entry.ins}|${service ?? ""}`);
    if (keyListed && app && !service) out.slice = app.entry.slice;
    if (service) {
      // the app's key: listed by Core, or the app's own claim pending at this bridge (S5)
      const appKey =
        t.config.instanceKeys.find((k) => k.ins === entry.ins && !k.svc)?.jwk ??
        ctx.state.claims.find((c) => c.ins === entry.ins && c.service === undefined)?.publicKey;
      if (!appKey) {
        // companions may start before their app (startOrder): retryable, code NOT consumed
        throw new BridgeError("app_not_claimed", 503, "the app instance has not claimed yet; retry");
      }
      if (!manifest) throw new BridgeError("app_unavailable", 503, "the app manifest is not available yet; retry");
      out.app = { publicKey: appKey };
      out.serviceKeys = activeKeys(t, entry.ins, manifest, service).map((k) => ({ name: k.name, env: k.name }));
    }
    ctx.state.claims.push({
      kind: entry.kind,
      ins: entry.ins,
      ...(service ? { service } : {}),
      publicKey: r.instancePublicKey,
      manifestDigest: r.manifestDigest,
      version: r.version,
      ...(internalUrl ? { internalUrl } : {}),
      codeDigest,
      claimedAt: new Date().toISOString(),
      reported: false,
    });
    ctx.state.saveClaims();
    ctx.emit("claim");
    ctx.log.info("bridge.claim", { ins: entry.ins, kind: entry.kind, ...(service ? { svc: service } : {}) });
    sendJson(res, 200, out);
  }

  // ── §10.3 status + slice/keys long-poll ──
  private async status(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const raw = await readBody(req, 16 * 1024);
    const caller = this.assertCaller(req, raw);
    const body = parseJson(raw) as AppStatus;
    if (!isRecord(body) || typeof body.readiness !== "string") throw new BridgeError("input_invalid", 400);
    const ctx = this.ctx;
    if (!caller.svc) {
      const prev = ctx.health.get(caller.ins);
      ctx.health.set(caller.ins, { status: body, lastSeen: nowS() });
      if (!prev || prev.status.scopesRev !== body.scopesRev) void this.refreshScopeSummary(caller.ins);
      if (!prev || prev.status.readiness !== body.readiness || prev.status.pendingHolds !== body.pendingHolds) ctx.emit("health");
    }
    const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 0) || 0, 0), 60);
    const answer = (): AppStatusResponse | undefined => {
      const app = ctx.table?.apps.get(caller.ins);
      if (!app) return undefined;
      const sliceRev = sliceRevision(app);
      const keysRev = ctx.state.keyStore.keysRev;
      if (sliceRev !== body.sliceRevision || keysRev !== body.keysRev) return { slice: app.entry.slice, sliceRevision: sliceRev, keysRev };
      return undefined;
    };
    const now = answer();
    if (now || wait === 0) {
      if (now) sendJson(res, 200, now);
      else res.writeHead(204).end();
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const check = () => {
        const a = answer();
        if (a) {
          sendJson(res, 200, a);
          finish();
        }
      };
      const timer = setTimeout(() => {
        if (!res.headersSent) res.writeHead(204).end();
        finish();
      }, wait * 1000);
      this.waiters.add(check);
      req.on("close", finish);
    });
  }

  private async refreshScopeSummary(ins: InstanceId): Promise<void> {
    const app = this.ctx.table?.apps.get(ins);
    if (!app || this.paused(ins)) return;
    try {
      const list = await this.router.bridgeOp<{ agent: `agt_${string}`; label: string }[]>(app, "scope_summary", {});
      for (const k of [...this.ctx.scopeSummaries.keys()]) if (k.endsWith(`|${ins}`)) this.ctx.scopeSummaries.delete(k);
      for (const s of Array.isArray(list) ? list : []) {
        if (typeof s?.agent !== "string" || typeof s.label !== "string") continue;
        this.ctx.scopeSummaries.set(`${s.agent}|${ins}`, { agt: s.agent, ins, label: s.label.slice(0, 80) });
      }
      this.ctx.emit("health");
    } catch {
      this.ctx.log.warn("bridge.scope_summary.failed", { ins, code: "app_error" });
    }
  }

  // ── §9.4 key fetch ──
  private async keyFetch(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const caller = this.assertCaller(req, Buffer.alloc(0));
    const t = this.ctx.table;
    if (!t) throw new BridgeError("app_unavailable", 503);
    if (this.paused(caller.ins)) throw new BridgeError("paused", 403);
    const app = t.apps.get(caller.ins);
    const user = caller.svc ?? "app";
    const declared = activeKeys(t, caller.ins, app?.manifest, user).find((k) => k.name === name && k.source === "account_default");
    if (!declared) throw new BridgeError("key_not_declared", 403);
    const value = this.ctx.state.keyStore.values[name];
    if (value === undefined) throw new BridgeError("key_not_set", 404);
    const out: KeyFetchResponse = { name, value, keysRev: this.ctx.state.keyStore.keysRev };
    sendJson(res, 200, out);
  }

  // ── §8.3 companion (app→app) ──
  private async companionCall(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const raw = await readBody(req, 2 * 1024 * 1024);
    const caller = this.assertCaller(req, raw);
    if (caller.svc) throw new BridgeError("unauthenticated", 401, "services cannot make companion calls");
    const t = this.ctx.table;
    if (!t) throw new BridgeError("config_expired", 503);
    if (this.ctx.configExpired()) throw new BridgeError("config_expired", 503);
    if (this.paused(caller.ins)) throw new BridgeError("paused", 403);
    const grant = headerValue(req, "tb-grant");
    if (!grant) throw new BridgeError("no_grant", 403);
    const env = parseJson(raw) as CallEnvelope;
    if (!isRecord(env) || typeof env.target !== "string" || typeof env.op !== "string") throw new BridgeError("input_invalid", 400);
    const app: AppRuntime | undefined = t.appsByProduct.get(env.target);
    if (!app) throw new BridgeError("unknown_tool", 404);
    if (app.down || !app.manifest) throw new BridgeError("app_unavailable", 503, "the target app is starting; retry");
    const op = app.ops.get(env.op);
    if (!op) throw new BridgeError("unknown_tool", 404);
    try {
      const { result } = await this.router.route({
        caller: { type: "app", ins: caller.ins, grant },
        target: { app, op, ...(op.standard || !op.dynamic ? {} : isRecord(env.input) && typeof env.input.tool === "string" ? { tool: env.input.tool } : {}) },
        input: (env.input ?? {}) as Json,
        ...(env.idempotencyKey ? { idempotencyKey: env.idempotencyKey } : {}),
        ...(env.parentCall ? { parentCall: env.parentCall } : {}),
      });
      sendJson(res, result.status === "held" ? 202 : 200, result);
    } catch (e) {
      const code = e instanceof BridgeError ? e.code : "app_error";
      sendJson(res, e instanceof BridgeError && e.status !== 400 ? e.status : statusFor(code), envelope(code, e instanceof Error ? e.message : code, requestId));
    }
  }

  private metrics(res: ServerResponse): void {
    const lines: string[] = [];
    const t = this.ctx.table;
    lines.push(`tb_bridge_config_rev ${t?.rev ?? 0}`);
    lines.push(`tb_bridge_config_age_seconds ${t ? nowS() - t.config.iat : -1}`);
    lines.push(`tb_bridge_portal_reachable ${this.ctx.portalReachable() ? 1 : 0}`);
    for (const [k, v] of this.router.counters) {
      const [kind, a, b] = k.split("|");
      if (kind === "call") lines.push(`tb_bridge_calls_total{product="${a}",code="${b}"} ${v}`);
      if (kind === "hook") lines.push(`tb_bridge_hook_calls_total{hook="${a}",result="${b}"} ${v}`);
    }
    for (const [k, v] of this.ctx.rejected) {
      const [kind, code] = k.split("|");
      lines.push(`tb_bridge_rejected_total{kind="${kind}",code="${code}"} ${v}`);
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(`${lines.join("\n")}\n`);
  }
}

/**
 * Active key requirements of one instance for one user (`app` or a service id). The ONE `when`
 * evaluation is Core's (`activeKeyRequirements` + `resolveSettings` against the instance settings),
 * delivered as config `keyRequirements[]`; the bridge never sees settings (S6), so it does not
 * re-evaluate `when`. A requirement counts only if the verified manifest also declares it.
 */
export function activeKeys(t: Table, ins: InstanceId, manifest: Manifest | undefined, user: string): KeyRequirement[] {
  const declared = new Map((manifest?.settings?.keys ?? []).map((k) => [k.name, k]));
  const out: KeyRequirement[] = [];
  for (const r of t.config.keyRequirements) {
    if (r.ins !== ins || !r.usedBy.includes(user)) continue;
    const k = declared.get(r.name);
    if (k?.usedBy.includes(user) && k.source === r.source) out.push(k);
  }
  return out;
}

/** Slice `rev` (from the slice payload) is the revision apps compare. */
export function sliceRevision(app: AppRuntime): number {
  try {
    const p = JSON.parse(Buffer.from(app.entry.slice.split(".")[1] ?? "", "base64url").toString("utf8")) as { rev?: number };
    return typeof p.rev === "number" ? p.rev : 0;
  } catch {
    return 0;
  }
}
