/**
 * OAuth authorization server for the bridge's own MCP resource (C4, BRIDGE §6):
 * RFC 9728 / RFC 8414 metadata, stateless DCR (RFC 7591), authorize page with "Approve in Portal"
 * (path A) and paste-code fallback (path B), PKCE S256, token endpoint (authorization_code,
 * refresh_token with rotation, jwt-bearer for key connections), revoke (RFC 7009).
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DcrResponse, PairingConnectionRecord, ProtectedResourceMetadata, TokenResponse } from "@opt2-tealbrick/spec/bridge";
import {
  type AgentAssertionClaims,
  type AgentId,
  type ConnectionId,
  LIFETIME_S,
  OAUTH_GRANT_TYPES,
  type PairingCodeClaims,
  type SealedBlob,
  TYP,
} from "@opt2-tealbrick/spec/credentials";
import { isRefusal } from "./api.ts";
import type { BridgeContext } from "./context.ts";
import { connectionState, issueAccess, revokeLocal, rotateRefresh } from "./identity.ts";
import { pairingJtis } from "./portal.ts";
import { BridgeError, clientIp, isRecord, nowS, RateLimiter, readBody, sendJson } from "./util.ts";

interface ClientReg {
  redirect_uris: string[];
  client_name: string;
  iat: number;
}

interface PendingAuth {
  rid: string;
  client: ClientReg;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  exp: number;
}

interface AuthCode {
  con: ConnectionId;
  agt: AgentId;
  gen: number;
  clientId: string;
  redirectUri: string;
  challenge: string;
  exp: number;
}

const CLIENT_AAD = "tb:seal:oauth-client:v1";

export class OAuthServer {
  private readonly ctx: BridgeContext;
  private readonly pending = new Map<string, PendingAuth>();
  private readonly codes = new Map<string, AuthCode>();
  private readonly assertionJtis = new Map<string, number>();
  private readonly dcrLimit = new RateLimiter(30);
  private readonly authorizeLimit = new RateLimiter(20);
  private readonly tokenLimit = new RateLimiter(60);
  private readonly kek: { id: string; key: Uint8Array };

  constructor(ctx: BridgeContext, kek: { id: string; key: Uint8Array }) {
    this.ctx = ctx;
    this.kek = kek;
    setInterval(() => this.sweep(), 60_000).unref();
  }

  private sweep(): void {
    const now = nowS();
    for (const [k, v] of this.pending) if (v.exp <= now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.exp <= now) this.codes.delete(k);
    for (const [k, v] of this.assertionJtis) if (v <= now) this.assertionJtis.delete(k);
  }

  get issuer(): string {
    return this.ctx.publicUrl;
  }

  get resource(): string {
    return `${this.ctx.publicUrl}/mcp`;
  }

  protectedResource(res: ServerResponse): void {
    const body: ProtectedResourceMetadata = { resource: this.resource, authorization_servers: [this.issuer], bearer_methods_supported: ["header"] };
    sendJson(res, 200, body, { "cache-control": "public, max-age=300" });
  }

  authorizationServer(res: ServerResponse): void {
    sendJson(
      res,
      200,
      {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/oauth/authorize`,
        token_endpoint: `${this.issuer}/oauth/token`,
        registration_endpoint: `${this.issuer}/oauth/register`,
        revocation_endpoint: `${this.issuer}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: [OAUTH_GRANT_TYPES.authorizationCode, OAUTH_GRANT_TYPES.refreshToken, OAUTH_GRANT_TYPES.jwtBearer],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [],
      },
      { "cache-control": "public, max-age=300" },
    );
  }

  // ── DCR (stateless): client_id = sealed registration (integrity under TB_KEK, no client table) ──
  private encodeClient(reg: ClientReg): string {
    const blob = this.ctx.api.seal(Buffer.from(this.ctx.api.canonicalize(reg as never), "utf8"), this.kek, CLIENT_AAD);
    return `tbc_${Buffer.from(JSON.stringify(blob)).toString("base64url")}`;
  }

  private decodeClient(clientId: string): ClientReg | undefined {
    if (!clientId.startsWith("tbc_") || clientId.length > 4096) return undefined;
    try {
      const blob = JSON.parse(Buffer.from(clientId.slice(4), "base64url").toString("utf8")) as SealedBlob;
      const reg = JSON.parse(Buffer.from(this.ctx.api.unseal(blob, { current: this.kek }, CLIENT_AAD)).toString("utf8")) as ClientReg;
      return Array.isArray(reg.redirect_uris) ? reg : undefined;
    } catch {
      return undefined;
    }
  }

  async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.dcrLimit.take(clientIp(req))) return oauthError(res, 429, "slow_down", "rate limited");
    const body = parseBody(await readBody(req, 16 * 1024), req.headers["content-type"]);
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || uris.length > 5 || !uris.every((u) => typeof u === "string" && validRedirect(u))) {
      return oauthError(res, 400, "invalid_redirect_uri", "1–5 https or loopback http redirect URIs required");
    }
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
      return oauthError(res, 400, "invalid_client_metadata", "public clients only");
    }
    const name = typeof body.client_name === "string" ? body.client_name.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 80) : "";
    const reg: ClientReg = { redirect_uris: uris as string[], client_name: name, iat: nowS() };
    const out: DcrResponse = {
      client_id: this.encodeClient(reg),
      ...(name ? { client_name: name } : {}),
      redirect_uris: reg.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    sendJson(res, 201, out);
  }

  // ── authorize page ──
  async authorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorizeLimit.take(clientIp(req))) return htmlPage(res, 429, "Too many requests", "<p>Please wait a minute and try again.</p>");
    if (req.method === "GET") return this.authorizeGet(req, res);
    const form = parseBody(await readBody(req, 16 * 1024), req.headers["content-type"]);
    const rid = typeof form.rid === "string" ? form.rid : "";
    const p = this.pending.get(rid);
    if (!p || p.exp <= nowS()) return htmlPage(res, 400, "Request expired", "<p>This sign-in request expired. Start again from your app.</p>");
    if (form.action === "portal") return this.toPortal(res, p);
    if (form.action === "paste") {
      const code = typeof form.code === "string" ? form.code.trim() : "";
      return this.redeem(res, code, p, false);
    }
    return htmlPage(res, 400, "Bad request", "<p>Unknown action.</p>");
  }

  private authorizeGet(req: IncomingMessage, res: ServerResponse): void {
    const q = new URL(req.url ?? "/", this.issuer).searchParams;
    const clientId = q.get("client_id") ?? "";
    const client = this.decodeClient(clientId);
    const redirectUri = q.get("redirect_uri") ?? "";
    if (!client || !redirectMatches(client.redirect_uris, redirectUri)) {
      return htmlPage(res, 400, "Unknown client", "<p>The app that sent you here is not registered with this bridge. Remove the connector and add it again.</p>");
    }
    const fail = (error: string) => redirectWith(res, redirectUri, { error, ...(q.get("state") ? { state: q.get("state") as string } : {}), iss: this.issuer });
    const state = q.get("state") ?? "";
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("response_type") !== "code") return fail("unsupported_response_type");
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request");
    if (state.length > 512) return fail("invalid_request");
    if ((q.get("resource") ?? this.resource) !== this.resource) return fail("invalid_target");
    const rid = this.ctx.api.ulid();
    const pending: PendingAuth = { rid, client, clientId, redirectUri, challenge, state, exp: nowS() + 600 };
    this.pending.set(rid, pending);
    const host = new URL(redirectUri).host;
    const name = client.client_name || "(no name)";
    htmlPage(
      res,
      200,
      "Connect an agent",
      `<p>An app wants to connect an agent to <b>${esc(this.ctx.table?.config.workspace.name ?? "your workspace")}</b>.</p>
<table><tr><th>App name</th><td>${esc(name)} <span class="warn">unverified</span></td></tr>
<tr><th>Returns to</th><td>${esc(host)}</td></tr></table>
<p>Only continue if you started this from your own app.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="rid" value="${esc(rid)}"><input type="hidden" name="action" value="portal">
<button type="submit">Approve in Portal</button></form>
<details><summary>I have a pairing code</summary>
<form method="post" action="/oauth/authorize"><input type="hidden" name="rid" value="${esc(rid)}"><input type="hidden" name="action" value="paste">
<label>Pairing code from the agent card <input name="code" autocomplete="off" spellcheck="false" required></label>
<button type="submit">Connect</button></form></details>`,
    );
  }

  /** Path A: front-channel form POST to Portal /pair with a pairing state proof (no bridge→Portal call). */
  private async toPortal(res: ServerResponse, p: PendingAuth): Promise<void> {
    const id = this.ctx.identity;
    if (!id || this.ctx.table?.standalone) return htmlPage(res, 400, "Not available", "<p>Approve in Portal is not available for this workspace. Use a pairing code.</p>");
    const now = nowS();
    const ref = this.ctx.bridgeRef;
    const state = await this.ctx.api.signJws(
      TYP.pairState,
      {
        iss: ref,
        sub: ref,
        aud: "tb:portal",
        iat: now,
        exp: now + LIFETIME_S.pairState,
        jti: this.ctx.api.ulid(),
        rid: p.rid,
        ret: `${this.issuer}/oauth/pair/callback`,
        rh: new URL(p.redirectUri).host,
        cn: p.client.client_name.slice(0, 80),
      },
      id.key,
    );
    autoPost(res, `${this.ctx.portalUrl}/pair`, { state }, "Opening Portal…");
  }

  /** Path A return: Portal auto-submits `code=<K2b>` (never in a URL). */
  async pairCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = parseBody(await readBody(req, 16 * 1024), req.headers["content-type"]);
    const code = typeof form.code === "string" ? form.code.trim() : "";
    const peek = peekRid(code);
    const p = peek ? this.pending.get(peek) : undefined;
    if (!p || p.exp <= nowS()) return htmlPage(res, 400, "Request expired", "<p>This sign-in request expired. Start again from your app.</p>");
    return this.redeem(res, code, p, true);
  }

  /** Offline pairing-code check (CREDENTIALS §7) → connection in S4 → one-time authorization code. */
  private async redeem(res: ServerResponse, code: string, p: PendingAuth, pathA: boolean): Promise<void> {
    const ctx = this.ctx;
    const t = ctx.table;
    const fail = (why: string) => {
      ctx.reject({ kind: "pairing", code: why });
      htmlPage(res, 400, "Code not accepted", "<p>This pairing code is not valid for this workspace, has expired or was used already. Create a new one on the agent card in Portal.</p>");
    };
    if (!t || !ctx.identity || !code) return fail("code_invalid");
    const now = nowS();
    const v = ctx.api.verifyJws<PairingCodeClaims>(code, t.issuers, { typ: TYP.pairingCode, aud: ctx.bridgeRef, iss: ["tb:portal"], now, maxLifetimeS: LIFETIME_S.pairingCode });
    if (isRefusal(v)) return fail("invalid_token");
    const c = v.claims;
    const agt = c.sub.startsWith("tb:agt:") ? (c.sub.slice(7) as AgentId) : undefined;
    if (!agt || c.ws !== t.ws || !t.agents.has(agt)) return fail("agent_unknown");
    if (t.pausedWorkspace || t.pausedAgents.has(agt)) return fail("paused");
    if (pathA !== (c.rid !== undefined) || (pathA && c.rid !== p.rid)) return fail("rid_mismatch");
    if (now - ctx.lastPull > LIFETIME_S.pairingRedeemMaxConfigAge) return fail("config_stale");
    if (t.revokedJtis.has(c.jti)) return fail("grant_revoked");
    if (!ctx.state.useJti(c.jti, c.exp)) return fail("code_used");
    const con = `con_${ctx.api.ulid()}` as ConnectionId;
    const refreshPlaceholder = ctx.api.opaqueDigest(ctx.api.opaqueValue("tbr_"));
    const rec: PairingConnectionRecord = {
      con,
      agt,
      refreshDigest: refreshPlaceholder,
      gen: 1,
      previousDigest: null,
      previousUntil: null,
      previousUsed: false,
      expiresAt: now + LIFETIME_S.agentRefreshSliding,
      clientName: p.client.client_name.slice(0, 80),
      createdAt: now,
      reported: false,
    };
    ctx.state.connections.set(con, rec);
    ctx.state.saveConnections();
    pairingJtis.set(con, c.jti);
    ctx.emit("connection-created", con);
    const authCode = ctx.api.opaqueValue("tbac_");
    this.codes.set(ctx.api.opaqueDigest(authCode), { con, agt, gen: 1, clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, exp: now + LIFETIME_S.oauthAuthorizationCode });
    this.pending.delete(p.rid);
    ctx.log.info("bridge.pairing.redeemed", { agt, con, path: pathA ? "A" : "B" });
    redirectWith(res, p.redirectUri, { code: authCode, ...(p.state ? { state: p.state } : {}), iss: this.issuer });
  }

  // ── token endpoint ──
  async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = parseBody(await readBody(req, 16 * 1024), req.headers["content-type"]);
    const gt = form.grant_type;
    try {
      if (gt === OAUTH_GRANT_TYPES.authorizationCode) return await this.tokenFromCode(res, form);
      if (gt === OAUTH_GRANT_TYPES.refreshToken) return await this.tokenFromRefresh(res, form);
      if (gt === OAUTH_GRANT_TYPES.jwtBearer) return await this.tokenFromAssertion(res, form);
      return oauthError(res, 400, "unsupported_grant_type", "unsupported grant type");
    } catch (e) {
      if (e instanceof BridgeError && e.code === "rate_limited") return oauthError(res, 429, "slow_down", "rate limited");
      if (e instanceof BridgeError && e.code === "connection_unknown") return oauthError(res, 400, "invalid_grant", "connection_unknown");
      if (e instanceof BridgeError && e.code === "temporarily_unavailable") return oauthError(res, 503, "temporarily_unavailable", "bridge not ready");
      return oauthError(res, 400, "invalid_grant", "grant not accepted");
    }
  }

  private async tokenFromCode(res: ServerResponse, f: Record<string, unknown>): Promise<void> {
    const code = typeof f.code === "string" ? f.code : "";
    const d = this.ctx.api.opaqueDigest(code);
    const ac = this.codes.get(d);
    this.codes.delete(d);
    if (!ac || ac.exp <= nowS()) throw new BridgeError("invalid_grant");
    if (f.client_id !== ac.clientId || f.redirect_uri !== ac.redirectUri) throw new BridgeError("invalid_grant");
    if (f.resource !== undefined && f.resource !== this.resource) throw new BridgeError("invalid_grant");
    const verifier = typeof f.code_verifier === "string" ? f.code_verifier : "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(this.ctx, verifier) !== ac.challenge) throw new BridgeError("invalid_grant");
    const rec = this.ctx.state.connections.get(ac.con);
    if (!rec) throw new BridgeError("invalid_grant");
    const refresh = this.ctx.api.opaqueValue("tbr_");
    rec.refreshDigest = this.ctx.api.opaqueDigest(refresh);
    rec.expiresAt = nowS() + LIFETIME_S.agentRefreshSliding;
    this.ctx.state.saveConnections();
    const out: TokenResponse = { access_token: await issueAccess(this.ctx, rec.agt, rec.con, rec.gen), token_type: "Bearer", expires_in: 900, refresh_token: refresh };
    sendJson(res, 200, out, { pragma: "no-cache" });
  }

  private async tokenFromRefresh(res: ServerResponse, f: Record<string, unknown>): Promise<void> {
    const presented = typeof f.refresh_token === "string" ? f.refresh_token : "";
    if (!presented.startsWith("tbr_")) throw new BridgeError("invalid_grant");
    const { rec, refresh } = rotateRefresh(this.ctx, presented);
    if (!this.tokenLimit.take(rec.con)) throw new BridgeError("rate_limited");
    const out: TokenResponse = { access_token: await issueAccess(this.ctx, rec.agt, rec.con, rec.gen), token_type: "Bearer", expires_in: 900, refresh_token: refresh };
    sendJson(res, 200, out, { pragma: "no-cache" });
  }

  /** Key connections (TBD, CLI agent mode, kits): RFC 7523 agent assertion signed by K4. */
  private async tokenFromAssertion(res: ServerResponse, f: Record<string, unknown>): Promise<void> {
    const t = this.ctx.table;
    if (!t) throw new BridgeError("temporarily_unavailable");
    const assertion = typeof f.assertion === "string" ? f.assertion : "";
    const peek = peekPayload<AgentAssertionClaims>(assertion);
    const con = peek?.con;
    if (!con) throw new BridgeError("invalid_grant");
    if (!this.tokenLimit.take(con)) throw new BridgeError("rate_limited");
    const entry = t.connections.get(con);
    if (!entry) throw new BridgeError("connection_unknown");
    if (entry.method !== "key" || !entry.publicKey || entry.status !== "active") throw new BridgeError("invalid_grant");
    const st = connectionState(this.ctx, con);
    if (!st?.active) throw new BridgeError("invalid_grant");
    const keys = this.ctx.api.keySetFrom({ keys: [entry.publicKey] }, `tb:agt:${entry.agt}` as never);
    const now = nowS();
    const v = this.ctx.api.verifyJws<AgentAssertionClaims>(assertion, keys, {
      typ: TYP.agentAssertion,
      aud: this.ctx.bridgeRef,
      iss: [`tb:agt:${entry.agt}`],
      now,
      maxLifetimeS: LIFETIME_S.proof,
    });
    if (isRefusal(v) || v.claims.sub !== `tb:agt:${entry.agt}` || v.claims.con !== con) throw new BridgeError("invalid_grant");
    if (!t.agents.has(entry.agt)) throw new BridgeError("invalid_grant");
    if (this.assertionJtis.has(v.claims.jti)) throw new BridgeError("invalid_grant");
    this.assertionJtis.set(v.claims.jti, v.claims.exp + 30);
    const out: TokenResponse = { access_token: await issueAccess(this.ctx, entry.agt, con, entry.gen), token_type: "Bearer", expires_in: 900 };
    sendJson(res, 200, out, { pragma: "no-cache" });
  }

  async revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = parseBody(await readBody(req, 16 * 1024), req.headers["content-type"]);
    const token = typeof form.token === "string" ? form.token : "";
    if (token.startsWith("tbr_")) {
      const d = this.ctx.api.opaqueDigest(token);
      for (const rec of this.ctx.state.connections.values()) {
        if (this.ctx.api.digestEqual(rec.refreshDigest, d) || (rec.previousDigest && this.ctx.api.digestEqual(rec.previousDigest, d))) {
          revokeLocal(this.ctx, rec.con, "client_revoke");
          break;
        }
      }
    }
    res.writeHead(200, { "cache-control": "no-store" }).end();
  }
}

