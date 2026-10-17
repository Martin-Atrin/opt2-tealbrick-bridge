/**
 * The bridge's private views route (LA-1, C232; BRIDGE §9.2): `GET /tb/v1/views/<product>/<rest>` and
 * `GET /tb/v1/views/_ready`, on the PRIVATE listener only. The workspace views service (tb-views, `TB_ROLE=views`) is its
 * one caller. Main origin and keys origin never serve `/v/*` (they answer 404).
 *
 * Why a key: every service in the workspace's private network can reach this listener. The route carries only what a link
 * holder already sees, but without a key any app could bypass the edge rate limit and read another app's pages by
 * guessing tokens from inside. The key is Core-generated (`TB_VIEWS_KEY`), compared in constant time, and a missing, wrong
 * or unset key is a plain 404, exactly like any unknown path (no 401, no oracle).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeContext } from "./context.ts";
import type { AppRuntime } from "./table.ts";
import { envelope, headerValue, sendJson } from "./util.ts";
import {
  getCapped,
  sendFetchError,
  sendViewerError,
  sendViewerJson,
  shapeViewerAnswer,
  VIEWS_KEY_HEADER,
  VIEWS_MAX_BODY,
  VIEWS_ROUTE_MAX_IN_FLIGHT,
  VIEWS_TIMEOUT_MS,
  type ViewsLimits,
  viewerRequestHeaders,
  viewerTarget,
  writeViewerAnswer,
} from "./views-shared.ts";

/** Prefix of the private route (versioned: tb-views may run one release ahead of the bridge for a minute). */
export const VIEWS_ROUTE_PREFIX = "/tb/v1/views";

/** Does the manifest declare the (single) viewer route? */
function hasViewerRoute(app: AppRuntime): boolean {
  return !!app.manifest?.publicRoutes?.some((r) => r.purpose === "viewer");
}

/** Request headers a views request must not carry (the edge strips them; a bridge that still sees one refuses). */
function forbiddenHeader(headers: IncomingMessage["headers"]): boolean {
  for (const name of Object.keys(headers)) if (name === "cookie" || name === "authorization" || (name.startsWith("tb-") && name !== VIEWS_KEY_HEADER)) return true;
  return false;
}

export class ViewsRoute {
  private readonly ctx: BridgeContext;
  private readonly limits: ViewsLimits;
  private inFlight = 0;

  constructor(ctx: BridgeContext, limits: Partial<ViewsLimits> = {}) {
    this.ctx = ctx;
    this.limits = { inFlight: VIEWS_ROUTE_MAX_IN_FLIGHT, maxBytes: VIEWS_MAX_BODY, timeoutMs: VIEWS_TIMEOUT_MS, ...limits };
  }

  /** Requests the route is serving right now (for tests and drain). */
  get active(): number {
    return this.inFlight;
  }

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const ctx = this.ctx;
    // 1. the key. Missing, wrong or unset: the same 404 any unknown path gets.
    if (!ctx.viewsKeyMatches(headerValue(req, VIEWS_KEY_HEADER))) return sendJson(res, 404, envelope("not_found", "not found", requestId));
    if (req.method !== "GET") return sendViewerError(res, 405, "method_not_allowed", "GET only", { allow: "GET" });
    if (forbiddenHeader(req.headers)) {
      ctx.log.warn("bridge.views.request_refused", { code: "forbidden_header" });
      return sendViewerError(res, 400, "viewer_request_refused", "a views request carries no Cookie, Authorization or TB- header");
    }
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === `${VIEWS_ROUTE_PREFIX}/_ready`) {
      const ready = !!ctx.table && !ctx.draining;
      return sendViewerJson(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
    }
    const target = viewerTarget(req.url, VIEWS_ROUTE_PREFIX);
    if (!target) return sendViewerError(res, 404, "not_found", "not found");
    // 2. routing: the instance whose manifest has a viewer public route
    const t = ctx.table;
    if (!t) return sendViewerError(res, 503, "app_unavailable", "the bridge is starting; try again in a few seconds", { "retry-after": "5" });
    const app = t.appsByProduct.get(target.product);
    if (app && (app.down || !app.manifest)) return sendViewerError(res, 503, "app_unavailable", "the app is starting; try again in a few seconds", { "retry-after": "5" });
    if (!app || !hasViewerRoute(app)) return sendViewerError(res, 404, "not_found", "not found");
    // 3. pause (workspace or this instance, from the signed config). A config too old to prove "not paused" fails closed.
    if (t.pausedWorkspace || t.pausedInstances.has(app.entry.ins)) return sendViewerError(res, 503, "paused", "this page is paused");
    if (ctx.configExpired()) return sendViewerError(res, 503, "config_expired", "the bridge has no current configuration", { "retry-after": "30" });
    if (ctx.draining) return sendViewerError(res, 503, "temporarily_unavailable", "the bridge is restarting; retry in a few seconds", { "retry-after": "2" });
    // 4. the route's own in-flight cap, so viewer traffic cannot starve /mcp
    if (this.inFlight >= this.limits.inFlight) return sendViewerError(res, 503, "temporarily_unavailable", "the viewer is busy; retry in a moment", { "retry-after": "2" });
    this.inFlight += 1;
    try {
      const url = new URL(`/v/${target.product}${target.rest}${target.search}`, app.entry.internalUrl);
      let raw: Awaited<ReturnType<typeof getCapped>>;
      try {
        raw = await getCapped(url, viewerRequestHeaders(req.headers), { timeoutMs: this.limits.timeoutMs, maxBytes: this.limits.maxBytes });
      } catch (e) {
        return sendFetchError(res, e, "the app");
      }
      // 5. the same shaping tb-views applies (floor, dropped headers, the `_d` gate): defence in depth
      const answer = shapeViewerAnswer(raw, target);
      if (!answer) {
        ctx.log.warn("bridge.views.document_unsafe", { ins: app.entry.ins, code: "viewer_document_unsafe" });
        return sendViewerError(res, 502, "viewer_document_unsafe", "this document's content-security-policy is not a safe sandbox");
      }
      writeViewerAnswer(res, answer);
    } finally {
      this.inFlight -= 1;
    }
  }
}
