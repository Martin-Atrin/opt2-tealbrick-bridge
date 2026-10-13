/**
 * Local relay (C5, BRIDGE §2, C24): stdio MCP downstream, the deployed bridge upstream. Holds only
 * the agent identity (a signer for K4 assertions) and a K5 access token in memory. Forwards JSON-RPC
 * verbatim; runs no gate(), hooks or checks. No loopback listener exists (CORE I5).
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { type AgentAssertionClaims, type AgentId, type ConnectionId, type Ed25519PublicJwk, LIFETIME_S, OAUTH_GRANT_TYPES, TYP } from "@opt2-tealbrick/spec/credentials";
import type { ManifestApi } from "./api.ts";

export type RelayStatus = "connected" | "connection_unknown" | "paused" | "revoked" | "offline";

/** The agent key (K4) lives with the caller (OS keychain, TBD Secure Enclave); the relay only asks for signatures. */
export interface RelaySigner {
  /** Ed25519 signature over the JWS signing input (ASCII `header.payload`), base64url. */
  sign(jwsInput: string): Promise<string> | string;
  publicJwk(): Ed25519PublicJwk;
}

export interface RelayOptions {
  /** Manifest package (JWS assembly through `signJwsWithSigner`, thumbprint, ulid). */
  api: Pick<ManifestApi, "thumbprint" | "ulid"> & { signJwsWithSigner: SignWithSigner };
  /** deployed bridge origin, e.g. https://bridge.example */
  bridgeUrl: string;
  connection: { con: ConnectionId; agt: AgentId; bridgeId: `brg_${string}` };
  signer: RelaySigner;
  onStatus?: (status: RelayStatus, detail?: string) => void;
  stdin?: Readable;
  stdout?: Writable;
  fetch?: typeof fetch;
  /**
   * v0.1.13 (G4b): `_meta` entries added to every `tools/call` (e.g. `tealbrick/onBehalfOf` for the turn's message
   * sender, set by `tealbrick agent serve`). Keys the MCP client sets itself win. No check runs here: the bridge
   * validates the claim and treats it as unverified.
   */
  toolCallMeta?: Record<string, unknown>;
  /**
   * F72: one line per re-send of a tool call during a bridge drain (`relay.retry` {tool, code, retryAfter, attempt}) and
   * when the window ends (`relay.retry_gave_up`). The tool name only, never the arguments.
   */
  onEvent?: (event: "relay.retry" | "relay.retry_gave_up", fields: Record<string, unknown>) => void;
}

export type SignWithSigner = (typ: (typeof TYP)[keyof typeof TYP], claims: object, signer: { kid: string; sign(input: string): Promise<string> | string }) => Promise<string>;

export interface RunningRelay {
  stop(): void;
  done: Promise<void>;
}

interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export function startRelay(o: RelayOptions): RunningRelay {
  const f = o.fetch ?? fetch;
  const origin = new URL(o.bridgeUrl).origin;
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const abort = new AbortController();
  let access: { token: string; exp: number } | undefined;
  let session: string | undefined;
  let initRequest: RpcMessage | undefined;
  let lastStatus: RelayStatus | undefined;
  let sse: AbortController | undefined;
  const status = (s: RelayStatus, detail?: string) => {
    if (s === lastStatus) return;
    lastStatus = s;
    o.onStatus?.(s, detail);
  };
  const write = (m: unknown) => stdout.write(`${JSON.stringify(m)}\n`);

  async function token(force = false): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (!force && access && access.exp - 60 > now) return access.token;
    const kid = o.api.thumbprint(o.signer.publicJwk());
    const claims: AgentAssertionClaims = {
      iss: `tb:agt:${o.connection.agt}`,
      sub: `tb:agt:${o.connection.agt}`,
      aud: `tb:brg:${o.connection.bridgeId}`,
      iat: now,
      exp: now + LIFETIME_S.proof,
      jti: o.api.ulid(),
      con: o.connection.con,
    };
    const assertion = await o.api.signJwsWithSigner(TYP.agentAssertion, claims, { kid, sign: (i) => o.signer.sign(i) });
    let res: Response;
    try {
      res = await f(`${origin}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: OAUTH_GRANT_TYPES.jwtBearer, assertion }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      status("offline");
      throw new RelayError(-32002, "bridge unreachable", isPreConnect(e));
    }
    if (res.status >= 500) {
      // F57a: a bridge that is starting (or a gateway in front of a restarting one) is not a revocation
      await res.body?.cancel().catch(() => undefined);
      status("offline");
      throw new RelayError(-32002, "bridge unreachable", true);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      if (body.error_description === "connection_unknown") {
        status("connection_unknown");
        throw new RelayError(-32001, "connection not active yet; the owner must approve it in Portal");
      }
      status("revoked");
      throw new RelayError(-32001, "connection revoked or not accepted");
    }
    access = { token: body.access_token, exp: now + (body.expires_in ?? 900) };
    status("connected");
    return access.token;
  }

  /** `meta.retryAfterS` receives the answer's Retry-After (F57a). */
  async function post(m: RpcMessage, retry = true, meta: { retryAfterS?: number } = {}): Promise<RpcMessage[]> {
    const t = await token();
    let res: Response;
    try {
      res = await f(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${t}`,
          ...(session && m.method !== "initialize" ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify(m),
        redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      });
    } catch (e) {
      status("offline");
      // refused before any byte was sent: nothing ran (F57a re-sends only such failures)
      throw new RelayError(-32002, "bridge unreachable", isPreConnect(e));
    }
    if (res.status === 401 && retry) {
      await res.body?.cancel().catch(() => undefined);
      await token(true);
      return post(m, false, meta);
    }
    if (res.status === 404 && retry && m.method !== "initialize" && initRequest) {
      // session lost at the bridge (restart): re-initialize transparently, then retry once
      await res.body?.cancel().catch(() => undefined);
      session = undefined;
      await post({ ...initRequest, id: `relay-reinit-${Date.now()}` }, false);
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
      return post(m, false, meta);
    }
    if (m.method === "initialize") {
      const sid = res.headers.get("mcp-session-id");
      if (sid) {
        session = sid;
        openNotifications();
      }
    }
    if (res.status === 202 || res.status === 204) return [];
    const ct = res.headers.get("content-type") ?? "";
    let text: string;
    try {
      text = await res.text();
    } catch {
      // F26: the bridge went away mid-response (restart, update): never leave the request without an answer
      status("offline");
      throw new RelayError(-32603, "bridge connection lost");
    }
    const ra = Number(res.headers.get("retry-after") ?? "");
    if (Number.isFinite(ra) && ra > 0) meta.retryAfterS = ra;
    if (ct.includes("text/event-stream")) return parseSse(text);
    try {
      const v = JSON.parse(text) as RpcMessage | RpcMessage[];
      return Array.isArray(v) ? v : [v];
    } catch {
      // a gateway answer (502/503/504, not JSON) in front of a bridge that is down: the request never reached it
      throw new RelayError(-32603, `bridge answered ${res.status}`, res.status >= 502 && res.status <= 504);
    }
  }

  /**
   * F57a / L21: a tools/call the bridge refused while draining (restart, update) did not run. Re-send it after
   * Retry-After until the new instance answers; while the bridge is away, failures that prove nothing ran (refused
   * connection, gateway answer, bridge starting) are retried too. Bounded by RELAY_DRAIN_WINDOW_MS from the first
   * refusal; then the last answer goes to the client. Calls that were not refused are never re-sent.
   */
  async function postToolCall(m: RpcMessage): Promise<RpcMessage[]> {
    let deadline = 0;
    let waitS = 2;
    let attempt = 0;
    const tool = typeof (m.params as { name?: unknown } | undefined)?.name === "string" ? (m.params as { name: string }).name : "?";
    const event = (e: "relay.retry" | "relay.retry_gave_up", fields: Record<string, unknown>) => o.onEvent?.(e, { tool, attempt, ...fields });
    for (;;) {
      const meta: { retryAfterS?: number } = {};
      let out: RpcMessage[];
      try {
        out = await post(m, true, meta);
      } catch (e) {
        if (!deadline || !(e instanceof RelayError && e.nothingRan)) throw e;
        if (Date.now() >= deadline) {
          event("relay.retry_gave_up", { code: "bridge_unreachable" });
          throw e;
        }
        attempt += 1;
        event("relay.retry", { code: "bridge_unreachable", retryAfter: waitS });
        await sleepS(waitS, abort.signal);
        continue;
      }
      // the bridge's drain refusal = this code AND Retry-After (an app's own look-alike code carries no Retry-After)
      if (meta.retryAfterS === undefined || !out.some((r) => r.id === m.id && drainingResult(r))) return out;
      if (!deadline) deadline = Date.now() + RELAY_DRAIN_WINDOW_MS;
      if (Date.now() >= deadline || abort.signal.aborted) {
        event("relay.retry_gave_up", { code: "temporarily_unavailable" });
        return out;
      }
      waitS = Math.min(Math.max(meta.retryAfterS ?? 2, 1), 10);
      attempt += 1;
      event("relay.retry", { code: "temporarily_unavailable", retryAfter: waitS });
      await sleepS(waitS, abort.signal);
    }
  }

  /** Server→client notifications (list_changed) over the session's GET stream. */
  function openNotifications(): void {
    sse?.abort();
    const ctl = new AbortController();
    sse = ctl;
    void (async () => {
      while (!ctl.signal.aborted && !abort.signal.aborted && session) {
        try {
          const res = await f(`${origin}/mcp`, {
            headers: { accept: "text/event-stream", authorization: `Bearer ${await token()}`, "mcp-session-id": session },
            signal: AbortSignal.any([ctl.signal, abort.signal]),
          });
          if (!res.ok || !res.body) {
            await res.body?.cancel().catch(() => undefined);
            await new Promise((r) => setTimeout(r, 5_000));
            continue;
          }
          let buf = "";
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            buf += Buffer.from(chunk).toString("utf8");
            let i = buf.indexOf("\n\n");
            while (i >= 0) {
              for (const m of parseSse(buf.slice(0, i + 2))) write(m);
              buf = buf.slice(i + 2);
              i = buf.indexOf("\n\n");
            }
          }
        } catch {
          if (ctl.signal.aborted || abort.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    })();
  }

  const rl = createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const queue: Promise<void>[] = [];
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let m: RpcMessage;
    try {
      m = JSON.parse(line) as RpcMessage;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (m.method === "initialize") initRequest = m;
    if (o.toolCallMeta && m.method === "tools/call" && m.params && typeof m.params === "object") {
      const params = m.params as { _meta?: unknown };
      const own = params._meta && typeof params._meta === "object" ? (params._meta as Record<string, unknown>) : {};
      m = { ...m, params: { ...params, _meta: { ...o.toolCallMeta, ...own } } };
    }
    const p = (async () => {
      try {
        const out = m.method === "tools/call" ? await postToolCall(m) : await post(m);
        for (const r of out) {
          if (isPausedResult(r)) status("paused");
          write(r);
        }
        // F26 / L21: a request (it has an id) ALWAYS gets an answer. An empty or cut-off stream, or a 202/204, means the
        // bridge restarted mid-call: answer with an error so the client can retry instead of waiting forever.
        if (m.id !== undefined && m.method !== undefined && !out.some((r) => r.id === m.id)) {
          write({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "bridge connection lost" } });
        }
      } catch (e) {
        if (m.id !== undefined) write({ jsonrpc: "2.0", id: m.id, error: { code: e instanceof RelayError ? e.rpcCode : -32603, message: e instanceof Error ? e.message : "relay error" } });
      }
    })();
    queue.push(p);
    void p.finally(() => queue.splice(queue.indexOf(p), 1));
  });
  const done = new Promise<void>((resolve) => {
    rl.on("close", async () => {
      await Promise.allSettled(queue);
      sse?.abort();
      abort.abort();
      resolve();
    });
  });
  return {
    stop() {
      rl.close();
      sse?.abort();
      abort.abort();
    },
    done,
  };
}

