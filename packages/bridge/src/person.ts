/**
 * Person-facing surfaces of the bridge (BRIDGE §9): app launch + UI proxy (/a/<product>/…),
 * declared public routes (/p/<product>/…) and the key-entry page (/keys). Not paused by design
 * (CREDENTIALS §13) and served with a config older than 12 h so the owner can act.
 */

import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { LIFETIME_S, type PersonTicketKeysClaims, type PersonTicketLaunchClaims, TYP } from "@opt2-tealbrick/spec/credentials";
import { isRefusal } from "./api.ts";
import type { BridgeContext } from "./context.ts";
import { esc, htmlPage } from "./oauth.ts";
import type { AppRuntime } from "./table.ts";
import { BridgeError, envelope, headerValue, nowS, RateLimiter, readBody, sendJson } from "./util.ts";

const MAX_UI_BODY = 10 * 1024 * 1024;
const MAX_PUBLIC_BODY = 1024 * 1024;

interface KeySession {
  csrf: string;
  exp: number;
  req: string[];
}

export class PersonSurfaces {
  private readonly ctx: BridgeContext;
  private readonly keySessions = new Map<string, KeySession>();
  private readonly publicLimit = new RateLimiter(60);

  constructor(ctx: BridgeContext) {
    this.ctx = ctx;
    setInterval(() => {
      const now = nowS();
      for (const [k, v] of this.keySessions) if (v.exp <= now) this.keySessions.delete(k);
    }, 60_000).unref();
  }

  private issuerRefs(): string[] {
    return this.ctx.table?.standalone ? [this.ctx.bridgeRef] : ["tb:portal"];
  }

  // ── §9.1 launch + app UI proxy ──
  async app(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const m = /^\/a\/([a-z][a-z0-9-]{1,31})(\/.*)?$/.exec(url.pathname);
    const app = m ? this.ctx.table?.appsByProduct.get(m[1] as string) : undefined;
    if (!m || !app) return sendJson(res, 404, envelope("not_found", "not found", requestId));
    const rest = m[2] ?? "/";
    if (!this.allowedUiPath(app, rest)) return sendJson(res, 404, envelope("not_found", "not found", requestId));
    let body: Buffer | undefined;
    if (rest === "/tb/launch") {
      if (req.method !== "POST") return sendJson(res, 405, envelope("method_not_allowed", "POST only", requestId));
      body = await readBody(req, 16 * 1024);
      const ticket = new URLSearchParams(body.toString("utf8")).get("ticket") ?? "";
      const v = this.ctx.api.verifyJws<PersonTicketLaunchClaims>(ticket, this.ctx.table?.issuers ?? { keys: [] }, {
        typ: TYP.personTicket,
        aud: `tb:ins:${app.entry.ins}`,
        iss: this.issuerRefs(),
        now: nowS(),
        maxLifetimeS: LIFETIME_S.ticketLaunch,
      });
      if (isRefusal(v) || v.claims.pur !== "launch" || v.claims.ws !== this.ctx.table?.ws) {
        this.ctx.reject({ kind: "ticket", code: "invalid_token" });
        return htmlPage(res, 401, "Link expired", "<p>This link has expired. Open the app again from Portal.</p>");
      }
      // The SDK redeems the ticket once (jti in the app DB); the bridge only checks and forwards it.
    }
    return this.proxy(req, res, app, url.pathname + url.search, body, MAX_UI_BODY, true);
  }

  private allowedUiPath(app: AppRuntime, rest: string): boolean {
    if (rest === "/tb/launch" || rest.startsWith("/tb/v1/")) return true;
    if (rest.includes("..")) return false;
    const ui = app.manifest?.ui;
    if (!ui) return false;
    return [ui.launchPath, ui.configurePath].filter((p): p is string => !!p).some((p) => p === "/" || rest === p || rest.startsWith(p.endsWith("/") ? p : `${p}/`) || rest.startsWith("/assets/"));
  }

