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
    } catch {
      status("offline");
      throw new RelayError(-32002, "bridge unreachable");
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

  async function post(m: RpcMessage, retry = true): Promise<RpcMessage[]> {
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
    } catch {
      status("offline");
      throw new RelayError(-32002, "bridge unreachable");
    }
    if (res.status === 401 && retry) {
      await res.body?.cancel().catch(() => undefined);
      await token(true);
      return post(m, false);
    }
    if (res.status === 404 && retry && m.method !== "initialize" && initRequest) {
      // session lost at the bridge (restart): re-initialize transparently, then retry once
      await res.body?.cancel().catch(() => undefined);
      session = undefined;
      await post({ ...initRequest, id: `relay-reinit-${Date.now()}` }, false);
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
      return post(m, false);
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
    const text = await res.text();
    if (ct.includes("text/event-stream")) return parseSse(text);
    try {
      const v = JSON.parse(text) as RpcMessage | RpcMessage[];
      return Array.isArray(v) ? v : [v];
    } catch {
      throw new RelayError(-32603, `bridge answered ${res.status}`);
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
    const p = (async () => {
      try {
        const out = await post(m);
        for (const r of out) {
          if (isPausedResult(r)) status("paused");
          write(r);
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
  constructor(code: number, message: string) {
    super(message);
    this.rpcCode = code;
  }
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
