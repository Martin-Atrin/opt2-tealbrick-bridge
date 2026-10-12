/**
 * QA App-to-App A2A-2 / A2A-3 (adversarial): a companion call's `parentCall` is accepted only when it is an OPEN call
 * this bridge delivered to THAT (verified) caller instance within the TTL. Forged, foreign, finished and expired ids
 * are app-initiated (rate-limited + audited); malformed or oversized ids are refused before they are logged.
 * Also: the companion grant's `sub` is checked against the instance from the verified assertion, never the body.
 */
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";
import { CallRouter, PARENT_CALL_TTL_MS } from "../src/calls.ts";
import { AGT, APP_CODE, BRG, CON, INS, makeWorld, type World, WS, waitFor } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);

describe("A2A-2/3: parentCall is bound to an open call delivered to the caller", () => {
  let w: World;
  let grant: string;
  let appKey: Awaited<ReturnType<World["api"]["generateKeyPair"]>>;
  const events: { e: string; f: Record<string, unknown> }[] = [];
  const log = (e: string, f?: Record<string, unknown>) => void events.push({ e, f: f ?? {} });

  before(async () => {
    w = await makeWorld({ real: true, logger: { info: log, warn: log, error: log } as never });
    appKey = await w.api.generateKeyPair();
    const claim = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.2" }),
    });
    assert.equal(claim.status, 200);
    grant = await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read"], mode: "bound", held: ["money"], caps: {}, wf: ["notes_list"], polrev: 1 });
    const slice = await w.signPortal("tb-slice+jws", { v: 1, iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 43200, jti: w.api.ulid(), ws: WS, rev: 2, ins: INS, product: "notes", grants: [grant] });
    await w.publish((c) => {
      (c.apps[0] as { slice: string }).slice = slice;
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && w.bridge.ctx.table?.apps.get(INS as never)?.down === false, 15000);
  });
  after(async () => {
    await w.close();
  });

  const companion = async (body: Record<string, unknown>, presented = grant) => {
    const raw = Buffer.from(JSON.stringify({ target: "notes", op: "notes_list", input: {}, ...body }));
    const a = await w.api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: w.api.ulid() }, appKey, { method: "POST", pathAndQuery: "/tb/v1/call", body: raw });
    return fetch(`${w.internalUrl}/tb/v1/call`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": a, "TB-Grant": presented }, body: raw });
  };

  test("the companion grant's sub is checked against the VERIFIED caller instance (never the body)", async () => {
    const otherSub = await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: "tb:ins:ins_01H0THER0THER0THER0THER0TH", aud: `tb:ins:${INS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read"], mode: "bound", held: ["money"], caps: {}, wf: ["notes_list"], polrev: 1 });
    const r = await companion({ parentCall: undefined, caller: "ins_01H0THER0THER0THER0THER0TH", ins: "ins_01H0THER0THER0THER0THER0TH" }, otherSub);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, "grant_invalid");
  });

  test("A2A-3: malformed or oversized parentCall → 400 parent_call_invalid, never logged", async () => {
    for (const bad of ["not-a-call", 42, { x: 1 }, `call_${"A".repeat(26)}x`, `call_${"x".repeat(900_000)}`]) {
      const before = events.length;
      const r = await companion({ parentCall: bad });
      assert.equal(r.status, 400, String(bad).slice(0, 40));
      assert.equal((await r.json()).error.code, "parent_call_invalid");
      const logged = JSON.stringify(events.slice(before));
      assert.ok(logged.length < 4000, "nothing large reaches the log");
      if (typeof bad === "string") assert.ok(!logged.includes(bad.slice(0, 200)), "the raw value is not logged");
    }
  });

  test("A2A-2: a forged (well-formed, unknown) parentCall is app-initiated: audited, and limited like any app call", async () => {
    const forged = `call_${w.api.ulid()}`;
    const first = await companion({ parentCall: forged });
    assert.equal(first.status, 200, await first.clone().text());
    assert.ok(events.some((x) => x.e === "call.app_initiated" && x.f.ins === INS && x.f.parentCall === null), "audited as app-initiated");
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await companion({ parentCall: `call_${w.api.ulid()}` });
      if (r.status === 429) limited = true;
      else await r.arrayBuffer();
    }
    assert.ok(limited, "a forged parentCall does not bypass the app-initiated limit");
  });

  test("A2A-2: only an OPEN call delivered to THAT instance is a parent; foreign, finished and expired are not", async () => {
    const router = new CallRouter(w.bridge.ctx);
    let release: (() => void) | undefined;
    w.appOps.override = (op: string, _b: Record<string, unknown>, res: ServerResponse) => {
      if (op !== "notes_list") return false;
      release = () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", output: { items: [] } }));
      return true;
    };
    const app = w.bridge.ctx.table?.apps.get(INS as never);
    const op = app?.ops.get("notes_list");
    assert.ok(app && op);
    const running = router.route({ caller: { type: "agent", agt: AGT as never, con: CON as never }, target: { app, op }, input: {} as never });
    await waitFor(() => !!release, 10000);
    const open = [...(router as unknown as { active: Map<string, { startedMs: number }> }).active.keys()][0] as string;
    assert.equal(router.parentCallFor(INS, open), open, "the target instance of an open call may name it");
    assert.equal(router.parentCallFor("ins_01H0THER0THER0THER0THER0TH", open), undefined, "a foreign instance may not");
    const entry = (router as unknown as { active: Map<string, { startedMs: number }> }).active.get(open) as { startedMs: number };
    const started = entry.startedMs;
    entry.startedMs = Date.now() - PARENT_CALL_TTL_MS - 1;
    assert.equal(router.parentCallFor(INS, open), undefined, "expired");
    entry.startedMs = started;
    release?.();
    await running;
    assert.equal(router.parentCallFor(INS, open), undefined, "finished");
    w.appOps.override = undefined;
  });

});
