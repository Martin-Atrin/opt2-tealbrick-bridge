/**
 * Viewer pages (LA-1, C232; BRIDGE §9.2 "the two roles"): what the views service (`TB_ROLE=views`) and the bridge's
 * private views route share. Every rule that has a name in `@opt2-tealbrick/manifest` (VIEWER_HEADER_FLOOR,
 * VIEWER_REQUEST_HEADERS, viewerResponseHeaderDropped, isViewerDocumentPath, viewerDocumentCspOk, viewerFloorOverride) is IMPORTED here,
 * never written a second time (L1). Nothing in this file logs a path, a query or a header value: a viewer link carries
 * its token in the path.
 */
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isViewerDocumentPath, ulid, VIEWER_HEADER_FLOOR, VIEWER_REQUEST_HEADERS, viewerDocumentCspOk, viewerFloorOverride, viewerResponseHeaderDropped } from "@opt2-tealbrick/manifest";

/** The header that carries the Core-generated views key from tb-views to the bridge private route. */
export const VIEWS_KEY_HEADER = "tb-views-key";
/** Response body cap and upstream timeout (BRIDGE §9.2, MANIFEST size-limit table): 2 MiB, 10 s. */
export const VIEWS_MAX_BODY = 2 * 1024 * 1024;
export const VIEWS_TIMEOUT_MS = 10_000;
/** In-flight caps: tb-views globally, and the bridge route on its own (so `/mcp` is never starved by viewer traffic). */
export const VIEWS_EDGE_MAX_IN_FLIGHT = 32;
export const VIEWS_ROUTE_MAX_IN_FLIGHT = 32;
/** tb-views per-client-IP bucket: requests per minute. */
export const VIEWS_PER_CLIENT_PER_MIN = 120;
/** A views key shorter than this is not a generated key (Core generates 32 random bytes). */
export const VIEWS_KEY_MIN_LENGTH = 16;
const PRODUCT_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** A views key and the limits both roles can be started with (tests lower the limits; production uses the defaults). */
export interface ViewsLimits {
  inFlight: number;
  maxBytes: number;
  timeoutMs: number;
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * RFC 3986 normalisation of percent escapes: an escaped UNRESERVED character (`%5F` = `_`) is the same character, and
 * an app's router may treat it so. Decoding them before routing and before the `_d` check means the gate sees the path
 * the app will see. Reserved escapes (`%2F`) are kept (upper-cased).
 */
export function normalizePercent(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (m, h: string) => {
    const c = String.fromCharCode(Number.parseInt(h, 16));
    return UNRESERVED.test(c) ? c : m.toUpperCase();
  });
}

export interface ViewerTarget {
  product: string;
  /** the path after the product, always starting with "/" (percent escapes normalised) */
  rest: string;
  /** the query string including "?", or "" */
  search: string;
}

/**
 * Parses `<prefix>/<product>/<rest>` (`/v` on tb-views, `/tb/v1/views` on the bridge). Anything that is not exactly that
 * shape is undefined (a 404): a request target that is not an absolute path, a product id outside the product rule, no
 * path after the product. `..` segments are resolved by the URL parser before the prefix is checked, so a path cannot
 * climb out of the prefix.
 */
export function viewerTarget(rawUrl: string | undefined, prefix: string): ViewerTarget | undefined {
  const raw = rawUrl ?? "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return undefined;
  let u: URL;
  try {
    u = new URL(raw, "http://views.invalid");
  } catch {
    return undefined;
  }
  const path = normalizePercent(u.pathname);
  if (!path.startsWith(`${prefix}/`)) return undefined;
  const after = path.slice(prefix.length + 1);
  const slash = after.indexOf("/");
  if (slash < 0) return undefined;
  const product = after.slice(0, slash);
  if (!PRODUCT_RE.test(product)) return undefined;
  return { product, rest: after.slice(slash), search: u.search };
}

/** True when the app-visible path `/v/<product><rest>` is the reserved untrusted-document path (`_d`), also with doubled slashes. */
export function isViewerDocument(t: ViewerTarget): boolean {
  const path = `/v/${t.product}${t.rest}`;
  return isViewerDocumentPath(path) || isViewerDocumentPath(path.replace(/\/{2,}/g, "/"));
}

/** The allow-listed request headers (MANIFEST v0.1.43); everything else is dropped, absent stays absent. */
export function viewerRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of VIEWER_REQUEST_HEADERS) {
    const v = headers[name];
    if (v !== undefined) out[name] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/** The first `X-Forwarded-For` hop (set by the provider's edge), else the socket address. */
export function viewsClientIp(headers: IncomingHttpHeaders, socketAddress: string | undefined): string {
  const xff = headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff.join(",") : xff)?.split(",")[0]?.trim();
  if (first && first.length <= 64) return first;
  return socketAddress ?? "unknown";
}

/** A buffered answer from upstream (the bridge for tb-views, the app for the bridge route). */
export interface RawViewerResponse {
  status: number;
  /** every value of every header, lower-case names */
  headers: Record<string, string[]>;
  body: Buffer;
}

/** What went wrong reaching upstream; `kind` maps to the answer (503 / 504 / 502). */
export class ViewerFetchError extends Error {
  readonly kind: "unreachable" | "timeout" | "too_large";
  constructor(kind: "unreachable" | "timeout" | "too_large") {
    super(kind);
    this.kind = kind;
  }
}

