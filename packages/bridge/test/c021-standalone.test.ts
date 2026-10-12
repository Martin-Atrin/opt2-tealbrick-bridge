/**
 * S1 (QA J2-15, bridge 0.1.21) REAL-to-REAL (L2): a real bridge + a real miniapp-sdk app + an agent. Leave Portal (the
 * final Portal config carries `standalone`) → the bridge re-mints → the agent's tools/list is UNCHANGED and a call to
 * the app succeeds. "Apps keep working after Leave Portal."
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { freePort, type RealSdkApp, startRealSdkApp } from "./support/sdk-app.ts";
import { makeWorld, type World, waitFor } from "./support/world.ts";

const SDKINS = "ins_01HJ0PAYSPAYSPAYSPAYSPAYSP";

describe("S1 J2-15: apps keep working after Leave Portal (real SDK app)", () => {
  let w: World;
  let sdk: RealSdkApp;
  let calls = 0;

  before(async () => {
    const port = await freePort();
    w = await makeWorld({ real: true, extraOwnInfraOrigins: [`http://127.0.0.1:${port}`] });
    sdk = await startRealSdkApp(w, {
      ins: SDKINS,
      product: "samplepay",
      code: "tbe_standalonepayapp00001",
      port,
      operations: [{ id: "pay_list", title: "pay_list", description: "List payments", input: { type: "object" }, output: { type: "object" }, crud: ["read"], effect: "read", idempotency: "supported", receipt: false, audience: "agent" }],
      handlers: {
        pay_list: async () => {
          calls += 1;
          return { items: [] };
        },
      },
      agentGrantCrud: ["read", "create"],
    });
  });
  after(async () => {
    await sdk?.stop();
    await w?.close();
  });

  const session = async () => {
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(init.status, 200);
    return { token, sid: init.session as string };
  };
  const toolNames = async (s: { token: string; sid: string }) => ((await w.mcp(s.token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, s.sid)).json.result.tools as { name: string }[]).map((t) => t.name).sort();
  const call = async (s: { token: string; sid: string }) => (await w.mcp(s.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "samplepay__pay_list", arguments: {} } }, s.sid)).json.result;

  test("tools/list unchanged and samplepay__pay_list works after the re-mint", async () => {
    const s0 = await session();
    const before = await toolNames(s0);
    assert.ok(before.includes("samplepay__pay_list"), `baseline: ${before.join(",")}`);
    const r0 = await call(s0);
    assert.notEqual(r0.isError, true, JSON.stringify(r0.structuredContent));
    const owner = await w.api.generateKeyPair();
    const id = w.bridge.ctx.identity;
    assert.ok(id);
    const standalone = { issuer: w.bridge.ctx.bridgeRef, kid: w.api.thumbprint(id.key.publicJwk), ownerKeys: [owner.publicJwk] };
    // like Core (configdoc.ts): the FINAL Portal-signed document carries `standalone` in the config AND in every slice
    const t0 = w.bridge.ctx.table;
    assert.ok(t0);
    const finalSlices = new Map<string, string>();
    for (const a of t0.config.apps) {
      const claims = JSON.parse(Buffer.from(a.slice.split(".")[1] as string, "base64url").toString("utf8")) as Record<string, unknown>;
      finalSlices.set(a.ins, await w.signPortal("tb-slice+jws", { ...claims, iat: Math.floor(Date.now() / 1000), jti: w.api.ulid(), rev: Number(claims.rev ?? 1) + 1, standalone }));
    }
    await w.publish((c) => {
      (c as { standalone?: unknown }).standalone = standalone;
      for (const a of c.apps) a.slice = (finalSlices.get(a.ins) ?? a.slice) as never;
    });
    await waitFor(() => w.bridge.ctx.table?.standalone === true && w.bridge.ctx.table?.config.iss === w.bridge.ctx.bridgeRef, 15000);
    // the app took the final Portal slice, then the bridge-issued one (it now trusts only the standalone issuer)
    await new Promise((r) => setTimeout(r, 3000));
    // the re-mint really happened: the agent's grant is now bridge-issued
    const g = [...(w.bridge.ctx.table?.grants.values() ?? [])].find((x) => x.claims.aud === `tb:ins:${SDKINS}`);
    assert.equal(g?.claims.iss, w.bridge.ctx.bridgeRef, "agent grant re-minted by the bridge");
    const s1 = await session();
    assert.deepEqual(await toolNames(s1), before, "tools/list unchanged after Leave Portal");
    const n = calls;
    const r1 = await call(s1);
    assert.notEqual(r1.isError, true, JSON.stringify(r1.structuredContent));
    assert.equal(calls, n + 1, "the real app ran the op");
  });

  test("L3: a final document without agent grants is applied (fail closed) but reported, with the instance on manifest refusals", async () => {
    const { buildStatusReport } = await import("../src/portal.ts");
    const { remintStandalone } = await import("../src/standalone.ts");
    // the frozen final doc of THIS world carries grants: nothing reported
    w.bridge.ctx.rejected.clear();
    await remintStandalone(w.bridge.ctx);
    assert.ok(!buildStatusReport(w.bridge.ctx).rejected.some((r) => r.code === "standalone_without_grants"));
  });
});


describe("C116 L3: a grantless final document is reported (standalone_without_grants), still fail closed", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  test("Core's final doc with grants: [] → rejected config/standalone_without_grants; agents get no app tools", async () => {
    const { buildStatusReport } = await import("../src/portal.ts");
    const owner = await w.api.generateKeyPair();
    const id = w.bridge.ctx.identity;
    assert.ok(id);
    await w.publish((c) => {
      c.grants = [];
      (c as { standalone?: unknown }).standalone = { issuer: w.bridge.ctx.bridgeRef, kid: w.api.thumbprint(id.key.publicJwk), ownerKeys: [owner.publicJwk] };
    });
    await waitFor(() => w.bridge.ctx.table?.standalone === true && w.bridge.ctx.table?.config.iss === w.bridge.ctx.bridgeRef, 15000);
    assert.ok(buildStatusReport(w.bridge.ctx).rejected.some((r) => r.kind === "config" && r.code === "standalone_without_grants"));
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const tools = (await w.mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, init.session as string)).json.result.tools as { name: string }[];
    assert.ok(!tools.some((t) => t.name.startsWith("notes__notes_")), "fail closed: no grant, no app tool");
  });
});