  // ── §9.2 declared public routes ──
  async publicRoute(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const m = /^\/p\/([a-z][a-z0-9-]{1,31})(\/.*)$/.exec(url.pathname);
    const app = m ? this.ctx.table?.appsByProduct.get(m[1] as string) : undefined;
    const path = m?.[2] ?? "";
    const route = app?.manifest?.publicRoutes?.find((r) => r.path === path);
    if (!app || !route) return sendJson(res, 404, envelope("not_found", "not found", requestId));
    const method = route.purpose === "oauth_callback" ? "GET" : "POST";
    if (req.method !== method) return sendJson(res, 405, envelope("method_not_allowed", `${method} only`, requestId));
    if (!this.publicLimit.take(`${app.entry.product}|${path}`)) return sendJson(res, 429, envelope("rate_limited", "rate limited", requestId));
    const body = method === "POST" ? await readBody(req, MAX_PUBLIC_BODY) : undefined;
    return this.proxy(req, res, app, `/p/${app.entry.product}${path}${url.search}`, body, MAX_PUBLIC_BODY, false);
  }

  /** Forwards to the app, stripping Authorization and TB-* (except TB-CSRF on the UI path). */
  private proxy(req: IncomingMessage, res: ServerResponse, app: AppRuntime, pathAndQuery: string, body: Buffer | undefined, max: number, keepCsrf: boolean): Promise<void> {
    return new Promise((resolve) => {
      const target = new URL(pathAndQuery, app.entry.internalUrl);
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (lk === "authorization" || lk === "host" || lk === "connection" || lk === "content-length" || lk === "transfer-encoding") continue;
        if (lk.startsWith("tb-") && !(keepCsrf && lk === "tb-csrf")) continue;
        if (lk.startsWith("x-forwarded-")) continue;
        headers[lk] = v;
      }
      const pub = new URL(this.ctx.publicUrl);
      headers["x-forwarded-proto"] = pub.protocol.replace(":", "");
      headers["x-forwarded-host"] = pub.host;
      if (body) headers["content-length"] = String(body.length);
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const upstream = send(target, { method: req.method, headers, timeout: 60_000 }, (ur) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !["connection", "transfer-encoding"].includes(k)) out[k] = v;
        res.writeHead(ur.statusCode ?? 502, out);
        ur.pipe(res);
        ur.on("end", () => resolve());
      });
      upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
      upstream.on("error", () => {
        if (!res.headersSent) sendJson(res, 502, envelope("app_unavailable", "app unavailable", "proxy"));
        else res.end();
        resolve();
      });
      if (body) upstream.end(body);
      else {
        let size = 0;
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size > max) {
            upstream.destroy();
            if (!res.headersSent) sendJson(res, 413, envelope("payload_too_large", "body too large", "proxy"));
          }
        });
        req.pipe(upstream);
      }
    });
  }

  /** WebSocket upgrade pass-through for the app UI path only. */
  upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://x");
    const m = /^\/a\/([a-z][a-z0-9-]{1,31})(\/.*)?$/.exec(url.pathname);
    const app = m ? this.ctx.table?.appsByProduct.get(m[1] as string) : undefined;
    if (!app || !this.allowedUiPath(app, m?.[2] ?? "/")) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const target = new URL(app.entry.internalUrl);
    const up = netConnect(Number(target.port || 80), target.hostname, () => {
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`, `host: ${target.host}`];
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "authorization" || (lk.startsWith("tb-") && lk !== "tb-csrf")) continue;
        for (const val of Array.isArray(v) ? v : [v]) if (val !== undefined) lines.push(`${k}: ${val}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  }

  // ── §9.3 key-entry page ──
  async keys(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t = this.ctx.table;
    if (!t) return htmlPage(res, 503, "Not ready", "<p>The bridge is starting. Try again in a moment.</p>");
    const cookieName = "tb_keys";
    const sid = parseCookies(headerValue(req, "cookie"))[cookieName];
    const session = sid ? this.keySessions.get(sid) : undefined;
    const secure = this.ctx.publicUrl.startsWith("https:");
    if (req.method === "POST") {
      const form = new URLSearchParams((await readBody(req, 20 * 1024)).toString("utf8"));
      const ticket = form.get("ticket");
      if (ticket) {
        const v = this.ctx.api.verifyJws<PersonTicketKeysClaims>(ticket, t.issuers, {
          typ: TYP.personTicket,
          aud: this.ctx.bridgeRef,
          iss: this.issuerRefs(),
          now: nowS(),
          maxLifetimeS: LIFETIME_S.ticketKeys,
        });
        if (isRefusal(v) || v.claims.pur !== "keys" || v.claims.ws !== t.ws || !this.ctx.state.useJti(v.claims.jti, v.claims.exp)) {
          this.ctx.reject({ kind: "ticket", code: "invalid_token" });
          return htmlPage(res, 401, "Link expired", "<p>This link has expired or was used. Open the key page again from Portal.</p>");
        }
        const id = randomBytes(32).toString("base64url");
        this.keySessions.set(id, { csrf: randomBytes(24).toString("base64url"), exp: nowS() + LIFETIME_S.keyPageSession, req: v.claims.req ?? [] });
        res.writeHead(303, {
          location: "/keys",
          "set-cookie": `${cookieName}=${id}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Path=/keys; Max-Age=${LIFETIME_S.keyPageSession}`,
          "cache-control": "no-store",
        });
        res.end();
        return;
      }
      if (!session || session.exp <= nowS()) return htmlPage(res, 401, "Session expired", "<p>Open the key page again from Portal.</p>");
      if (form.get("csrf") !== session.csrf) return htmlPage(res, 403, "Refused", "<p>The form expired. Reload the page.</p>");
      const name = form.get("name") ?? "";
      const allowed = t.config.keyRequirements.some((k) => k.source === "account_default" && k.name === name);
      if (!allowed) return htmlPage(res, 400, "Unknown key", "<p>This key is not requested by any app.</p>");
      if (form.get("action") === "delete") {
        this.ctx.state.setKey(name, null);
      } else {
        const value = form.get("value") ?? "";
        if (!value || Buffer.byteLength(value) > 16 * 1024) return htmlPage(res, 400, "Not saved", "<p>Enter a value (at most 16 KB).</p>");
        this.ctx.state.setKey(name, value);
      }
      this.ctx.log.info("bridge.keys.changed", { name, keysRev: this.ctx.state.keyStore.keysRev });
      this.ctx.emit("keys");
      res.writeHead(303, { location: "/keys", "cache-control": "no-store" }).end();
      return;
    }
    if (!session || session.exp <= nowS()) return htmlPage(res, 401, "Open from Portal", "<p>Open the key page from Portal (Workspace → workspace default keys).</p>");
    const reqs = t.config.keyRequirements.filter((k) => k.source === "account_default");
    const byName = new Map<string, { label: string; provider?: string; products: Set<string>; required: boolean }>();
    for (const k of reqs) {
      const e = byName.get(k.name) ?? { label: k.label, ...(k.provider ? { provider: k.provider } : {}), products: new Set<string>(), required: false };
      e.products.add(k.product);
      e.required ||= k.required;
      byName.set(k.name, e);
    }
    const names = [...byName.keys()].sort((a, b) => Number(session.req.includes(b)) - Number(session.req.includes(a)) || a.localeCompare(b));
    const rows = names
      .map((n) => {
        const e = byName.get(n) as { label: string; provider?: string; products: Set<string>; required: boolean };
        const set = Object.hasOwn(this.ctx.state.keyStore.values, n);
        return `<section><h2 style="font-size:1rem">${esc(e.label)}${e.required ? "" : " (optional)"}</h2>
<p>${esc(n)} · used by ${esc([...e.products].join(", "))} · <b>${set ? "set" : "not set"}</b></p>
<form method="post" action="/keys"><input type="hidden" name="csrf" value="${esc(session.csrf)}"><input type="hidden" name="name" value="${esc(n)}">
<input type="password" name="value" autocomplete="off" placeholder="${set ? "Replace value" : "Enter value"}" required><button type="submit">${set ? "Replace" : "Save"}</button></form>
${set ? `<form method="post" action="/keys"><input type="hidden" name="csrf" value="${esc(session.csrf)}"><input type="hidden" name="name" value="${esc(n)}"><input type="hidden" name="action" value="delete"><button type="submit">Delete</button></form>` : ""}</section>`;
      })
      .join("");
    htmlPage(res, 200, "Workspace default keys", `<p>Keys are stored in your workspace only. Teal Brick Portal never sees them. Values are never shown again.</p>${rows || "<p>No app needs a key.</p>"}`);
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export { BridgeError };
