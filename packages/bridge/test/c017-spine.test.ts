/**
 * Bridge 0.1.17 against a REAL miniapp-sdk app (L2):
 * - G4 tb.holds_pending: a companion app (grant wf ["tb.holds_pending"], the per-app grant Core mints after the
 *   owner's wildcard consent) reaches the target app's standard op and gets its summaries.
 * - L3: a list-mode dynamic op whose catalog fails is reported (toolsOmitted catalog_failed + rejected bridge_op),
 *   not only logged.
 * - v0.1.14 connectionsSeen: an authenticated connection appears in the next status report and is cleared once an
 *   accepted report carried it.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { buildStatusReport, sendStatus } from "../src/portal.ts";
import { freePort, type RealSdkApp, startRealSdkApp } from "./support/sdk-app.ts";
import { APP_CODE, BRG, CON, INS, makeWorld, type World, WS, waitFor } from "./support/world.ts";

const SDKINS = "ins_01HH0DDSH0DDSH0DDSH0DDSH0D";
const now = () => Math.floor(Date.now() / 1000);

describe("0.1.17 spine against a real SDK app", () => {
  let w: World;
  let sdk: RealSdkApp;
  let appKey: Awaited<ReturnType<World["api"]["generateKeyPair"]>>;
  let purges = 0;

  before(async () => {
    const port = await freePort();
    w = await makeWorld({ real: true, extraOwnInfraOrigins: [`http://127.0.0.1:${port}`] });
    sdk = await startRealSdkApp(w, {
      ins: SDKINS,
      product: "holder",
      code: "tbe_sdkholdsappcode0001",
      port,
      operations: [
        { id: "item_purge", title: "item_purge", description: "Destructive op", input: { type: "object" }, output: { type: "object" }, crud: ["delete"], effect: "destructive", idempotency: "supported", receipt: true, audience: "agent", holdFamily: "destructive" },
        { id: "broken_list", title: "broken_list", description: "List op whose catalog fails", crud: ["read"], effect: "read", idempotency: "supported", receipt: false, audience: "agent", dynamic: { mode: "list", crudCeiling: ["read"], effectCeiling: "read" } },
      ],
      handlers: {
        item_purge: async () => {
          purges += 1;
          return { purged: true };
        },
      },
      dynamic: {
        broken_list: {
          catalog: async () => {
            throw new Error("upstream catalog down");
          },
          resolve: async () => null,
          call: async () => ({}),
        },
      },
      agentGrantCrud: ["read"],
    });
    // the world's notes instance claims, so it can act as the CALLING app (instance assertion)
    appKey = await w.api.generateKeyPair();
    const claim = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.2" }),
    });
    assert.equal(claim.status, 200);
  });
  after(async () => {
    await sdk?.stop();
    await w?.close();
  });

  test("G4: a companion grant for tb.holds_pending reaches the real app's standard op (summaries)", async () => {
    const grant = await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${SDKINS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read"], mode: "bound", held: ["money"], caps: {}, wf: ["tb.holds_pending"], polrev: 1 });
    await w.amend((c) => {
      c.grants.push(grant);
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
    const presented = w.bridge.ctx.table?.grants.get(`tb:ins:${INS}|tb:ins:${SDKINS}`)?.token ?? grant;
    const raw = Buffer.from(JSON.stringify({ target: "holder", op: "tb.holds_pending", input: {} }));
    const a = await w.api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: w.api.ulid() }, appKey, { method: "POST", pathAndQuery: "/tb/v1/call", body: raw });
    const r = await fetch(`${w.internalUrl}/tb/v1/call`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": a, "TB-Grant": presented }, body: raw });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.status, "ok");
    assert.ok(Array.isArray(body.output.items), "summaries list from the real SDK");
    // the same op outside the grant's wf is refused by the gate
    const raw2 = Buffer.from(JSON.stringify({ target: "holder", op: "tb.holds_list", input: {} }));
    const a2 = await w.api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: w.api.ulid() }, appKey, { method: "POST", pathAndQuery: "/tb/v1/call", body: raw2 });
    const r2 = await fetch(`${w.internalUrl}/tb/v1/call`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": a2, "TB-Grant": presented }, body: raw2 });
    assert.notEqual(r2.status, 200);
  });

  test("L3: a failing list catalog is reported (toolsOmitted catalog_failed, rejected bridge_op), not only logged", async () => {
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "l3" } } });
    await w.mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, init.session as string);
    const report = buildStatusReport(w.bridge.ctx);
    assert.ok(report.toolsOmitted.some((o) => o.ins === SDKINS && o.name === "broken_list" && o.code === "catalog_failed"), JSON.stringify(report.toolsOmitted));
    assert.ok(report.rejected.some((x) => x.kind === "bridge_op" && x.code === "catalog_failed"), JSON.stringify(report.rejected));
  });

  test("v0.1.14 connectionsSeen: reported after authentication, cleared once an accepted report carried it", async () => {
    await w.agentToken();
    const r = buildStatusReport(w.bridge.ctx);
    assert.ok(r.connectionsSeen?.some((c) => c.con === CON && !Number.isNaN(Date.parse(c.lastSeen))));
    assert.equal(await sendStatus(w.bridge.ctx), true);
    assert.ok(!buildStatusReport(w.bridge.ctx).connectionsSeen?.some((c) => c.con === CON), "cleared after the accepted ack");
  });

  test("C105c: a companion grant's `held` claim passes through unchanged; the TARGET app holds (202, holdId), never the bridge", async () => {
    const grant = await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${SDKINS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["delete"], mode: "bound", held: ["destructive", "money"], caps: {}, wf: ["item_purge"], polrev: 1 });
    await w.amend((c) => {
      c.grants = c.grants.filter((g) => {
        const p = JSON.parse(Buffer.from(g.split(".")[1] as string, "base64url").toString("utf8")) as { sub: string; aud: string };
        return !(p.sub === `tb:ins:${INS}` && p.aud === `tb:ins:${SDKINS}`);
      });
      c.grants.push(grant);
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
    const presented = w.bridge.ctx.table?.grants.get(`tb:ins:${INS}|tb:ins:${SDKINS}`)?.token as string;
    const held = (JSON.parse(Buffer.from(presented.split(".")[1] as string, "base64url").toString("utf8")) as { held: string[] }).held;
    assert.deepEqual(held, ["destructive", "money"], "the bridge relays Core's grant as minted");
    const raw = Buffer.from(JSON.stringify({ target: "holder", op: "item_purge", input: {}, idempotencyKey: "purge-0000001" }));
    const a = await w.api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: w.api.ulid() }, appKey, { method: "POST", pathAndQuery: "/tb/v1/call", body: raw });
    const r = await fetch(`${w.internalUrl}/tb/v1/call`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": a, "TB-Grant": presented }, body: raw });
    const body = await r.json();
    assert.equal(r.status, 202, JSON.stringify(body));
    assert.equal(body.status, "held");
    assert.equal(typeof body.holdId, "string");
    assert.equal(purges, 0, "a held destructive op does not run");
  });
});