// ── helpers ──
function parseBody(buf: Buffer, contentType: string | undefined): Record<string, unknown> {
  const text = buf.toString("utf8");
  if ((contentType ?? "").includes("application/json")) {
    try {
      const v = JSON.parse(text);
      return isRecord(v) ? v : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function validRedirect(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Exact match, except the port of loopback http redirects (RFC 8252). */
function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(u.hostname)) return false;
    return registered.some((r) => {
      const ru = new URL(r);
      return ru.protocol === "http:" && ru.hostname === u.hostname && ru.pathname === u.pathname && ru.search === u.search;
    });
  } catch {
    return false;
  }
}

function s256(ctx: BridgeContext, verifier: string): string {
  const hex = ctx.api.sha256Bytes(Buffer.from(verifier, "ascii")).slice(7);
  return Buffer.from(hex, "hex").toString("base64url");
}

function peekPayload<C>(token: string): C | undefined {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as C;
  } catch {
    return undefined;
  }
}

function peekRid(code: string): string | undefined {
  const p = peekPayload<{ rid?: unknown }>(code);
  return typeof p?.rid === "string" ? p.rid : undefined;
}

function oauthError(res: ServerResponse, status: number, error: string, description: string): void {
  sendJson(res, status, { error, error_description: description }, { pragma: "no-cache" });
}

