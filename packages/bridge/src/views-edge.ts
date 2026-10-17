/**
 * The views role (`TB_ROLE=views`, LA-1, C232; BRIDGE §9.2): the workspace views service "tb-views". The same image and
 * release as the bridge, a different start. It holds NO state: no volume, no Portal connection, no enrolment, no keys.
 *
 *   GET /v/<product>/<rest>  →  GET ${TB_VIEWS_UPSTREAM}/tb/v1/views/<product>/<rest>   (header TB-Views-Key)
 *
 * It serves only that route plus /healthz and /readyz; everything else is 404, HEAD and OPTIONS are 405. Edge duties:
 * request-header allow-list, per-client-IP bucket, global in-flight cap, 2 MiB / 10 s caps, and the viewer response rules
 * (floor, dropped headers, the `_d` gate) from `@opt2-tealbrick/manifest`. It refuses to start when it holds anything of
 * the bridge role, so a misconfigured views service can never become a second bridge.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Logger, RateLimiter, sleep } from "./util.ts";
import {
  getCapped,
  isViewerDocument,
  sendFetchError,
  sendViewerError,
  sendViewerJson,
  shapeViewerAnswer,
  VIEWS_EDGE_MAX_IN_FLIGHT,
  VIEWS_KEY_HEADER,
  VIEWS_KEY_MIN_LENGTH,
  VIEWS_MAX_BODY,
  VIEWS_PER_CLIENT_PER_MIN,
  VIEWS_TIMEOUT_MS,
  type ViewsLimits,
  viewerRequestHeaders,
  viewerTarget,
  viewsClientIp,
  writeViewerAnswer,
} from "./views-shared.ts";

/** Bridge-role env a views service must never hold. */
export const BRIDGE_ONLY_ENV = ["TB_ENROL_CODE", "TB_KEK", "TB_KEK_PREVIOUS", "TB_PORTAL_URL"] as const;
/** How long a /readyz answer is reused (the probe goes to the bridge; the platform and the bridge both poll it). */
const READY_CACHE_MS = 2_000;
const READY_TIMEOUT_MS = 3_000;

/** The views role cannot start with this env. The message names variables, never values. */
export class ViewsRoleError extends Error {
  readonly code = "views_role_refused";
}

export interface ViewsRoleEnv {
  /** the bridge private listener origin, e.g. http://<private host>:8788 */
  upstream: URL;
  /** TB_VIEWS_KEY: sent to the bridge as TB-Views-Key; never logged, never in an error */
  key: string;
  port: number;
}

/** Validates the views role env; throws {@link ViewsRoleError} (variable names only) when it must not start. */
export function viewsRoleEnv(env: NodeJS.ProcessEnv): ViewsRoleEnv {
  const present = BRIDGE_ONLY_ENV.filter((n) => (env[n] ?? "").trim() !== "");
  if (present.length) throw new ViewsRoleError(`the views role refuses to start: ${present.join(", ")} must not be set (bridge env)`);
  const missing = (["TB_VIEWS_UPSTREAM", "TB_VIEWS_KEY"] as const).filter((n) => (env[n] ?? "").trim() === "");
  if (missing.length) throw new ViewsRoleError(`the views role needs ${missing.join(", ")}`);
  const key = (env.TB_VIEWS_KEY ?? "").trim();
  if (key.length < VIEWS_KEY_MIN_LENGTH) throw new ViewsRoleError(`TB_VIEWS_KEY is too short (at least ${VIEWS_KEY_MIN_LENGTH} characters)`);
  let upstream: URL;
  try {
    upstream = new URL((env.TB_VIEWS_UPSTREAM ?? "").trim());
  } catch {
    throw new ViewsRoleError("TB_VIEWS_UPSTREAM must be an http(s) origin");
  }
  if ((upstream.protocol !== "http:" && upstream.protocol !== "https:") || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== "/") {
    throw new ViewsRoleError("TB_VIEWS_UPSTREAM must be an http(s) origin without path, query or credentials");
  }
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ViewsRoleError("PORT must be a port number");
  return { upstream, key, port };
}

export interface ViewsRoleOptions {
  env?: NodeJS.ProcessEnv;
  logger: Logger;
  /** test hook: listen on this port instead of PORT (0 = any free port) */
  port?: number;
  /** test hook: lower the limits (defaults: 32 in flight, 2 MiB, 10 s) */
  limits?: Partial<ViewsLimits> & { perClientPerMin?: number };
}

export interface RunningViews {
  server: Server;
  port: number;
  /** Stops accepting, lets requests in flight finish up to `boundMs`, then stops. */
  drain(boundMs?: number): Promise<{ waitedMs: number; aborted: number }>;
  stop(): Promise<void>;
}

