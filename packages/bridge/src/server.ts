/**
 * Deployed (full) bridge: wires state, Portal link, routing, MCP, OAuth, person surfaces and the
 * internal API onto two listeners (BRIDGE §3). Used by bridge-server and `tealbrick bridge run`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ManifestApi } from "./api.ts";
import { CallRouter } from "./calls.ts";
import { BridgeContext } from "./context.ts";
import { InternalApi } from "./internal.ts";
import { McpServer } from "./mcp.ts";
import { OAuthServer } from "./oauth.ts";
import { PersonSurfaces } from "./person.ts";
import { applyConfig, ensureEnrolled, runConfigLoop, startStatusLoop } from "./portal.ts";
import { remintStandalone, StandaloneAdmin, startStandaloneLoop } from "./standalone.ts";
import { BridgeState, keksFromEnv } from "./state.ts";
import { assertOrigin, envelope, jsonLogger, type Logger, sendError, sendJson } from "./util.ts";

export interface BridgeServerOptions {
  api: ManifestApi;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  fetch?: typeof fetch;
  /** own infrastructure (CLI `bridge enrol/run`) instead of a Railway deploy */
  form?: "deployed" | "own_infra";
  /** test hook: listen on these instead of env ports (0 = any free port) */
  ports?: { public: number; internal: number };
}

export interface RunningBridge {
  ctx: BridgeContext;
  publicServer: Server;
  internalServer: Server;
  stop(): Promise<void>;
}

/** One request id per request; never derived from client input. */
function requestIdOf(ctx: BridgeContext): string {
  return `req_${ctx.api.ulid()}`;
}

/**
 * Own-infrastructure bridge without a provider-generated KEK: create it once under TB_DATA_DIR
 * (0600, excluded from backups by living outside bridge/), CORE I3 / CREDENTIALS §9.1.
 */
export function ownInfraEnv(env: NodeJS.ProcessEnv, api: ManifestApi): NodeJS.ProcessEnv {
  if (env.TB_KEK || !env.TB_DATA_DIR) return env;
  const path = join(env.TB_DATA_DIR, "kek");
  if (!existsSync(path)) {
    mkdirSync(env.TB_DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, api.opaqueValue("tbe_").slice(4), { mode: 0o600, flag: "wx" });
  }
  return { ...env, TB_KEK: readFileSync(path, "utf8").trim() };
}

