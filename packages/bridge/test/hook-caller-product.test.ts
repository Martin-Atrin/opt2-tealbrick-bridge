/**
 * Bridge 0.2.2 / spec 0.1.45 (HOOK-CALLER-PRODUCT): every hook request (before, context, after) of an APP-initiated call
 * carries `call.caller.product`, the calling instance's product from the bridge's own signed config (the instance table).
 * It is absent for agents and for an app caller the table cannot map (a policy app then treats it as unverified).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CallRouter } from "../src/calls.ts";
import { AGT, APP_CODE, BRG, CON, HOOKINS, INS, makeWorld, type World, WS, waitFor } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);
const GHOST = "ins_01H0GH0ST0GH0ST0GH0ST0GH0S";

interface Seen {
  phase: string;
  caller: { type: string; id: string; product?: string; mode?: string };
}

describe("HOOK-CALLER-PRODUCT: call.caller.product on every hook phase", () => {
  let w: World;
  let appKey: Awaited<ReturnType<World["api"]["generateKeyPair"]>>;
  let grant: string;

  before(async () => {
    w = await makeWorld({ real: true, withHook: true });
    appKey = await w.api.generateKeyPair();
    const claim = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.2" }),
    });
    assert.equal(claim.status, 200);
    grant = await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read"], mode: "bound", held: ["money"], caps: {}, wf: ["notes_list"], polrev: 1 });
    const slice = await w.signPortal("tb-slice+jws", { v: 1, iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 43200, jti: w.api.ulid(), ws: WS, rev: 2, ins: INS, product: "notes", grants: [grant] });
    // the owner switches the declared context and after hooks on (they are listed with enabled:false by default)
    await w.publish((c) => {
      (c.apps[0] as { slice: string }).slice = slice;
      for (const h of c.hooks) if (h.ins === HOOKINS) delete (h as { enabled?: boolean }).enabled;
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && w.bridge.ctx.table?.apps.get(INS as never)?.down === false && w.bridge.ctx.table?.hooks.every((h) => h.enabled !== false) === true, 15000);
    w.hookMode.mode = "allow";
    w.hookMode.answer = (hook) => (hook === "enrich" ? { add: {} } : hook === "audit" ? {} : undefined);
  });
  after(async () => {
    w.hookMode.answer = undefined;
    await w.close();
  });

  /** The hook requests (all three phases) the guard app received since `from`. */
  const hooksSince = (from: number): Seen[] => w.appLog.hooks.slice(from).map((h) => ({ phase: h.body.phase as string, caller: (h.body.call as { caller: Seen["caller"] }).caller }));

  const companion = async (body: Record<string, unknown> = {}) => {
    const raw = Buffer.from(JSON.stringify({ target: "notes", op: "notes_list", input: {}, ...body }));
    const a = await w.api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: w.api.ulid() }, appKey, { method: "POST", pathAndQuery: "/tb/v1/call", body: raw });
    return fetch(`${w.internalUrl}/tb/v1/call`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": a, "TB-Grant": grant }, body: raw });
  };

  test("an app-initiated companion call: before, context and after all see caller.product = the caller's product", async () => {
    const from = w.appLog.hooks.length;
    const r = await companion();
    assert.equal(r.status, 200, await r.clone().text());
    const seen = hooksSince(from);
    assert.deepEqual(seen.map((s) => s.phase), ["before", "context", "after"]);
    for (const s of seen) {
      assert.equal(s.caller.type, "app", s.phase);
      assert.equal(s.caller.id, INS, s.phase);
      assert.equal(s.caller.product, "notes", `${s.phase} carries the product`);
    }
  });

  test("the product comes from the signed config, never from the request: a forged caller/product in the body changes nothing", async () => {
    const from = w.appLog.hooks.length;
    const r = await companion({ caller: { type: "app", id: INS, product: "kanban" }, product: "kanban", ins: GHOST });
    assert.equal(r.status, 200, await r.clone().text());
    const seen = hooksSince(from);
    assert.equal(seen.length, 3);
    for (const s of seen) {
      assert.equal(s.caller.id, INS);
      assert.equal(s.caller.product, "notes");
    }
  });

  test("an agent call: no product on any phase (quiet on good)", async () => {
    const t = w.bridge.ctx.table;
    const app = t?.apps.get(INS as never);
    const op = app?.ops.get("notes_list");
    assert.ok(app && op);
    const from = w.appLog.hooks.length;
    await new CallRouter(w.bridge.ctx).route({ caller: { type: "agent", agt: AGT as never, con: CON as never }, target: { app, op }, input: {} as never });
    const seen = hooksSince(from);
    assert.deepEqual(seen.map((s) => s.phase), ["before", "context", "after"]);
    for (const s of seen) {
      assert.equal(s.caller.type, "agent");
      assert.equal(s.caller.id, AGT);
      assert.equal("product" in s.caller, false, `${s.phase}: the key is absent, not null or empty`);
    }
  });

  test("an app caller the instance table cannot map: no product (fire-on-bad)", async () => {
    const t = w.bridge.ctx.table;
    const app = t?.apps.get(INS as never);
    const op = app?.ops.get("notes_list");
    assert.ok(app && op);
    const ghostGrant = await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:ins:${GHOST}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read"], mode: "bound", held: ["money"], caps: {}, wf: ["notes_list"], polrev: 1 });
    const from = w.appLog.hooks.length;
    await new CallRouter(w.bridge.ctx).route({ caller: { type: "app", ins: GHOST as never, grant: ghostGrant }, target: { app, op }, input: {} as never });
    const seen = hooksSince(from);
    assert.deepEqual(seen.map((s) => s.phase), ["before", "context", "after"]);
    for (const s of seen) {
      assert.equal(s.caller.type, "app");
      assert.equal(s.caller.id, GHOST);
      assert.equal("product" in s.caller, false, `${s.phase}: unmapped means unverified, no product`);
    }
  });
});
