/**
 * A REAL miniapp-sdk app behind the REAL bridge of a test world (LEARNINGS L2). Only Portal is faked (the world
 * plays Core: lists the instance with a claim code, then its key + slice, and the agent's grant). The app runs
 * in-process with startApp and is reached over real HTTP.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@opt2-tealbrick/manifest";
import { defineApp, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { statementKeys } from "../../src/portal.ts";
import { AGT, AGT2, BRG, notesManifest, type World, WS, waitFor as waitForRaw } from "./world.ts";

const now = () => Math.floor(Date.now() / 1000);

/**
 * A free port for an app that listens LATER (its port is part of the manifest and the config entry). Picked outside
 * the OS ephemeral ranges (Linux 32768–60999, macOS 49152–65535): a port-0 pick could be handed to another
 * parallel test's ephemeral socket before the app binds it (CI flake: EADDRINUSE, tag pipeline #96).
 */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("no free port in 20000-31999");
}

/** labelled wait: CI says which setup step stalled */
export async function waitFor(cond: () => boolean, ms: number, what = "condition"): Promise<void> {
  try {
    await waitForRaw(cond, ms);
  } catch {
    throw new Error(`timeout waiting for ${what}`);
  }
}

export interface RealSdkApp {
  ins: string;
  product: string;
  /** the manifest digest the app serves */
  digest: string;
  stop(): Promise<void>;
}

export interface RealSdkAppOptions {
  ins: string;
  product: string;
  code: string;
  port: number;
  operations: Record<string, unknown>[];
  handlers?: Record<string, unknown>;
  dynamic?: Record<string, unknown>;
  /** CRUD of the world agent's grant for this app (no grant when absent) */
  agentGrantCrud?: string[];
  /** C117: manifest hooks of this app and their handlers (the test lists or omits them in config.hooks itself) */
  hooks?: Record<string, unknown>[];
  hookHandlers?: Record<string, unknown>;
  /** manifest version (a new version = a new digest, like an app update) */
  version?: string;
  /** LA-1: manifest publicRoutes (e.g. a `viewer` route at `/v`) and the handlers `defineApp` registers by path */
  publicRoutes?: Record<string, unknown>[];
  publicHandlers?: Record<string, unknown>;
}