/** Enrols (or re-enrols on a new code) and stops: `tealbrick bridge enrol` (CLI.md §5). */
export async function enrolBridge(o: { api: ManifestApi; env: NodeJS.ProcessEnv; logger?: Logger; fetch?: typeof fetch; form?: "deployed" | "own_infra" }): Promise<{ bridgeId: string; workspaceId: string }> {
  const env = o.env;
  if (!env.TB_DATA_DIR) throw new Error("TB_DATA_DIR is required");
  const state = new BridgeState(env.TB_DATA_DIR, o.api, keksFromEnv(env, o.api));
  state.load();
  const ctx = new BridgeContext({
    api: o.api,
    state,
    logger: o.logger ?? jsonLogger(),
    portalUrl: assertOrigin(env.TB_PORTAL_URL ?? "", "TB_PORTAL_URL"),
    publicUrl: assertOrigin(env.TB_PUBLIC_URL ?? "", "TB_PUBLIC_URL"),
    internalUrl: `http://${hostname()}:${Number(env.TB_INTERNAL_PORT ?? 8788)}`,
    form: o.form ?? "own_infra",
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  await ensureEnrolled(ctx, env.TB_ENROL_CODE);
  if (!ctx.identity) throw new Error("enrolment failed");
  return { bridgeId: ctx.identity.bridgeId, workspaceId: ctx.identity.workspaceId };
}

export async function startBridge(o: BridgeServerOptions): Promise<RunningBridge> {
  const env = o.env ?? process.env;
  const logger = o.logger ?? jsonLogger();
  const dataDir = env.TB_DATA_DIR;
  if (!dataDir) throw new Error("TB_DATA_DIR is required");
  const portalUrl = assertOrigin(env.TB_PORTAL_URL ?? "", "TB_PORTAL_URL");
  const publicUrl = assertOrigin(env.TB_PUBLIC_URL ?? "", "TB_PUBLIC_URL");
  const internalPort = o.ports?.internal ?? Number(env.TB_INTERNAL_PORT ?? 8788);
  const publicPort = o.ports?.public ?? Number(env.PORT ?? 8080);
  const keks = keksFromEnv(env, o.api);
  const state = new BridgeState(dataDir, o.api, keks);
  state.load();
  const privateHost = env.RAILWAY_PRIVATE_DOMAIN || hostname();
  const ctx = new BridgeContext({
    api: o.api,
    state,
    logger,
    portalUrl,
    publicUrl,
    internalUrl: `http://${privateHost}:${internalPort}`,
    form: o.form ?? "deployed",
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  await ensureEnrolled(ctx, env.TB_ENROL_CODE);
  const s2 = state.loadConfigJws();
  if (s2) {
    await applyConfig(ctx, s2, { boot: true });
    if (ctx.table?.config.standalone || state.standalone) await remintStandalone(ctx);
  }

  const router = new CallRouter(ctx);
  const mcp = new McpServer(ctx, router);
  const oauth = new OAuthServer(ctx, keks.current);
  const person = new PersonSurfaces(ctx);
  const internal = new InternalApi(ctx, router);
  const admin = new StandaloneAdmin(ctx);

  const abort = new AbortController();
  const status = startStatusLoop(ctx, abort.signal);
  for (const ev of ["claim", "keys", "health", "connection-created", "connection-revoked"]) ctx.on(ev, () => status.poke());
  void runConfigLoop(ctx, abort.signal);
  startStandaloneLoop(ctx, abort.signal);

  const publicHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = requestIdOf(ctx);
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      if (path === "/healthz") return sendJson(res, 200, { status: "ok" });
      if (path === "/readyz") return ctx.identity && ctx.table ? sendJson(res, 200, { status: "ready" }) : sendJson(res, 503, { status: "starting" });
      if (path === "/mcp") return await mcp.handle(req, res, requestId);
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") return oauth.protectedResource(res);
      if (path === "/.well-known/oauth-authorization-server") return oauth.authorizationServer(res);
      if (path === "/oauth/register" && req.method === "POST") return await oauth.register(req, res);
      if (path === "/oauth/authorize" && (req.method === "GET" || req.method === "POST")) return await oauth.authorize(req, res);
      if (path === "/oauth/pair/callback" && req.method === "POST") return await oauth.pairCallback(req, res);
      if (path === "/oauth/token" && req.method === "POST") return await oauth.token(req, res);
      if (path === "/oauth/revoke" && req.method === "POST") return await oauth.revoke(req, res);
      if (path.startsWith("/a/")) return await person.app(req, res, requestId);
      if (path.startsWith("/p/")) return await person.publicRoute(req, res, requestId);
      if (path === "/keys" && (req.method === "GET" || req.method === "POST")) return await person.keys(req, res);
      if (path.startsWith("/admin/v1/")) return await admin.handle(req, res, requestId);
      sendJson(res, 404, envelope("not_found", "not found", requestId));
    } catch (e) {
      sendError(res, e, requestId);
    }
  };
  const internalHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = requestIdOf(ctx);
    try {
      await internal.handle(req, res, requestId);
    } catch (e) {
      sendError(res, e, requestId);
    }
  };

  const publicServer = createServer({ requestTimeout: 0, headersTimeout: 30_000 }, (req, res) => void publicHandler(req, res));
  publicServer.on("upgrade", (req, socket, head) => person.upgrade(req, socket as never, head));
  const internalServer = createServer({ requestTimeout: 0, headersTimeout: 30_000 }, (req, res) => void internalHandler(req, res));
  await Promise.all([
    new Promise<void>((r) => publicServer.listen(publicPort, r)),
    new Promise<void>((r) => internalServer.listen(internalPort, r)),
  ]);
  logger.info("bridge.listening", { bridge: ctx.identity?.bridgeId, rev: ctx.table?.rev ?? 0 });

  return {
    ctx,
    publicServer,
    internalServer,
    async stop() {
      abort.abort();
      publicServer.closeAllConnections();
      internalServer.closeAllConnections();
      await Promise.all([new Promise((r) => publicServer.close(r)), new Promise((r) => internalServer.close(r))]);
    },
  };
}
