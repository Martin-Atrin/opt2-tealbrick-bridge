/**
 * MCP surface (BRIDGE §7): Streamable HTTP at /mcp (POST JSON-RPC, GET SSE for notifications,
 * DELETE ends the session). Tools come from grants; skills are resources + an instructions index +
 * the `<product>__tb_skills` fallback tool. Every request re-authenticates the agent (K5).
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HeldToolResult } from "@opt2-tealbrick/spec/bridge";
import { TOOL_NAME_RULE } from "@opt2-tealbrick/spec/bridge";
import type { AgentId, ConnectionId } from "@opt2-tealbrick/spec/credentials";
import type { Skill } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "./api.ts";
import type { CallRouter } from "./calls.ts";
import { BRIDGE_VERSION, type BridgeContext, MCP_VERSIONS } from "./context.ts";
import { authenticateAgent } from "./identity.ts";
import type { Table } from "./table.ts";
import { agentPausedOrEmpty, buildToolIndex, grantedProducts, type ToolIndex, type ToolRoute } from "./tools.ts";
import { BridgeError, envelope, headerValue, isRecord, readBody, sendError, sendJson, TokenBucket } from "./util.ts";

interface Session {
  id: string;
  agt: AgentId;
  con: ConnectionId;
  protocol: string;
  streams: Set<ServerResponse>;
  toolDigest: string;
  skillsDigest: string;
  lastSeen: number;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const MAX_BODY = 2 * 1024 * 1024;
const SESSION_IDLE_MS = 3600_000;

/** Per-connection and global limits (BSD-02); counted per verified `con`, after K5 verification. */
export const MCP_LIMITS = Object.freeze({
  sessionsPerConnection: 16,
  streamsPerSession: 2,
  /** POST /mcp token bucket per connection */
  ratePerS: 10,
  burst: 40,
  callsPerConnection: 8,
  callsGlobal: 256,
});

type Principal = { agt: AgentId; con: ConnectionId };

export class McpServer {
  private readonly ctx: BridgeContext;
  private readonly router: CallRouter;
  /** insertion order = least recently used first (a touched session moves to the end) */
  private readonly sessions = new Map<string, Session>();
  private readonly indexCache = new Map<string, Promise<ToolIndex>>();
  private readonly postBucket = new TokenBucket(MCP_LIMITS.ratePerS, MCP_LIMITS.burst);
  private readonly callsByCon = new Map<string, number>();
  private callsInFlight = 0;