class RelayError extends Error {
  readonly rpcCode: number;
  /** F57a: the request provably never reached the bridge (safe to re-send) */
  readonly nothingRan: boolean;
  constructor(code: number, message: string, nothingRan = false) {
    super(message);
    this.rpcCode = code;
    this.nothingRan = nothingRan;
  }
}

/** connection refused or no address: no byte reached the bridge */
const PRE_CONNECT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
function isPreConnect(e: unknown): boolean {
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  return !!code && PRE_CONNECT.has(code);
}

function sleepS(s: number, signal: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, s * 1000);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      r();
    }, { once: true });
  });
}

function parseSse(text: string): RpcMessage[] {
  const out: RpcMessage[] = [];
  for (const block of text.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as RpcMessage);
    } catch {
      /* ignore non-JSON events */
    }
  }
  return out;
}

function isPausedResult(m: RpcMessage): boolean {
  const r = m.result as { isError?: boolean; structuredContent?: { error?: { code?: string } } } | undefined;
  return !!r?.isError && r.structuredContent?.error?.code === "paused";
}

/** F57a: how long the relay keeps re-sending a tool call the bridge refused while draining (drain ≤ 25 s + restart) */
export const RELAY_DRAIN_WINDOW_MS = 90_000;

function drainingResult(r: RpcMessage): boolean {
  const res = (r as { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } }).result;
  return res?.isError === true && res.structuredContent?.error?.code === "temporarily_unavailable";
}