export async function startViews(o: ViewsRoleOptions): Promise<RunningViews> {
  const cfg = viewsRoleEnv(o.env ?? process.env);
  const limits = { inFlight: VIEWS_EDGE_MAX_IN_FLIGHT, maxBytes: VIEWS_MAX_BODY, timeoutMs: VIEWS_TIMEOUT_MS, perClientPerMin: VIEWS_PER_CLIENT_PER_MIN, ...o.limits };
  const perClient = new RateLimiter(limits.perClientPerMin);
  let inFlight = 0;
  let ready: { ok: boolean; at: number } | undefined;

  const upstreamUrl = (path: string): URL => {
    const u = new URL(`/tb/v1/views/${path}`, cfg.upstream);
    // the path was built from a normalised target: still under the views route of the bridge, or it is not sent
    if (!u.pathname.startsWith("/tb/v1/views/")) throw new Error("path left the views route");
    return u;
  };

  /** /readyz: the bridge's views route answers `_ready` (a short reuse keeps probe traffic off the bridge). */
  const upstreamReady = async (): Promise<boolean> => {
    if (ready && Date.now() - ready.at < READY_CACHE_MS) return ready.ok;
    let ok = false;
    try {
      const r = await getCapped(upstreamUrl("_ready"), { [VIEWS_KEY_HEADER]: cfg.key }, { timeoutMs: READY_TIMEOUT_MS, maxBytes: 4096 });
      ok = r.status === 200;
    } catch {
      ok = false;
    }
    ready = { ok, at: Date.now() };
    return ok;
  };

  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
    // HEAD and OPTIONS are refused everywhere (no preflight, no probe of what exists)
    if (method === "HEAD" || method === "OPTIONS") return sendViewerError(res, 405, "method_not_allowed", "GET only", { allow: "GET" });
    const health = rawPath === "/healthz" || rawPath === "/readyz";
    const target = health ? undefined : viewerTarget(req.url, "/v");
    if (!health && !target) return sendViewerError(res, 404, "not_found", "not found");
    if (method !== "GET") return sendViewerError(res, 405, "method_not_allowed", "GET only", { allow: "GET" });
    if (health) {
      if (rawPath === "/healthz") return sendViewerJson(res, 200, { status: "ok" });
      return (await upstreamReady()) ? sendViewerJson(res, 200, { status: "ready" }) : sendViewerJson(res, 503, { status: "not_ready" });
    }
    if (!target) return;
    if (!perClient.take(viewsClientIp(req.headers, req.socket.remoteAddress))) return sendViewerError(res, 429, "rate_limited", "too many requests; retry later", { "retry-after": "60" });
    if (inFlight >= limits.inFlight) return sendViewerError(res, 503, "temporarily_unavailable", "the viewer is busy; retry in a moment", { "retry-after": "2" });
    inFlight += 1;
    try {
      // the allow-list only; Cookie, Authorization and TB-* never pass, and the one TB- header is the views key
      const headers = { ...viewerRequestHeaders(req.headers), [VIEWS_KEY_HEADER]: cfg.key };
      let raw: Awaited<ReturnType<typeof getCapped>>;
      try {
        raw = await getCapped(upstreamUrl(`${target.product}${target.rest}${target.search}`), headers, { timeoutMs: limits.timeoutMs, maxBytes: limits.maxBytes });
      } catch (e) {
        return sendFetchError(res, e, "the page");
      }
      const answer = shapeViewerAnswer(raw, isViewerDocument(target));
      if (!answer) {
        // product only: the path carries the viewer's token
        o.logger.warn("views.document_unsafe", { code: "viewer_document_unsafe", product: target.product });
        return sendViewerError(res, 502, "viewer_document_unsafe", "this document's content-security-policy is not a safe sandbox");
      }
      writeViewerAnswer(res, answer);
    } finally {
      inFlight -= 1;
    }
  };

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000, connectionsCheckingInterval: 5_000 }, (req, res) => {
    serve(req, res).catch(() => {
      // an unexpected failure is an error answer, never a stack or a path
      sendViewerError(res, 500, "internal_error", "internal error");
    });
  });
  server.maxConnections = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? cfg.port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  o.logger.info("views.listening", { port, role: "views" });

  const stop = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return {
    server,
    port,
    stop,
    async drain(boundMs = 25_000) {
      const started = Date.now();
      server.close();
      while (inFlight > 0 && Date.now() - started < boundMs) await sleep(50);
      const aborted = inFlight;
      await stop();
      return { waitedMs: Date.now() - started, aborted };
    },
  };
}
