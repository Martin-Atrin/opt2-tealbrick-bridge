/**
 * BSD-08 (C62/C63, CREDENTIALS §9.5, BRIDGE §4.1/§4.3/§5.2): the trusted Portal key set comes only from the newest
 * root-signed key-set statement, pinned sealed in S1. Mirrors conformance B20 against the bridge's own world.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { applyConfig, statementKeys } from "../src/portal.ts";
import { makeWorld, type World, waitFor } from "./support/world.ts";

const applied = (w: World) => waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
const refusedWith = async (w: World, code: string) => {
  await waitFor(() => (w.bridge.ctx.rejected.get(`config|${code}`) ?? 0) > 0, 15000);
  assert.ok((w.bridge.ctx.table?.rev ?? 0) < w.rev(), `the ${code} document is not applied`);
};

describe("BSD-08: key-set statements at the bridge", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true, keySet: true });
    await applied(w);
  });
  after(async () => {
    await w.close();
  });

  test("B20.kss_enrolled: enrolment pins the statement; the trusted set = its keys", () => {
    const id = w.bridge.ctx.identity;
    assert.ok(id?.pinnedKeySet, "pinned at enrolment");
    assert.equal(id.pinnedKeySet.seq, 1);
    assert.equal(id.pinnedKeySet.kss, w.keySet.current());
    assert.deepEqual(id.portalKeys, statementKeys(w.keySet.current() as string));
  });

  test("B20.portal_keys_ignored: body portalKeys never changes the trusted set once a statement is pinned", async () => {
    const stranger = await w.api.generateKeyPair();
    const before = JSON.stringify(w.bridge.ctx.identity?.portalKeys);
    await w.publish((c) => {
      c.portalKeys = [{ jwk: stranger.publicJwk, status: "active" }];
    });
    await applied(w);
    assert.equal(JSON.stringify(w.bridge.ctx.identity?.portalKeys), before);
    assert.ok(!w.bridge.ctx.table?.issuers.keys.some((k) => w.api.thumbprint(k.jwk) === stranger.kid));
    // and a document signed by that key is refused even though an earlier body listed it
    w.setSigningKey(stranger);
    await w.publish((c) => {
      c.pause.workspace = true;
    });
    await waitFor(() => [...w.bridge.ctx.rejected.keys()].some((k) => k.startsWith("config|") && !k.includes("keyset")), 15000);
    assert.equal(w.bridge.ctx.table?.pausedWorkspace, false, "forged pause has no effect");
  });

  test("B20.kss_unknown_root: a statement signed by another root is refused (keyset_invalid)", async () => {
    const other = await w.api.generateKeyPair();
    await w.keySet.bump({ root: other });
    await w.publish((c) => {
      c.pause.workspace = true;
    });
    await refusedWith(w, "keyset_invalid");
    assert.equal(w.bridge.ctx.identity?.pinnedKeySet?.seq, 1, "pin unchanged");
    assert.equal(w.bridge.ctx.table?.pausedWorkspace, false);
  });
});

describe("BSD-08: rollback, missing, compromise, persistence", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true, keySet: true });
    await applied(w);
  });
  after(async () => {
    await w.close();
  });

  test("a newer statement is pinned (sealed S1) and survives a restart", async () => {
    await w.keySet.bump({ seq: 2 });
    await w.publish();
    await applied(w);
    assert.equal(w.bridge.ctx.identity?.pinnedKeySet?.seq, 2);
    await w.restart();
    await waitFor(() => !!w.bridge.ctx.table, 10000);
    assert.equal(w.bridge.ctx.identity?.pinnedKeySet?.seq, 2, "pin read back from the sealed identity");
    assert.equal(w.bridge.ctx.table?.rev, w.rev(), "boot copy verified under the pinned statement");
  });

  test("B20.kss_rollback: a lower seq (or a different statement with the same seq) is refused", async () => {
    await w.keySet.bump({ seq: 1 });
    await w.publish();
    await refusedWith(w, "keyset_rollback");
    assert.equal(w.bridge.ctx.identity?.pinnedKeySet?.seq, 2);
    await w.keySet.bump({ seq: 2 }); // same seq, different bytes (new iat)
    await w.publish();
    await waitFor(() => (w.bridge.ctx.rejected.get("config|keyset_rollback") ?? 0) > 1, 15000);
  });

  test("B20.kss_missing: after a pin, a config without portalKeySet is refused (no downgrade)", async () => {
    await w.keySet.bump({ seq: 3 });
    await w.publish((c) => {
      delete (c as { portalKeySet?: string }).portalKeySet;
    });
    await refusedWith(w, "keyset_missing");
    await w.publish();
    await applied(w);
    assert.equal(w.bridge.ctx.identity?.pinnedKeySet?.seq, 3);
  });

  test("B20.kss_compromise: a statement dropping a stolen key makes its documents fail at once", async () => {
    const stolen = await w.api.generateKeyPair();
    const fresh = await w.api.generateKeyPair();
    await w.keySet.bump({ keys: [{ key: stolen, status: "active" }] });
    w.setSigningKey(stolen);
    await w.publish();
    await applied(w);
    await w.keySet.bump({ keys: [{ key: fresh, status: "active" }] });
    w.setSigningKey(fresh);
    await w.publish();
    await applied(w);
    const pinnedSeq = w.bridge.ctx.identity?.pinnedKeySet?.seq;
    w.setSigningKey(stolen);
    const revBefore = w.bridge.ctx.table?.rev;
    await w.publish((c) => {
      c.pause.workspace = true;
    });
    await waitFor(() => [...w.bridge.ctx.rejected.keys()].some((k) => k.startsWith("config|") && !k.includes("keyset")), 15000);
    assert.equal(w.bridge.ctx.table?.rev, revBefore);
    assert.equal(w.bridge.ctx.table?.pausedWorkspace, false, "forged pause has no effect");
    assert.equal(w.bridge.ctx.identity?.pinnedKeySet?.seq, pinnedSeq);
  });

  test("the S2 boot copy is refused when it carries a statement older than the pin", async () => {
    const id = w.bridge.ctx.identity;
    assert.ok(id?.pinnedKeySet);
    const old = await w.keySet.bump({ seq: 1 });
    const doc = await w.signPortal("tb-config+jws", { ...JSON.parse(Buffer.from((w.bridge.ctx.state.loadConfigJws() ?? "").split(".")[1] ?? "", "base64url").toString("utf8")), portalKeySet: old });
    const ok = await applyConfig(w.bridge.ctx, doc, { boot: true });
    assert.equal(ok, false);
  });
});

describe("BSD-08 C63a: re-enrolment needs a valid statement once one is pinned", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true, keySet: true });
    await applied(w);
  });
  after(async () => {
    await w.close();
  });

  test("B20.kss_reenrol_missing: no / foreign statement → refused, S1 kept; a later config is applied under the old identity", async () => {
    const id0 = w.bridge.ctx.identity;
    assert.ok(id0?.pinnedKeySet);
    const kid0 = id0.key.kid;
    w.keySet.enrol("none");
    w.setEnv("TB_ENROL_CODE", "tbe_reenrolmissing01");
    await w.restart();
    await waitFor(() => !!w.bridge.ctx.table, 10000);
    assert.equal(w.bridge.ctx.identity?.key.kid, kid0, "old key kept");
    assert.deepEqual(w.bridge.ctx.identity?.pinnedKeySet, id0.pinnedKeySet, "pin kept");
    assert.ok((w.bridge.ctx.rejected.get("config|keyset_missing") ?? 0) > 0);
    // a statement by an unknown root: refused the same way
    const other = await w.api.generateKeyPair();
    const foreign = await w.keySet.bump({ root: other, seq: 9 });
    w.keySet.enrol({ jws: foreign });
    w.setEnv("TB_ENROL_CODE", "tbe_reenrolforeign01");
    await w.restart();
    await waitFor(() => !!w.bridge.ctx.table, 10000);
    assert.equal(w.bridge.ctx.identity?.key.kid, kid0);
    assert.ok((w.bridge.ctx.rejected.get("config|keyset_invalid") ?? 0) > 0);
    // the refused code is not tried again on the next start
    await w.restart();
    await waitFor(() => !!w.bridge.ctx.table, 10000);
    assert.ok((w.bridge.ctx.rejected.get("config|keyset_refused_enrolment") ?? 0) > 0);
    assert.equal(w.bridge.ctx.identity?.key.kid, kid0);
    // a following config with the (root-signed) statement is applied under the old identity
    await w.keySet.bump({ seq: 2 });
    await w.publish();
    await applied(w);
    assert.equal(w.bridge.ctx.identity?.pinnedKeySet?.seq, 2);
  });
});

describe("BSD-08 C133: no transition path (manifest 0.1.18 trustedPortalKeys)", () => {
  const keysetRejections = (w: World) => [...w.bridge.ctx.rejected.keys()].filter((k) => k.includes("keyset"));

  test("B20.kss_enrol_missing: a first enrolment without a statement is refused (keyset_missing); nothing is written", async () => {
    await assert.rejects(makeWorld({ real: true, enrolWithoutKeySet: true }), /enrolment refused: keyset_missing/);
  });

  test("the test double runs the same rule: no statement → keyset_missing", async () => {
    await assert.rejects(makeWorld({ enrolWithoutKeySet: true }), /enrolment refused: keyset_missing/);
  });

  test("a build without pinned roots refuses a valid statement (keyset_invalid)", async () => {
    await assert.rejects(makeWorld({ real: true, portalRoots: [] }), /enrolment refused: keyset_invalid/);
  });

  test("L34 quiet case: with a valid statement the bridge enrols, pins and applies configs with no key-set alarm", async () => {
    for (const real of [true, false]) {
      const w = await makeWorld({ real });
      try {
        await applied(w);
        assert.equal(w.bridge.ctx.identity?.pinnedKeySet?.seq, 1, `pinned (real=${real})`);
        await w.publish();
        await applied(w);
        assert.deepEqual(keysetRejections(w), [], `no key-set refusal on the good case (real=${real})`);
      } finally {
        await w.close();
      }
    }
  });
});