/**
 * GET with a hard body cap and a whole-request deadline. The body is never buffered past `maxBytes` (a declared
 * Content-Length over the cap is refused before a byte is read); the deadline covers connect, headers and body. `finish`
 * runs BEFORE the socket is destroyed, so the first cause (cap, deadline) is the one reported.
 */
export function getCapped(url: URL, headers: Record<string, string>, o: { timeoutMs: number; maxBytes: number }): Promise<RawViewerResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const finish = (err: ViewerFetchError | undefined, value?: RawViewerResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(value as RawViewerResponse);
    };
    const req = send(url, { method: "GET", headers }, (res) => {
      const status = res.statusCode ?? 502;
      const declared = Number(res.headers["content-length"]);
      if (status !== 304 && Number.isFinite(declared) && declared > o.maxBytes) return finish(new ViewerFetchError("too_large"));
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) return finish(new ViewerFetchError("too_large"));
        chunks.push(c);
      });
      res.on("end", () => finish(undefined, { status, headers: { ...res.headersDistinct } as Record<string, string[]>, body: Buffer.concat(chunks) }));
      res.on("error", () => finish(new ViewerFetchError("unreachable")));
      res.on("aborted", () => finish(new ViewerFetchError("unreachable")));
    });
    const timer = setTimeout(() => finish(new ViewerFetchError("timeout")), o.timeoutMs);
    req.on("error", () => finish(new ViewerFetchError("unreachable")));
    req.end();
  });
}

const FLOOR_NAMES: ReadonlySet<string> = new Set(Object.keys(VIEWER_HEADER_FLOOR));
/** connection-level headers belong to one hop, never to the answer we write */
const HOP_BY_HOP: ReadonlySet<string> = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);
const CSP = "content-security-policy";
const CACHE_CONTROL = "cache-control";

/** The floor as a plain header object. Every answer on the viewer path carries it, errors too. */
export function floorHeaders(): Record<string, string> {
  return { ...VIEWER_HEADER_FLOOR };
}

export interface ViewerAnswer {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/**
 * The one shaping of a viewer answer, applied by the bridge route AND by tb-views (defence in depth, same code):
 *  - the `_d` gate over ALL Content-Security-Policy values the upstream sent (a missing policy is not safe) → undefined,
 *  - headers the viewer must never get are dropped (viewerResponseHeaderDropped) and hop-by-hop headers are not copied,
 *  - VIEWER_HEADER_FLOOR is set. A floor header the upstream also sends replaces the floor's ONLY when the manifest's
 *    `viewerFloorOverride(name, value, path)` says so (manifest 0.1.22): `content-security-policy` always (all its values
 *    are kept; none, or only empty ones → the floor's), and `cache-control` only as ONE `public, max-age=<n>, immutable`
 *    value on `/v/<product>/_s/…` (never on a token page, a data answer or a `_d` document: they stay `no-store`).
 *    The path is the normalised app-visible path; a doubled-slash path never counts as an asset path.
 */
export function shapeViewerAnswer(raw: RawViewerResponse, target: ViewerTarget): ViewerAnswer | undefined {
  const document = isViewerDocument(target);
  const path = `/v/${target.product}${target.rest}`;
  const csp = (raw.headers[CSP] ?? []).filter((v) => v.trim() !== "");
  if (document && !viewerDocumentCspOk(csp)) return undefined;
  const headers: Record<string, string | string[]> = floorHeaders();
  for (const [name, values] of Object.entries(raw.headers)) {
    const n = name.toLowerCase();
    if (values.length === 0 || viewerResponseHeaderDropped(n) || HOP_BY_HOP.has(n)) continue;
    if (FLOOR_NAMES.has(n)) {
      // a floor header is replaced only by the manifest rule; several Cache-Control lines never count as one value
      if (n === CACHE_CONTROL && !document && values.length === 1 && viewerFloorOverride(n, values[0] as string, path)) headers[n] = values[0] as string;
      continue;
    }
    headers[n] = values.length === 1 ? (values[0] as string) : values;
  }
  if (csp.length && viewerFloorOverride(CSP, csp[0] as string, path)) headers[CSP] = csp.length === 1 ? (csp[0] as string) : csp;
  if (raw.status !== 304 && raw.status !== 204 && raw.status >= 200) headers["content-length"] = String(raw.body.length);
  return { status: raw.status, headers, body: raw.body };
}

export function writeViewerAnswer(res: ServerResponse, a: ViewerAnswer): void {
  res.writeHead(a.status, a.headers);
  res.end(a.status === 304 || a.status === 204 ? undefined : a.body);
}

/** A viewer-path error: the one error envelope plus the floor; the message never contains the path or the query. */
export function sendViewerError(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({ error: { code, message, requestId: `req_${ulid()}` } });
  res.writeHead(status, { ...floorHeaders(), "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...extra });
  res.end(body);
}

/** A small JSON answer on the viewer path (health, readiness) with the floor. */
export function sendViewerJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...floorHeaders(), "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

/** Maps a failed upstream fetch to the answer a viewer gets. */
export function sendFetchError(res: ServerResponse, e: unknown, what: string): void {
  const kind = e instanceof ViewerFetchError ? e.kind : "unreachable";
  if (kind === "timeout") return sendViewerError(res, 504, "viewer_timeout", `${what} did not answer in time`);
  if (kind === "too_large") return sendViewerError(res, 502, "viewer_response_too_large", "the page is larger than the viewer allows");
  sendViewerError(res, 503, "viewer_not_ready", "viewer address not ready", { "retry-after": "5" });
}
