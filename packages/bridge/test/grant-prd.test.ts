/**
 * Bridge 0.2.3 / manifest 0.1.23 / spec 0.1.46 (GRANT-PRD, C230): a companion grant may carry `prd`, the product of the
 * calling instance. Core mints it only for bridges >= 0.2.3, so this bridge MUST verify such grants:
 *  - gate() on the bridge accepts a companion grant WITH a well-formed `prd` and refuses one with a malformed `prd`
 *    (`grant_invalid`, nothing forwarded, no hook run);
 *  - the hook rule: `call.caller.product` keeps coming from the bridge's instance table; when the presented grant also
 *    carries a `prd` that differs from the table's product, the hook request OMITS `product` and the bridge logs the
 *    warning `bridge.hooks.caller_product_mismatch` (both product ids, no tokens). Equal → present; no `prd` → the
 *    table's product (the 0.2.2 behaviour).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { jsonLogger } from "../src/util.ts";
import { APP_CODE, BRG, HOOKINS, INS, makeWorld, type World, WS, waitFor } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);

interface Seen {
  phase: string;
  caller: { type: string; id: string; product?: string };
}

describe("GRANT-PRD: companion grants with prd on the bridge", () => {
  let w: World;
  let appKey: Awaited<ReturnType<World["api"]["generateKeyPair"]>>;
  const lines: string[] = [];
  const grants: Record<"none" | "equal" | "other" | "malformed", string> = { none: "", equal: "", other: "", malformed: "" };

  before(async () => {
    w = await makeWorld({ real: true, withHook: true, logger: jsonLogger((l) => lines.push(l)) });
    appKey = await w.api.generateKeyPair();
    const claim = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.2" }),
    });
    assert.equal(claim.status, 200);
    const mint = (extra: Record<string, unknown>, unchecked = false) =>
      (unchecked ? w.signPortalUnchecked : w.signPortal)("tb-grant+jwt", { iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read"], mode: "bound", held: ["money"], caps: {}, wf: ["notes_list"], polrev: 1, ...extra });
    grants.none = await mint({});
    grants.equal = await mint({ prd: "notes" });
    grants.other = await mint({ prd: "kanban" });
    // the manifest library refuses to SIGN a malformed prd, so this token is assembled without its claim check
    grants.malformed = await mint({ prd: "Not A Product!" }, true);
    const slice = await w.signPortal("tb-slice+jws", { v: 1, iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 43200, jti: w.api.ulid(), ws: WS, rev: 2, ins: INS, product: "notes", grants: Object.values(grants) });
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

  const hooksSince = (from: number): Seen[] => w.appLog.hooks.slice(from).map((h) => ({ phase: h.body.phase as string, caller: (h.body.call as { caller: Seen["caller"] }).caller }));
  const mismatchLines = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "bridge.hooks.caller_product_mismatch");

  const companion = async (grant: string) => {
    const raw = Buffer.from(JSON.stringify({ target: "notes", op: "notes_list", input: {} }));
    const a = await w.api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: w.api.ulid() }, appKey, { method: "POST", pathAndQuery: "/tb/v1/call", body: raw });
    return fetch(`${w.internalUrl}/tb/v1/call`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": a, "TB-Grant": grant }, body: raw });
  };

  test("the pinned manifest library knows `prd` (0.1.23): a companion grant with a valid prd verifies", () => {
    const t = w.bridge.ctx.table;
    assert.ok(t);
    const v = w.api.verifyGrant(grants.equal, { now: now(), self: `tb:ins:${INS}`, ws: t.ws, bridge: t.bridgeId, issuers: t.issuers, bridgeKeys: t.bridgeKeys, revokedJtis: t.revokedJtis } as never);
    assert.ok("claims" in v, JSON.stringify(v));
    assert.equal((v.claims as { prd?: string }).prd, "notes");
  });

  test("gate() passes a companion grant WITH a valid prd (the call runs, 200)", async () => {
    const before = w.appLog.ops.length;
    const r = await companion(grants.equal);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(w.appLog.ops.length, before + 1, "forwarded to the app");
  });

  test("gate() refuses a companion grant with a MALFORMED prd: grant_invalid, nothing forwarded, no hook (fire-on-bad)", async () => {
    const ops = w.appLog.ops.length;
    const hooks = w.appLog.hooks.length;
    const r = await companion(grants.malformed);
    const text = await r.text();
    assert.equal(r.status, 403, text);
    assert.match(text, /grant_invalid/);
    assert.equal(w.appLog.ops.length, ops, "not forwarded");
    assert.equal(w.appLog.hooks.length, hooks, "no hook ran: the gate sits before the hooks");
    // the refusal never echoes the grant
    assert.equal(text.includes(grants.malformed), false);
  });

  test("hook rule: prd equal to the table's product → product present on every phase, no warning", async () => {
    const from = w.appLog.hooks.length;
    const r = await companion(grants.equal);
    assert.equal(r.status, 200, await r.clone().text());
    const seen = hooksSince(from);
    assert.deepEqual(seen.map((s) => s.phase), ["before", "context", "after"]);
    for (const s of seen) assert.equal(s.caller.product, "notes", s.phase);
    assert.equal(mismatchLines().length, 0, "no mismatch, no warning");
  });

  test("hook rule: no prd (an older Core) → the table's product, as in 0.2.2, no warning", async () => {
    const from = w.appLog.hooks.length;
    const r = await companion(grants.none);
    assert.equal(r.status, 200, await r.clone().text());
    const seen = hooksSince(from);
    assert.equal(seen.length, 3);
    for (const s of seen) assert.equal(s.caller.product, "notes", s.phase);
    assert.equal(mismatchLines().length, 0);
  });

  test("hook rule: prd differs from the table's product → product ABSENT on every phase + warning with both ids, no tokens (fire-on-bad)", async () => {
    const from = w.appLog.hooks.length;
    const r = await companion(grants.other);
    assert.equal(r.status, 200, "the call itself is not refused: only the hook's product claim is withheld");
    const seen = hooksSince(from);
    assert.deepEqual(seen.map((s) => s.phase), ["before", "context", "after"]);
    for (const s of seen) {
      assert.equal(s.caller.type, "app");
      assert.equal(s.caller.id, INS);
      assert.equal("product" in s.caller, false, `${s.phase}: the key is absent, not null or the other value`);
    }
    const warn = mismatchLines();
    assert.equal(warn.length, 1);
    assert.equal(warn[0]?.level, "warn");
    assert.equal(warn[0]?.tableProduct, "notes");
    assert.equal(warn[0]?.grantProduct, "kanban");
    assert.equal(warn[0]?.ins, INS);
    for (const l of lines) for (const g of Object.values(grants)) assert.equal(l.includes(g), false, "no grant token in any log line");
  });
});
