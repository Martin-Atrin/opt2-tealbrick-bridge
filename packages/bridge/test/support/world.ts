/**
 * Test world: a fake Portal (enrol, config long-poll, ack), a fake app (SDK routes) and a real
 * deployed bridge started on free ports with the manifest test double.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StatusReport, WorkspaceConfig } from "@opt2-tealbrick/spec/bridge";
import type { Ed25519KeyPair, ManifestApi } from "../../src/api.ts";
import { manifestApi } from "../../src/manifest-adapter.ts";
import { type RunningBridge, startBridge } from "../../src/server.ts";
import { silentLogger } from "../../src/util.ts";
import { fakeApi } from "./fake-api.ts";

export const WS = "ws_01HZZZZZZZZZZZZZZZZZZZZZZZ";
export const BRG = "brg_01HZZZZZZZZZZZZZZZZZZZZZZZ";
export const AGT = "agt_01HAAAAAAAAAAAAAAAAAAAAAAA";
export const AGT2 = "agt_01HBBBBBBBBBBBBBBBBBBBBBBB";
export const CON = "con_01HAAAAAAAAAAAAAAAAAAAAAAA";
export const INS = "ins_01HNNNNNNNNNNNNNNNNNNNNNNN";
export const HOOKINS = "ins_01HHHHHHHHHHHHHHHHHHHHHHHH";
export const ENROL = "tbe_testenrolmentcode";
export const APP_CODE = "tbe_appinstancecode";

const now = () => Math.floor(Date.now() / 1000);

const example = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@opt2-tealbrick/spec/examples/notes.manifest.json")), "utf8"));
const { companions: _c, unlocks: _u, hooks: _h, ...exampleBase } = example;
const op = (id: string, crud: string[], effect: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  description: `Test op ${id}`,
  input: { type: "object" },
  output: { type: "object" },
  crud,
  effect,
  idempotency: "none",
  receipt: effect !== "read",
  audience: "agent",
  ...extra,
});

/** Valid manifests (spec example as the base) so the real validator accepts them. */
export const notesManifest = {
  ...exampleBase,
  id: "notes",
  operations: [
    op("notes_list", ["read"], "read"),
    op("notes_create", ["create"], "write", { idempotency: "required" }),
    op("notes_send", ["create"], "outward", { idempotency: "required" }),
    op("notes_delete", ["delete"], "destructive", { holdFamily: "destructive" }),
    op("notes_admin", ["read"], "read", { audience: "person" }),
  ],
  settings: { ...example.settings, keys: [{ name: "NOTES_API_KEY", label: "Notes key", provider: "Example", required: true, source: "account_default", usedBy: ["app"] }] },
  publicRoutes: [{ path: "/oauth/callback", purpose: "oauth_callback" }],
  skills: [],
  ui: { launchPath: "/", configurePath: "/configure" },
};

export const hookManifest = {
  ...exampleBase,
  id: "guard",
  name: "Guard",
  operations: [op("guard_status", ["read"], "read")],
  scopes: [],
  skills: [],
  publicRoutes: [],
  hooks: [{ id: "check", title: "Check", phase: "before", order: 1, match: { products: ["notes"] } }],
};

export interface AppLog {
  ops: { op: string; auth: string | undefined; proof: string | undefined; body: Record<string, unknown> }[];
  hooks: { hook: string; body: Record<string, unknown> }[];
}

export interface World {
  bridge: RunningBridge;
  publicUrl: string;
  internalUrl: string;
  portalKid: string;
  api: ManifestApi;
  agentKey: Ed25519KeyPair;
  real: boolean;
  agentAssertion(agt: string, con: string): Promise<string>;
  signRaw(input: string): Promise<string>;
  acks: StatusReport[];
  appLog: AppLog;
  hookMode: { mode: "allow" | "deny" | "fail" };
  /** publish a new config revision (tweak: mutate the base config) */
  publish(tweak?: (c: WorkspaceConfig) => void): Promise<number>;
  rev(): number;
  close(): Promise<void>;
  /** stop answering as Portal (simulates Portal down) */
  portalDown(): void;
  rejectedBridgeAssertions(): number;
  agentToken(): Promise<string>;
  mcp(token: string, body: unknown, session?: string): Promise<{ status: number; json: any; session: string | null }>;
  signPortal(typ: string, claims: object): Promise<string>;
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? JSON.parse(t) : undefined;
}