/** Starts a real SDK app on `o.port` (the world must list `http://127.0.0.1:<port>` in extraOwnInfraOrigins). */
export async function startRealSdkApp(w: World, o: RealSdkAppOptions): Promise<RealSdkApp> {
  const { ui: _ui, scopes: _scopes, ...base } = notesManifest as typeof notesManifest & { ui?: unknown; scopes?: unknown };
  const manifest = {
    ...base,
    scopes: [],
    id: o.product,
    name: o.product,
    operations: o.operations,
    settings: { ...notesManifest.settings, keys: [] },
    publicRoutes: o.publicRoutes ?? [],
    runtime: { ...(notesManifest as { runtime: Record<string, unknown> }).runtime, port: o.port },
    ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.version ? { version: o.version } : {}),
  };
  const v = validateManifest(manifest);
  if (!v.ok) throw new Error(`test manifest invalid: ${JSON.stringify(v)}`);
  const app = defineApp({
    manifest: manifest as never,
    handlers: (o.handlers ?? {}) as never,
    ...(o.dynamic ? { dynamic: o.dynamic as never } : {}),
    ...(o.hookHandlers ? { hooks: o.hookHandlers as never } : {}),
    ...(o.publicHandlers ? { publicRoutes: o.publicHandlers as never } : {}),
    migrations: fileURLToPath(new URL("../fixtures/sdk-app/migrations", import.meta.url)),
  });
  const entry = (slice: string) => ({ ins: o.ins as never, product: o.product, version: String(manifest.version), sdkMajor: 1, manifestDigest: app.digest, internalUrl: `http://127.0.0.1:${o.port}`, ownInfra: true, entitled: true, slice }) as never;
  // Core's side: list the instance with its claim code
  // Core keeps listing the instance in every later revision: change the world's BASE config
  await w.amend((c) => {
    c.apps.push(entry((c.apps[0] as { slice: string }).slice));
    c.enrolCodes.push({ digest: w.api.opaqueDigest(o.code), kind: "instance", ins: o.ins, product: o.product, exp: now() + 3600 } as never);
  });
  await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000, "config with the SDK app entry");
  const kss = w.keySet.current() as string;
  const data = mkdtempSync(join(tmpdir(), "tb-sdk-app-"));
  const running = await startApp(
    app,
    { TB_INSTANCE_ID: o.ins, TB_BRIDGE_URL: w.internalUrl, TB_PORTAL_KEYS: JSON.stringify({ keys: statementKeys(kss).map((k) => k.jwk) }), TB_ENROL_CODE: o.code, TB_DATA_DIR: data, TB_DATA_EPHEMERAL: "1", TB_KEK: "33".repeat(32), TB_LOG_LEVEL: "error" },
    // the test process may run as root in CI: never let the SDK drop THIS process to uid 1000
    { portalRootKeys: [w.keySet.root?.publicJwk as never], privilegeProc: { getuid: () => 1000, getgid: () => 1000 } as never },
  );
  // the app claimed (pending at the bridge): Core lists its key, its slice and the agent grant in the next revision
  await waitFor(() => w.bridge.ctx.state.claims.some((c) => c.ins === o.ins), 30000, "the SDK app's claim");
  const jwk = w.bridge.ctx.state.claims.find((c) => c.ins === o.ins)?.publicKey;
  const slice = await w.signPortal("tb-slice+jws", {
    v: 1,
    iss: "tb:portal",
    sub: `tb:ins:${o.ins}`,
    aud: `tb:ins:${o.ins}`,
    iat: now(),
    exp: now() + 43200,
    jti: w.api.ulid(),
    ws: WS,
    rev: 2,
    ins: o.ins,
    product: o.product,
    portalKeys: statementKeys(kss),
    portalKeySet: kss,
    bridge: { id: BRG, keys: [w.bridge.ctx.identity?.key.publicJwk] },
    pause: { workspace: false, agents: [], instances: [] },
    revoked: { jtis: [] },
    personNbf: 0,
    grants: [],
    // miniapp-sdk 0.1.26 refuses an agent the slice does not list (`agent_unknown`): Core lists the world's agents
    agents: [
      { id: AGT, name: "Agent One", mode: "free", status: "active" },
      { id: AGT2, name: "Agent Two", mode: "free", status: "active" },
    ],
  });
  const grant = o.agentGrantCrud
    ? await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:agt:${AGT}`, aud: `tb:ins:${o.ins}`, iat: now(), exp: now() + 43200, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: o.agentGrantCrud, mode: "free", held: [], caps: {}, wf: [], polrev: 1 })
    : undefined;
  await w.amend((c) => {
    const e = c.apps.find((a) => a.ins === o.ins) as { slice: string } | undefined;
    if (e) e.slice = slice;
    else c.apps.push(entry(slice));
    c.instanceKeys.push({ ins: o.ins as never, jwk } as never);
    if (grant) c.grants.push(grant);
  });
  await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && w.bridge.ctx.table?.apps.get(o.ins as never)?.down === false, 30000, "the SDK app routed (manifest fetched)");
  try {
    await waitFor(() => w.bridge.ctx.health.get(o.ins as never)?.status.readiness === "ready", 30000, "SDK readiness");
  } catch (e) {
    throw new Error(`SDK app not ready: ${JSON.stringify(w.bridge.ctx.health.get(o.ins as never)?.status ?? null)}; ${String(e)}`);
  }
  return {
    ins: o.ins,
    product: o.product,
    digest: app.digest as string,
    async stop() {
      await running.stop();
      rmSync(data, { recursive: true, force: true });
    },
  };
}
