/**
 * C91 live: the REAL bridge calls a REAL miniapp-sdk app (0.1.12, started with startApp, real HTTP) for every bridge
 * op — catalog (list mode), catalog search (search mode), resolve and scope_summary. No fake app: the SDK verifies
 * each proof with its own binding, so the S1 catalog/scope_summary mismatch fails here. Only Portal is faked (world).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@opt2-tealbrick/manifest";
import { defineApp, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { CallRouter } from "../src/calls.ts";
import { statementKeys } from "../src/portal.ts";
import { BRG, makeWorld, notesManifest, type World, WS, waitFor } from "./support/world.ts";

const SDKINS = "ins_01HSDKAPPSDKAPPSDKAPPSDKAP";
const SDK_CODE = "tbe_sdkappinstancecode01";
const now = () => Math.floor(Date.now() / 1000);

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

const dyn = (id: string, mode: "list" | "search") => ({
  id,
  title: id,
  description: `Dynamic ${mode} op`,
  crud: ["read"],
  effect: "read",
  idempotency: "supported",
  receipt: false,
  audience: "agent",
  dynamic: { mode, crudCeiling: ["read"], effectCeiling: "read" },
});

describe("C91 live: real bridge → real SDK app bridge ops", () => {
  let w: World;
  let running: { stop(): Promise<void> } | undefined;
  let data: string;
  let port: number;
  const searches: unknown[] = [];

  before(async () => {
    port = await freePort();
    w = await makeWorld({ real: true, extraOwnInfraOrigins: [`http://127.0.0.1:${port}`] });
    const { ui: _ui, scopes: _scopes, ...base } = notesManifest as typeof notesManifest & { ui?: unknown; scopes?: unknown };
    const manifest = {
      ...base,
      scopes: [],
      id: "dyna",
      name: "Dyna",
      operations: [dyn("catalog_all", "list"), dyn("lookup", "search")],
      settings: { ...notesManifest.settings, keys: [] },
      publicRoutes: [],
      runtime: { ...(notesManifest as { runtime: Record<string, unknown> }).runtime, port },
    };
    const v = validateManifest(manifest);
    assert.ok(v.ok, JSON.stringify(v));
    const entries = [{ name: "gmail_list", title: "Gmail list", description: "List Gmail messages", inputSchema: { type: "object" as const }, crud: ["read" as const], effect: "read" as const }];
    const app = defineApp({
      manifest: manifest as never,
      handlers: {},
      dynamic: {
        catalog_all: { catalog: async () => entries, resolve: async () => ({ crud: ["read"], effect: "read" }) as never, call: async () => ({}) },
        lookup: {
          catalog: async (q) => {
            searches.push(q);
            return entries;
          },
          resolve: async (tool) => (tool === "gmail_list" ? ({ crud: ["read"], effect: "read" } as never) : null),
          call: async () => ({}),
        },
      },
      migrations: fileURLToPath(new URL("./fixtures/sdk-app/migrations", import.meta.url)),
    });
    // Core's side (fake Portal): list the instance with its claim code
    await w.publish((c) => {
      c.apps.push({ ins: SDKINS as never, product: "dyna", version: String(manifest.version), sdkMajor: 1, manifestDigest: app.digest, internalUrl: `http://127.0.0.1:${port}`, ownInfra: true, entitled: true, slice: (c.apps[0] as { slice: string }).slice } as never);
      c.enrolCodes.push({ digest: w.api.opaqueDigest(SDK_CODE), kind: "instance", ins: SDKINS, product: "dyna", exp: now() + 3600 } as never);
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
    const kss = w.keySet.current() as string;
    const portalJwks = { keys: statementKeys(kss).map((k) => k.jwk) };
    data = mkdtempSync(join(tmpdir(), "tb-c91-sdk-"));
    running = await startApp(
      app,
      { TB_INSTANCE_ID: SDKINS, TB_BRIDGE_URL: w.internalUrl, TB_PORTAL_KEYS: JSON.stringify(portalJwks), TB_ENROL_CODE: SDK_CODE, TB_DATA_DIR: data, TB_DATA_EPHEMERAL: "1", TB_KEK: "33".repeat(32), TB_LOG_LEVEL: "error" },
      { portalRootKeys: [w.keySet.root?.publicJwk as never] },
    );
    // the app claimed (pending at the bridge): Core lists its key and its slice in the next revision
    await waitFor(() => w.bridge.ctx.state.claims.some((c) => c.ins === SDKINS), 15000);
    const jwk = w.bridge.ctx.state.claims.find((c) => c.ins === SDKINS)?.publicKey;
    const bridgeJwk = w.bridge.ctx.identity?.key.publicJwk;
    const slice = await w.signPortal("tb-slice+jws", {
      v: 1,
      iss: "tb:portal",
      sub: `tb:ins:${SDKINS}`,
      aud: `tb:ins:${SDKINS}`,
      iat: now(),
      exp: now() + 43200,
      jti: w.api.ulid(),
      ws: WS,
      rev: 2,
      ins: SDKINS,
      product: "dyna",
      portalKeys: statementKeys(kss),
      portalKeySet: kss,
      bridge: { id: BRG, keys: [bridgeJwk] },
      pause: { workspace: false, agents: [], instances: [] },
      revoked: { jtis: [] },
      personNbf: 0,
      grants: [],
      agents: [],
    });
    await w.publish((c) => {
      const e = c.apps.find((a) => a.ins === SDKINS) as { slice: string } | undefined;
      if (!e) c.apps.push({ ins: SDKINS as never, product: "dyna", version: String(manifest.version), sdkMajor: 1, manifestDigest: app.digest, internalUrl: `http://127.0.0.1:${port}`, ownInfra: true, entitled: true, slice } as never);
      else e.slice = slice;
      c.instanceKeys.push({ ins: SDKINS as never, jwk } as never);
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && w.bridge.ctx.table?.apps.get(SDKINS as never)?.down === false, 20000);
    // the SDK is ready once it reports status with the slice applied
    try {
      await waitFor(() => {
        const r = w.bridge.ctx.health.get(SDKINS as never)?.status.readiness;
        return r === "ready";
      }, 20000);
    } catch (e) {
      throw new Error(`SDK app not ready: ${JSON.stringify(w.bridge.ctx.health.get(SDKINS as never)?.status ?? null)}; ${String(e)}`);
    }
  });
  after(async () => {
    await running?.stop();
    await w.close();
    rmSync(data, { recursive: true, force: true });
  });

  test("catalog (list), catalog search, resolve and scope_summary are accepted by the real SDK", async () => {
    const app = w.bridge.ctx.table?.apps.get(SDKINS as never);
    assert.ok(app?.manifest, "the bridge fetched the real app's manifest");
    const r = new CallRouter(w.bridge.ctx);
    const list = await r.catalog(app, "catalog_all");
    assert.deepEqual(
      list.map((e) => e.name),
      ["gmail_list"],
    );
    const found = await r.search(app, "lookup", "gmail list messages", 5);
    assert.equal(found[0]?.name, "gmail_list");
    assert.deepEqual(searches.at(-1), { query: "gmail list messages", limit: 5 }, "the search query reaches the app");
    const resolved = await r.bridgeOp<{ tool: string; effect: string }>(app, "resolve", { op: "lookup", tool: "gmail_list" });
    assert.equal(resolved.effect, "read");
    const summary = await r.bridgeOp<unknown[]>(app, "scope_summary", {});
    assert.ok(Array.isArray(summary));
  });
});