function redirectWith(res: ServerResponse, uri: string, params: Record<string, string>): void {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  res.writeHead(302, { location: u.toString(), "cache-control": "no-store" }).end();
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#14302e;background:#f6f8f7}
h1{font-size:1.3rem;color:#0f5f5a}button{background:#0f5f5a;color:#fff;border:0;border-radius:2px;padding:.6rem 1rem;font:inherit;cursor:pointer;margin:.5rem 0}
input{font:inherit;padding:.4rem;border:1px solid #9bb;border-radius:2px;width:100%;box-sizing:border-box}th{text-align:left;padding-right:1rem;font-weight:600}
.warn{color:#7a1f3d;font-size:.85em;border:1px solid #7a1f3d;border-radius:2px;padding:0 .3rem}
@media (prefers-color-scheme:dark){body{background:#0e1817;color:#dce9e7}h1{color:#5fc4bb}input{background:#14201f;color:#dce9e7}}`;

export function htmlPage(res: ServerResponse, status: number, title: string, body: string, extraHeaders: Record<string, string> = {}, nonce?: string): void {
  const script = nonce ? ` 'nonce-${nonce}'` : "";
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src${script || " 'none'"}; form-action *; frame-ancestors 'none'; base-uri 'none'`,
    ...extraHeaders,
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`);
}

/** Auto-submitting form POST (credentials never travel in URLs). */
export function autoPost(res: ServerResponse, action: string, fields: Record<string, string>, title: string): void {
  const nonce = randomBytes(16).toString("base64url");
  const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  htmlPage(
    res,
    200,
    title,
    `<form id="f" method="post" action="${esc(action)}">${inputs}<noscript><button type="submit">Continue</button></noscript></form><script nonce="${nonce}">document.getElementById("f").submit()</script>`,
    {},
    nonce,
  );
}