  constructor(ctx: BridgeContext, router: CallRouter) {
    this.ctx = ctx;
    this.router = router;
    ctx.on("table", () => {
      this.indexCache.clear();
      void this.notifyChanges();
    });
    ctx.on("connection-revoked", (con: string) => {
      for (const [id, s] of this.sessions) if (s.con === con) this.endSession(id);
    });
    setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) if (now - s.lastSeen > SESSION_IDLE_MS && s.streams.size === 0) this.sessions.delete(id);
    }, 600_000).unref();
  }

  /** The caller's own live session: same agent AND same connection (H-4); touching it marks it recently used. */
  private sessionFor(sid: string | undefined, p: Principal): Session | undefined {
    const s = sid ? this.sessions.get(sid) : undefined;
    if (!s || s.agt !== p.agt || s.con !== p.con) return undefined;
    if (Date.now() - s.lastSeen > SESSION_IDLE_MS && s.streams.size === 0) {
      this.endSession(s.id);
      return undefined;
    }
    s.lastSeen = Date.now();
    this.sessions.delete(s.id);
    this.sessions.set(s.id, s);
    return s;
  }

  /** Adds a session; past the per-connection cap the least recently used session of that connection ends. */
  private addSession(s: Session): void {
    const mine = [...this.sessions.values()].filter((x) => x.con === s.con);
    for (let i = 0; i <= mine.length - MCP_LIMITS.sessionsPerConnection; i++) this.endSession((mine[i] as Session).id);
    this.sessions.set(s.id, s);
  }

  private index(t: Table, agt: AgentId): Promise<ToolIndex> {
    const key = `${t.rev}|${agt}`;
    let p = this.indexCache.get(key);
    if (!p) {
      p = buildToolIndex(this.ctx, this.router, t, agt);
      this.indexCache.set(key, p);
      p.catch(() => this.indexCache.delete(key));
    }
    return p;
  }

  private skillsFor(t: Table, agt: AgentId) {
    const products = grantedProducts(t, agt);
    return t.config.skills.files.filter((f) => products.has(f.product));
  }

  private instructions(t: Table, agt: AgentId): string {
    if (agentPausedOrEmpty(t, agt)) return "Teal Brick: this agent is paused by the owner. No tools are available until the owner resumes it.";
    const lines = [
      "Teal Brick apps are available as tools named <product>__<operation>.",
      `When a tool result has status "held", the owner must approve it in the app; check it later with the tool named in "checkWith" (<product>__${TOOL_NAME_RULE.holdStatusOp}) and repeat the same call once approved.`,
      "Skills (read before first use):",
    ];
    for (const s of this.skillsFor(t, agt)) {
      lines.push(`- ${s.title}${s.when ? ` (when: ${s.when})` : ""}: ${TOOL_NAME_RULE.skillUriPrefix}${s.product}/${s.id} or tool ${s.product}__${TOOL_NAME_RULE.skillsOp} {"skillId":"${s.id}"}`);
    }
    let out = lines.join("\n");
    if (Buffer.byteLength(out) > 4096) out = `${out.slice(0, 4000)}\n…`;
    return out;
  }

  private renderSkill(t: Table, agt: AgentId, product: string, id: string): string | undefined {
    const f = t.config.skills.files.find((s) => s.product === product && s.id === id);
    if (!f) return undefined;
    const agent = t.agents.get(agt);
    const skill: Skill = { id: f.id, title: f.title, file: "SKILL.md" };
    return this.ctx.api.renderSkill(skill, f.content, { agent: { id: agt, name: agent?.name ?? agt } });
  }

  /** Pushes list_changed to sessions whose tool or skill set changed. */
  private async notifyChanges(): Promise<void> {
    const t = this.ctx.table;
    if (!t) return;
    for (const s of this.sessions.values()) {
      try {
        const idx = await this.index(t, s.agt);
        const td = this.ctx.api.digest(idx.tools.map((x) => x.name) as Json);
        const sd = this.ctx.api.digest(this.skillsFor(t, s.agt).map((f) => `${f.product}/${f.id}`).concat(t.config.skills.digest) as Json);
        if (s.toolDigest && td !== s.toolDigest) this.push(s, { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        if (s.skillsDigest && sd !== s.skillsDigest) this.push(s, { jsonrpc: "2.0", method: "notifications/resources/list_changed" });
        s.toolDigest = td;
        s.skillsDigest = sd;
      } catch {
        /* next change retries */
      }
    }
  }

  private push(s: Session, message: unknown): void {
    const data = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    for (const res of s.streams) res.write(data);
  }

  private endSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const r of s.streams) r.end();
    this.sessions.delete(id);
  }

  private unauthorized(res: ServerResponse, requestId: string): void {
    sendJson(res, 401, envelope("unauthenticated", "agent session required", requestId), {
      "www-authenticate": `Bearer resource_metadata="${this.ctx.publicUrl}/.well-known/oauth-protected-resource/mcp"`,
    });
  }

  private tooMany(res: ServerResponse, requestId: string, message: string, retryAfterS: number): void {
    sendJson(res, 429, envelope("rate_limited", message, requestId), { "retry-after": String(retryAfterS) });
  }

  async handle(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    let principal: Principal;
    try {
      principal = authenticateAgent(this.ctx, headerValue(req, "authorization"));
    } catch {
      this.unauthorized(res, requestId);
      return;
    }
    const sid = headerValue(req, "mcp-session-id");
    const missingSession = () => sendJson(res, 400, envelope("input_invalid", "Mcp-Session-Id header required", requestId));
    if (req.method === "DELETE") {
      if (!sid) return missingSession();
      const s = this.sessionFor(sid, principal);
      if (!s) {
        sendJson(res, 404, envelope("not_found", "unknown session", requestId));
        return;
      }
      this.endSession(s.id);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET") {
      if (!sid) return missingSession();
      const s = this.sessionFor(sid, principal);
      if (!s) {
        sendJson(res, 404, envelope("not_found", "unknown session", requestId));
        return;
      }
      if (s.streams.size >= MCP_LIMITS.streamsPerSession) return this.tooMany(res, requestId, "too many open streams for this session", 5);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": ok\n\n");
      s.streams.add(res);
      const ka = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ka);
        s.streams.delete(res);
      });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
      return;
    }
    const wait = this.postBucket.take(principal.con);
    if (wait > 0) return this.tooMany(res, requestId, "too many requests for this connection", wait);
    let msg: unknown;
    try {
      const body = await readBody(req, MAX_BODY);
      msg = JSON.parse(body.toString("utf8"));
    } catch (e) {
      if (e instanceof BridgeError) return sendError(res, e, requestId);
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (!isRecord(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      // responses or batches from the client: accepted and ignored (no server→client requests)
      res.writeHead(202).end();
      return;
    }
    const rpc = msg as unknown as RpcRequest;
    const isNotification = rpc.id === undefined;
    let session: Session | undefined;
    if (rpc.method === "initialize") {
      const requested = typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "";
      const protocol = MCP_VERSIONS.includes(requested) ? requested : (MCP_VERSIONS[0] as string);
      const clientName = isRecord(rpc.params?.clientInfo) && typeof rpc.params.clientInfo.name === "string" ? rpc.params.clientInfo.name.slice(0, 64) : "";
      session = { id: randomBytes(16).toString("base64url"), agt: principal.agt, con: principal.con, protocol, streams: new Set(), toolDigest: "", skillsDigest: "", lastSeen: Date.now() };
      this.addSession(session);
      const t = this.ctx.table as Table;
      this.ctx.log.info("bridge.mcp.initialize", { agt: principal.agt, protocol, client: clientName });
      sendJson(
        res,
        200,
        {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: {
            protocolVersion: protocol,
            capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
            serverInfo: { name: "tealbrick-bridge", version: BRIDGE_VERSION },
            instructions: this.instructions(t, principal.agt),
          },
        },
        { "mcp-session-id": session.id },
      );
      return;
    }
    if (!sid) {
      sendJson(res, 400, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32600, message: "Mcp-Session-Id header required (initialize first)" } });
      return;
    }
    session = this.sessionFor(sid, principal);
    if (!session) {
      sendJson(res, 404, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32001, message: "session not found; re-initialize" } });
      return;
    }
    if (isNotification) {
      res.writeHead(202).end();
      return;
    }
    const controller = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const result = await this.dispatch(session, principal, rpc, requestId, controller.signal);
      sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
    } catch (e) {
      // only messages the bridge wrote reach the agent; anything else is a generic internal error (H-7)
      const code = e instanceof RpcError ? e.rpcCode : -32603;
      const message = e instanceof RpcError || e instanceof BridgeError ? e.message : "internal error";
      sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code, message } });
    }
  }

  private async dispatch(s: Session, p: Principal, rpc: RpcRequest, requestId: string, signal: AbortSignal): Promise<unknown> {
    const t = this.ctx.table;
    if (!t) throw new RpcError(-32603, "bridge not ready");
    switch (rpc.method) {
      case "ping":
        return {};
      case "tools/list": {
        const idx = await this.index(t, p.agt);
        s.toolDigest = this.ctx.api.digest(idx.tools.map((x) => x.name) as Json);
        return { tools: idx.tools };
      }
      case "resources/list": {
        const files = this.skillsFor(t, p.agt);
        s.skillsDigest = this.ctx.api.digest(files.map((f) => `${f.product}/${f.id}`).concat(t.config.skills.digest) as Json);
        return {
          resources: files.map((f) => ({ uri: `${TOOL_NAME_RULE.skillUriPrefix}${f.product}/${f.id}`, name: `${f.product}/${f.id}`, title: f.title, description: f.when ?? f.title, mimeType: "text/markdown" })),
        };
      }
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "resources/read": {
        const uri = typeof rpc.params?.uri === "string" ? rpc.params.uri : "";
        const m = /^tealbrick:\/\/skills\/([a-z][a-z0-9-]{1,31})\/([a-z][a-z0-9-]{1,39})$/.exec(uri);
        if (!m || !grantedProducts(t, p.agt).has(m[1] as string)) throw new RpcError(-32002, "resource not found");
        const text = this.renderSkill(t, p.agt, m[1] as string, m[2] as string);
        if (text === undefined) throw new RpcError(-32002, "resource not found");
        return { contents: [{ uri, mimeType: "text/markdown", text }] };
      }
      case "prompts/list":
        return { prompts: [] };
      case "tools/call":
        return this.callTool(t, p, rpc.params ?? {}, requestId, signal);
      default:
        throw new RpcError(-32601, "method not found");
    }
  }

  private async callTool(t: Table, p: Principal, params: Record<string, unknown>, requestId: string, signal: AbortSignal): Promise<unknown> {
    const name = typeof params.name === "string" ? params.name : "";
    const args = (isRecord(params.arguments) ? params.arguments : {}) as Json;
    const meta = isRecord(params._meta) ? params._meta : {};
    const idem = meta[TOOL_NAME_RULE.idempotencyMetaKey];
    if (idem !== undefined && (typeof idem !== "string" || idem.length < 8 || idem.length > 128)) {
      return toolError("input_invalid", "idempotency key must be 8–128 chars", requestId);
    }
    const inFlight = this.callsByCon.get(p.con) ?? 0;
    if (inFlight >= MCP_LIMITS.callsPerConnection) return toolError("rate_limited", "too many concurrent calls for this connection; retry shortly", requestId);
    if (this.callsInFlight >= MCP_LIMITS.callsGlobal) return toolError("rate_limited", "the bridge is busy; retry shortly", requestId);
    this.callsByCon.set(p.con, inFlight + 1);
    this.callsInFlight += 1;
    try {
      // pause is gate step 1: a paused agent or workspace is told `paused`, not that the tool is unknown
      if (t.pausedWorkspace || t.pausedAgents.has(p.agt)) throw new BridgeError("paused", 403, "paused by the owner");
      const idx = await this.index(t, p.agt);
      const route = idx.routes.get(name);
      if (!route) {
        // a tool of an app that is temporarily unavailable (restart, update) is not "unknown" (C57)
        const app = t.appsByProduct.get(name.split("__")[0] ?? "");
        if (app && (app.down || !app.manifest) && t.grants.has(`tb:agt:${p.agt}|tb:ins:${app.entry.ins}`)) {
          throw new BridgeError("app_unavailable", 503, "the app is starting; try again in a few seconds");
        }
        throw new BridgeError("unknown_tool", 404);
      }
      return await this.runRoute(t, p, route, args, idem as string | undefined, requestId, signal);
    } catch (e) {
      const code = e instanceof BridgeError ? e.code : "app_error";
      const message = e instanceof BridgeError ? e.message : "internal error";
      return toolError(code, message, requestId);
    } finally {
      this.callsInFlight -= 1;
      const left = (this.callsByCon.get(p.con) ?? 1) - 1;
      if (left <= 0) this.callsByCon.delete(p.con);
      else this.callsByCon.set(p.con, left);
    }
  }

  private async runRoute(t: Table, p: Principal, route: ToolRoute, args: Json, idem: string | undefined, _requestId: string, signal: AbortSignal): Promise<unknown> {
    const caller = { type: "agent" as const, agt: p.agt, con: p.con };
    if (route.kind === "skills") {
      const skillId = isRecord(args) && typeof args.skillId === "string" ? args.skillId : undefined;
      if (!skillId) {
        const index = t.config.skills.files.filter((f) => f.product === route.app.entry.product).map((f) => ({ skillId: f.id, title: f.title, ...(f.when ? { when: f.when } : {}) }));
        return toolOk({ skills: index });
      }
      const text = this.renderSkill(t, p.agt, route.app.entry.product, skillId);
      if (text === undefined) throw new BridgeError("unknown_tool", 404, "unknown skill");
      return { content: [{ type: "text", text }], structuredContent: { skillId, text } };
    }
    if (route.kind === "dynamic_search") {
      if (agentPausedOrEmpty(t, p.agt)) throw new BridgeError("paused", 403);
      const query = isRecord(args) && typeof args.query === "string" ? args.query : "";
      if (!query) throw new BridgeError("input_invalid", 400, "query required");
      const limit = isRecord(args) && typeof args.limit === "number" ? Math.min(Math.max(1, Math.floor(args.limit)), 50) : undefined;
      const grant = [...t.grants.values()].find((g) => g.claims.sub === `tb:agt:${p.agt}` && g.claims.aud === `tb:ins:${route.app.entry.ins}`);
      const entries = await this.router.search(route.app, route.op.id, query, limit);
      const visible = entries.filter((e) => grant && e.crud.every((c) => grant.claims.crud.includes(c)));
      return toolOk({ tools: visible.map((e) => ({ tool: e.name, title: e.title, description: e.description, inputSchema: e.inputSchema as Json, effect: e.effect })) });
    }
    let input: Json = args;
    let tool: string | undefined;
    if (route.kind === "dynamic_entry") {
      tool = route.entry;
      input = { tool: route.entry, arguments: args as Record<string, Json> };
    } else if (route.kind === "dynamic_call") {
      tool = isRecord(args) && typeof args.tool === "string" ? args.tool : undefined;
      if (!tool) throw new BridgeError("input_invalid", 400, "tool required");
    }
    const { result } = await this.router.route({
      caller,
      target: { app: route.app, op: route.op, ...(tool ? { tool } : {}) },
      input,
      ...(idem ? { idempotencyKey: idem } : {}),
      signal,
    });
    if (result.status === "held") {
      const held: HeldToolResult = { status: "held", holdId: result.holdId, expiresAt: result.expiresAt, checkWith: `${route.app.entry.product}__${TOOL_NAME_RULE.holdStatusOp}` };
      return { content: [{ type: "text", text: `Waiting for the owner's approval in ${route.app.manifest?.name ?? route.app.entry.product}. ${JSON.stringify(held)}` }], structuredContent: held, isError: false };
    }
    return toolOk(result.output as Json);
  }
}

class RpcError extends Error {
  readonly rpcCode: number;
  constructor(code: number, message: string) {
    super(message);
    this.rpcCode = code;
  }
}

function toolOk(output: Json): unknown {
  const structured = isRecord(output) ? output : { value: output };
  return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: structured };
}

function toolError(code: string, message: string, requestId: string): unknown {
  const env = envelope(code, message, requestId);
  return { content: [{ type: "text", text: JSON.stringify(env) }], structuredContent: env, isError: true };
}
