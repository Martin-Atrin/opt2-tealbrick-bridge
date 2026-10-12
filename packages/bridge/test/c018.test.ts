/**
 * Bridge 0.1.18 (spec 0.1.17, L3/C104): a manifest the bridge REFUSES is reported in the status report as rejected kind
 * `manifest` (code = bridge_too_old / the validator code / manifest_mismatch), so Core shows the reason instead of an
 * endless "starting". A transient fetch failure is not a refusal.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BRIDGE_VERSION } from "../src/context.ts";
import { buildStatusReport } from "../src/portal.ts";
import { AGT, BRG, CON, INS, makeWorld, notesManifest, type World, WS, waitFor } from "./support/world.ts";

const rejectedManifest = (w: World) => buildStatusReport(w.bridge.ctx).rejected.filter((r) => r.kind === "manifest");

describe("0.1.18: refused manifests are reported (rejected kind manifest)", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  test("an app that requires a newer bridge → manifest/bridge_too_old, the app is not routed", async () => {
    w.updateAppTo({ ...notesManifest, version: "2.0.0", requires: { bridge: "9.0.0" } });
    await w.publish();
    await waitFor(() => rejectedManifest(w).some((r) => r.code === "bridge_too_old"), 15000);
    assert.equal(w.bridge.ctx.table?.apps.get(INS as never)?.manifest, undefined, "not routed half-working");
    assert.ok(BRIDGE_VERSION < "9.0.0");
  });

  test("an invalid manifest → manifest/<validator code>", async () => {
    w.updateAppTo({ ...notesManifest, version: "2.0.1", operations: [{ id: "x", title: "x", description: "x", crud: ["create"], effect: "write", idempotency: "none", receipt: true, audience: "agent", input: { type: "object" }, output: { type: "object" } }] });
    await w.publish();
    await waitFor(() => rejectedManifest(w).some((r) => r.code === "schema_invalid"), 15000);
  });
});

/** F39: an agent revokes its OWN key connection (`tealbrick adopt --undo`); nothing else is revocable that way. */
describe("0.1.18: POST /agent/connection/revoke (F39 self-revoke)", () => {
  const CON2 = "con_01HCCCCCCCCCCCCCCCCCCCCCCC";
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true, extraConnections: [CON2] });
  });
  after(async () => {
    await w.close();
  });
  const revoke = async (assertion: unknown) => {
    const r = await fetch(`${w.publicUrl}/agent/connection/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion }) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const tokenStatus = async (con: string) => {
    const r = await fetch(`${w.publicUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await w.agentAssertion(AGT, con) }) });
    return r.status;
  };
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

  test("refusals before the signature is verified all look the same (no oracle), and revoke nothing", async () => {
    const stranger = await w.api.generateKeyPair();
    const forged = await w.api.signAssertion("tb-agent-assert+jwt", { iss: `tb:agt:${AGT}`, sub: `tb:agt:${AGT}`, aud: w.bridge.ctx.bridgeRef, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, jti: w.api.ulid(), con: CON2 }, stranger);
    const bearer = await w.agentTokenFor(AGT, CON2);
    for (const a of [forged, bearer, "", 42, await w.agentAssertion(AGT, "con_01HDDDDDDDDDDDDDDDDDDDDDDD")]) {
      const r = await revoke(a);
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, "connection_unknown");
    }
    assert.equal(await tokenStatus(CON2), 200, "still active");
  });

  test("the key holder revokes its own connection: refused at once, reported client_revoke, the other connection untouched", async () => {
    const before = await w.agentTokenFor(AGT, CON2);
    assert.equal((await w.mcp(before, init)).status, 200);
    const assertion = await w.agentAssertion(AGT, CON2);
    const r = await revoke(assertion);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { con: CON2, status: "revoked" });
    assert.notEqual(await tokenStatus(CON2), 200, "no new access token");
    assert.notEqual((await w.mcp(before, init)).status, 200, "the live access token is refused");
    await waitFor(() => w.acks.some((a) => a.connectionsRevoked.some((x) => x.con === CON2 && x.reason === "client_revoke")), 15000);
    assert.equal(await tokenStatus(CON), 200, "the caller's other connection is not touched");
    // one use per assertion (shared with /oauth/token), and idempotent for the key holder
    assert.equal((await revoke(assertion)).json.error?.code, "connection_unknown");
    const again = await revoke(await w.agentAssertion(AGT, CON2));
    assert.deepEqual(again.json, { con: CON2, status: "revoked", already: true });
  });
});

/** C108: manifest 0.1.11 verifyGrant is the tolerant reader — an unknown (future) held family is ignored, not fatal. */
describe("0.1.18: C108 tolerant held reader (manifest 0.1.11 verifyGrant)", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  test('an agent grant with held ["destructive","future_x"] is accepted and the call runs', async () => {
    const now = () => Math.floor(Date.now() / 1000);
    const grant = await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:agt:${AGT}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read", "create"], mode: "free", held: ["destructive", "future_x"], caps: {}, wf: [], polrev: 1 });
    await w.amend((c) => {
      c.grants = c.grants.filter((g) => {
        const p = JSON.parse(Buffer.from(g.split(".")[1] as string, "base64url").toString("utf8")) as { sub: string; aud: string };
        return !(p.sub === `tb:agt:${AGT}` && p.aud === `tb:ins:${INS}`);
      });
      c.grants.push(grant);
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
    assert.equal(w.bridge.ctx.table?.grants.get(`tb:agt:${AGT}|tb:ins:${INS}`)?.token, grant, "the grant is loaded, not dropped");
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const r = await w.mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "notes__notes_list", arguments: {} } }, init.session as string);
    assert.equal(r.status, 200);
    assert.notEqual(r.json.result?.isError, true, JSON.stringify(r.json.result?.structuredContent));
  });
});
