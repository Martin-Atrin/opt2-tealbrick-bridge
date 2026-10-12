/**
 * F39 REAL-to-REAL (L2): the CLI's selfRevoke (used by `tealbrick adopt --undo`) against a REAL bridge (test world):
 * the agent revokes its OWN key connection; the bridge refuses it at once and reports client_revoke to Portal.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AGT, BRG, CON, makeWorld, type World, WS } from "../../bridge/test/support/world.ts";
import type { Ctx } from "../src/ctx.ts";
import { selfRevoke } from "../src/lead.ts";
import type { AgentItem } from "../src/relay-main.ts";

describe("F39: CLI selfRevoke against a real bridge", () => {
  let w: World;
  let item: AgentItem;
  before(async () => {
    w = await makeWorld({ real: true });
    const pkcs8 = await w.api.exportPrivateKey(w.agentKey);
    item = { v: 1, kind: "agent", con: CON as never, agt: AGT as never, ws: WS, bridgeId: BRG as never, bridgeUrl: `${w.publicUrl}/mcp`, tokenEndpoint: `${w.publicUrl}/oauth/token`, harness: "claude", label: "t", publicJwk: w.agentKey.publicJwk, privateKey: Buffer.from(pkcs8).toString("base64url"), createdAt: new Date().toISOString() };
  });
  after(async () => {
    await w.close();
  });
  const ctx = { now: () => Date.now(), io: { fetch: globalThis.fetch } } as unknown as Ctx;

  test("revokes the own connection, the bridge reports client_revoke; a second run says already; a dead bridge is a soft failure", async () => {
    assert.deepEqual(await selfRevoke(ctx, item), { ok: true, already: false });
    await new Promise((r) => setTimeout(r, 50));
    const tok = await fetch(`${w.publicUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await w.agentAssertion(AGT, CON) }) });
    assert.notEqual(tok.status, 200, "no access token after the revoke");
    for (let i = 0; i < 150 && !w.acks.some((a) => a.connectionsRevoked.some((x) => x.con === CON && x.reason === "client_revoke")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(w.acks.some((a) => a.connectionsRevoked.some((x) => x.con === CON && x.reason === "client_revoke")), "reported to Portal");
    assert.deepEqual(await selfRevoke(ctx, item), { ok: true, already: true });
    const dead = await selfRevoke(ctx, { ...item, tokenEndpoint: "http://127.0.0.1:9/oauth/token" });
    assert.equal(dead.ok, false);
  });
});
