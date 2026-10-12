import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CallRouter, sliceGrants } from "../src/calls.ts";
import { BridgeError } from "../src/util.ts";
import { AGT, BRG, CON, HOOKINS, INS, makeWorld, type World, WS, waitFor } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);

describe("C70: grant_stale for companion grants from an older slice revision", () => {
  let w: World;
  const companion = (extra: Record<string, unknown> = {}) =>
    w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read"], mode: "bound", held: ["money"], caps: {}, wf: ["notes_list"], polrev: 1, ...extra });
  const sliceWith = (rev: number, grants: string[]) =>
    w.signPortal("tb-slice+jws", { v: 1, iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 43200, jti: w.api.ulid(), ws: WS, rev, ins: INS, product: "notes", grants });
  const callWith = async (grant: string): Promise<string> => {
    const t = w.bridge.ctx.table;
    const app = t?.apps.get(INS as never);
    const op = app?.ops.get("notes_list");
    assert.ok(app && op);
    try {
      const { result } = await new CallRouter(w.bridge.ctx).route({ caller: { type: "app", ins: INS as never, grant }, target: { app, op }, input: {} as never });
      return result.status;
    } catch (e) {
      return e instanceof BridgeError ? e.code : String(e);
    }
  };
  const publishSlice = async (slice: string) => {
    await w.publish((c) => {
      (c.apps[0] as { slice: string }).slice = slice;
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && w.bridge.ctx.table?.apps.get(INS as never)?.down === false, 10000);
  };

  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  test("current-slice grant passes; the previous revision's grant → grant_stale; exp keeps grant_expired", async () => {
    const a = await companion();
    await publishSlice(await sliceWith(2, [a]));
    assert.deepEqual(sliceGrants(w.bridge.ctx.table?.apps.get(INS as never)), [a]);
    assert.equal(await callWith(a), "ok");
    const b = await companion();
    await publishSlice(await sliceWith(3, [b]));
    assert.equal(await callWith(b), "ok");
    assert.equal(await callWith(a), "grant_stale", "valid but minted under the older slice");
    const expired = await companion({ iat: now() - 7200, exp: now() - 3600 });
    assert.equal(await callWith(expired), "grant_expired");
  });

  test("a slice without a grants claim (older Core) skips the check", () => {
    assert.equal(sliceGrants({ entry: { slice: `h.${Buffer.from(JSON.stringify({ rev: 1 })).toString("base64url")}.s` } } as never), undefined);
    assert.equal(sliceGrants(undefined), undefined);
  });
});

describe("C62 post-merge: a hook app that is down fails closed without a request", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true, withHook: true });
  });
  after(async () => {
    await w.close();
  });

  test("before-hook on a down app → hook_failed, no hook request sent", async () => {
    const t = w.bridge.ctx.table;
    const app = t?.apps.get(INS as never);
    const op = app?.ops.get("notes_list");
    const hook = t?.apps.get(HOOKINS as never);
    assert.ok(app && op && hook);
    hook.down = true;
    const before = w.appLog.hooks.length;
    let code = "ok";
    try {
      await new CallRouter(w.bridge.ctx).route({ caller: { type: "agent", agt: AGT as never, con: CON as never }, target: { app, op }, input: {} as never });
    } catch (e) {
      code = e instanceof BridgeError ? e.code : String(e);
    }
    assert.equal(code, "hook_failed");
    assert.equal(w.appLog.hooks.length, before, "no request to the down hook app");
  });
});