export async function makeWorld(opts: { withHook?: boolean; real?: boolean } = {}): Promise<World> {
  const real = !!opts.real;
  const api = real ? manifestApi() : fakeApi();
  const portalKey = await api.generateKeyPair();
  const agentKey = await api.generateKeyPair();
  const acks: StatusReport[] = [];
  const appLog: AppLog = { ops: [], hooks: [] };
  const hookMode = { mode: "allow" as "allow" | "deny" | "fail" };
  let down = false;
  let assertFailures = 0;
  let bridgeJwk: Ed25519KeyPair["publicJwk"] | undefined;
  let configJws = "";
  let rev = 0;
  const sign = (typ: string, claims: object) => api.signJws(typ as never, claims, portalKey);

  // ── fake app (notes) and hook app (guard) ──
  const app = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/tb/v1/manifest") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(notesManifest));
    if (url.pathname.startsWith("/tb/v1/ops/")) {
      const op = url.pathname.slice(11);
      const b = await body(req);
      appLog.ops.push({ op, auth: req.headers.authorization, proof: req.headers["tb-call"] as string | undefined, body: b });
      if (op === "notes_send") return res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ status: "held", holdId: "hold_1", expiresAt: new Date(Date.now() + 900_000).toISOString() }));
      if (op === "tb.hold_status") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", output: { status: "pending" } }));
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", output: { op, secret: "s3cret", items: [1, 2] } }));
    }
    if (url.pathname.startsWith("/tb/v1/bridge/")) {
      await body(req);
      return res.writeHead(200, { "content-type": "application/json" }).end("[]");
    }
    if (url.pathname.startsWith("/a/notes/") || url.pathname.startsWith("/p/notes/")) {
      const b = req.method === "POST" ? await new Promise<string>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); }) : "";
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path: url.pathname, auth: req.headers.authorization ?? null, tb: req.headers["tb-call"] ?? null, body: b }));
    }
    res.writeHead(404).end();
  });
  const hookApp = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/tb/v1/manifest") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(hookManifest));
    if (url.pathname.startsWith("/tb/v1/hooks/")) {
      const b = await body(req);
      appLog.hooks.push({ hook: url.pathname.slice(13), body: b });
      if (hookMode.mode === "fail") return res.writeHead(500).end();
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ allow: hookMode.mode === "allow", reason: "blocked by test" }));
    }
    res.writeHead(404).end();
  });

  const brgRef = `tb:brg:${BRG}`;
  const grant = async (sub: string, crud: string[], extra: Record<string, unknown> = {}) =>
    sign("tb-grant+jwt", { iss: "tb:portal", sub, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 43200, jti: api.ulid(), ws: WS, cnf: { brg: BRG }, crud, mode: "free", held: [], caps: {}, wf: [], polrev: 1, ...extra });
  const slice = await sign("tb-slice+jws", { v: 1, iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 43200, jti: api.ulid(), ws: WS, rev: 1, ins: INS, product: "notes" });
  const base: WorkspaceConfig = {
    v: 1,
    iss: "tb:portal",
    sub: brgRef as never,
    aud: brgRef as never,
    iat: now(),
    exp: now() + 43200,
    jti: api.ulid(),
    ws: WS,
    rev: 0,
    workspace: { id: WS, name: "Test workspace" },
    bridge: { id: BRG, publicUrl: "http://127.0.0.1" },
    portalKeys: [{ jwk: portalKey.publicJwk, status: "active" }],
    pause: { workspace: false, agents: [], instances: [] },
    revoked: { jtis: [] },
    connections: [{ con: CON, agt: AGT, method: "key", gen: 1, publicKey: agentKey.publicJwk, status: "active" }],
    instanceKeys: [],
    grants: [await grant(`tb:agt:${AGT}`, ["read", "create"])],
    apps: [
      { ins: INS as never, product: "notes", version: "1.0.0", sdkMajor: 1, manifestDigest: api.manifestDigest(notesManifest as never), internalUrl: app.url, entitled: true, slice },
      ...(opts.withHook ? [{ ins: HOOKINS as never, product: "guard", version: "1.0.0", sdkMajor: 1, manifestDigest: api.manifestDigest(hookManifest as never), internalUrl: hookApp.url, entitled: true, slice }] : []),
    ],
    agents: [
      { agt: AGT, name: "Agent One", mode: "free" },
      { agt: AGT2, name: "Agent Two", mode: "free" },
    ],
    hooks: opts.withHook ? [{ id: "guard.check", ins: HOOKINS, product: "guard", hookId: "check", phase: "before", order: 1, timeoutMs: 1000, match: { products: ["notes"] } }] : [],
    skills: { digest: "sha256:00", files: [{ product: "notes", id: "use-notes", title: "Using notes", content: "Hello {{agent.name}}" }] },
    keyRequirements: [{ name: "NOTES_API_KEY", label: "Notes key", ins: INS, product: "notes", required: true, source: "account_default", usedBy: ["app"] }],
    enrolCodes: [{ digest: api.opaqueDigest(APP_CODE), kind: "instance", ins: INS, product: "notes", exp: now() + 3600 }],
  };
  const publish = async (tweak?: (c: WorkspaceConfig) => void): Promise<number> => {
    const c: WorkspaceConfig = structuredClone(base);
    rev += 1;
    c.rev = rev;
    c.iat = now();
    c.exp = now() + 43200;
    c.jti = api.ulid();
    tweak?.(c);
    configJws = await sign("tb-config+jws", c);
    return rev;
  };
  await publish();

  const portal = await listen(async (req, res) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    if (url.pathname === "/api/v1/bridge/enrol") {
      const b = JSON.parse(raw.toString("utf8"));
      bridgeJwk = b.publicKey;
      return res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ bridgeId: BRG, workspaceId: WS, portalKeys: [{ jwk: portalKey.publicJwk, status: "active" }], configPath: "/api/v1/bridge/config", ackPath: "/api/v1/bridge/ack", waitMaxS: 60 }));
    }
    const keys = bridgeJwk ? api.keySetFrom({ keys: [bridgeJwk] }, `tb:brg:${BRG}`) : { keys: [] };
    const v = api.verifyAssertion(String(req.headers["tb-assert"] ?? ""), keys, { typ: "tb-bridge-assert+jwt", aud: "tb:portal", iss: [`tb:brg:${BRG}`], now: now(), maxLifetimeS: 60, request: { method: req.method ?? "GET", pathAndQuery: req.url ?? "/", ...(raw.length ? { body: raw } : {}) } });
    if (!v.ok) {
      assertFailures += 1;
      return res.writeHead(401).end();
    }
    if (url.pathname === "/api/v1/bridge/config") {
      const after = Number(url.searchParams.get("after"));
      const deadline = Date.now() + 300;
      while (rev <= after && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      if (rev > after) return res.writeHead(200, { "content-type": "application/jose" }).end(configJws);
      return res.writeHead(304).end();
    }
    if (url.pathname === "/api/v1/bridge/ack") {
      acks.push(JSON.parse(raw.toString("utf8")));
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accepted: true, configRevision: rev }));
    }
    res.writeHead(404).end();
  });

  const dir = mkdtempSync(join(tmpdir(), "tb-bridge-test-"));
  const bridge = await startBridge({
    api,
    logger: silentLogger,
    ports: { public: 0, internal: 0 },
    env: { TB_DATA_DIR: dir, TB_PORTAL_URL: portal.url, TB_PUBLIC_URL: "http://127.0.0.1", TB_ENROL_CODE: ENROL, TB_KEK: "11".repeat(32) },
  });
  const publicUrl = `http://127.0.0.1:${(bridge.publicServer.address() as AddressInfo).port}`;
  const internalUrl = `http://127.0.0.1:${(bridge.internalServer.address() as AddressInfo).port}`;
  // wait for the first config
  for (let i = 0; i < 100 && !bridge.ctx.table; i++) await new Promise((r) => setTimeout(r, 20));

  const agentAssertion = (agt: string, con: string) => api.signAssertion("tb-agent-assert+jwt", { iss: `tb:agt:${agt}`, sub: `tb:agt:${agt}`, aud: brgRef, iat: now(), exp: now() + 60, jti: api.ulid(), con }, agentKey);
  const signRaw = async (input: string): Promise<string> =>
    real ? Buffer.from(await crypto.subtle.sign("Ed25519", agentKey.privateKey, new TextEncoder().encode(input))).toString("base64url") : `sig-${agentKey.kid}`;
  const agentToken = async () => {
    const assertion = await agentAssertion(AGT, CON);
    const r = await fetch(`${publicUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
    const j = (await r.json()) as { access_token: string };
    return j.access_token;
  };
  const mcp = async (token: string, b: unknown, session?: string) => {
    const r = await fetch(`${publicUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(b) });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : undefined, session: r.headers.get("mcp-session-id") };
  };

  return {
    bridge,
    publicUrl,
    internalUrl,
    portalKid: portalKey.kid,
    api,
    agentKey,
    real,
    agentAssertion,
    signRaw,
    acks,
    appLog,
    hookMode,
    publish,
    rev: () => rev,
    agentToken,
    mcp,
    signPortal: sign,
    portalDown() {
      down = true;
      portal.server.closeAllConnections();
    },
    rejectedBridgeAssertions: () => assertFailures,
    async close() {
      await bridge.stop();
      for (const s of [app.server, hookApp.server, portal.server]) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
