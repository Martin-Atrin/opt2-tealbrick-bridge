import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { internalUrlAllowed } from "../src/table.ts";
import { AGT, BRG, CON, INS, makeWorld, type World, WS, waitFor } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);

describe("C62: bridge state, channel and proof hardening (real manifest crypto)", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  test("BSD-03/13: every state file except the signed config is sealed; no plaintext, no temp leftovers", () => {
    const dir = join(w.dataDir, "bridge");
    const files = readdirSync(dir);
    assert.ok(files.includes("identity.sealed.json"));
    assert.ok(!files.includes("identity.json"));
    assert.ok(!files.some((f) => f.includes(".tmp-")), "no temp files left");
    const text = readFileSync(join(dir, "identity.sealed.json"), "utf8");
    assert.ok(!text.includes(WS) && !text.includes("portalKeys"), "identity record is sealed, not readable");
  });

  test("BSD-03: a planted (untrusted) config on the volume is refused at boot; the trust anchor is unchanged", async () => {
    const dir = join(w.dataDir, "bridge");
    const trustedBefore = JSON.stringify(w.bridge.ctx.identity?.portalKeys);
    const stranger = await w.api.generateKeyPair();
    const good = JSON.parse(Buffer.from((readFileSync(join(dir, "config.jws"), "utf8").split(".")[1] as string), "base64url").toString("utf8"));
    const forged = await w.api.signJws("tb-config+jws" as never, { ...good, rev: good.rev + 100, portalKeys: [{ jwk: stranger.publicJwk, status: "active" }], jti: w.api.ulid() }, stranger);
    w.portalDown();
    writeFileSync(join(dir, "config.jws"), forged);
    await w.restart();
    assert.equal(w.bridge.ctx.table, undefined, "planted config not loaded");
    assert.equal(JSON.stringify(w.bridge.ctx.identity?.portalKeys), trustedBefore, "portalKeys not adopted from the planted file");
    assert.ok([...w.bridge.ctx.rejected.keys()].some((k) => k.startsWith("config|")));
  });

  test("BSD-03 / C133: a plaintext state file is refused (never read)", async () => {
    const { BridgeState, keksFromEnv } = await import("../src/state.ts");
    const dir = join(w.dataDir, "bridge");
    writeFileSync(join(dir, "claims.json"), JSON.stringify([{ ins: INS, kind: "instance" }]));
    const st = new BridgeState(w.dataDir, w.api, keksFromEnv({ TB_KEK: "11".repeat(32) }, w.api));
    assert.throws(() => st.load(), /plaintext state \(a bridge before 0\.1\.12\) is not accepted; re-enrol/);
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "claims.json"));
  });

});

describe("C62: proofs, oracle, revocation reporting", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  test("BSD-08/15: status reports carry portalKeysDigest and apps[].sliceRevision", async () => {
    const { buildStatusReport } = await import("../src/portal.ts");
    const last = buildStatusReport(w.bridge.ctx);
    const id = w.bridge.ctx.identity;
    assert.ok(id);
    assert.equal(last.portalKeysDigest, w.api.digest(id.portalKeys as never), "digest of the trusted portalKeys");
    assert.match(last.portalKeysDigest ?? "", /^sha256:/);
    await waitFor(() => buildStatusReport(w.bridge.ctx).apps.length > 0, 15000);
    const before = buildStatusReport(w.bridge.ctx);
    assert.ok(before.apps.some((a) => a.ins === INS), JSON.stringify(before.apps));
    for (const a of before.apps) if (!w.bridge.ctx.health.get(a.ins)) assert.ok(!("sliceRevision" in a), "omitted before the app reports");
    const prev = w.bridge.ctx.health.get(INS);
    w.bridge.ctx.health.set(INS, { status: { ...(prev?.status ?? {}), sliceRevision: 7 } as never, lastSeen: Math.floor(Date.now() / 1000) });
    const r = buildStatusReport(w.bridge.ctx);
    assert.equal(r.apps.find((a) => a.ins === INS)?.sliceRevision, 7);
    if (prev) w.bridge.ctx.health.set(INS, prev);
    else w.bridge.ctx.health.delete(INS);
  });

  test("H-3: unknown connection and wrong-key assertion for a real connection answer identically", async () => {
    const tok = (assertion: string) =>
      fetch(`${w.publicUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
    const unknown = await tok(await w.agentAssertion(AGT, `con_${w.api.ulid()}`));
    const stranger = await w.api.generateKeyPair();
    const wrongKey = await tok(await w.api.signAssertion("tb-agent-assert+jwt", { iss: `tb:agt:${AGT}`, sub: `tb:agt:${AGT}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: w.api.ulid(), con: CON }, stranger));
    assert.equal(unknown.status, wrongKey.status);
    assert.deepEqual(await unknown.json(), await wrongKey.json());
  });

  test("BSD-12: after a restart, a proof signed before the boot is refused (no replay across restarts)", async () => {
    const old = await w.agentAssertion(AGT, CON);
    await new Promise((r) => setTimeout(r, 1100));
    await w.restart();
    await waitFor(() => !!w.bridge.ctx.table, 10000);
    const r = await fetch(`${w.publicUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: old }) });
    assert.equal(r.status, 400);
    assert.ok(await w.agentToken(), "a freshly signed assertion works");
  });

  test("BSD-11: a refresh-reuse revoke survives a restart until Portal confirmed it", async () => {
    w.setAckFails(true);
    const { revokeLocal } = await import("../src/identity.ts");
    revokeLocal(w.bridge.ctx, "con_01HREVOKEDREVOKEDREVOKEDRE" as never, "refresh_reuse");
    await w.restart();
    assert.ok(w.bridge.ctx.state.reports.revoked.some((r) => r.reason === "refresh_reuse"), "persisted across restart");
    w.setAckFails(false);
    await waitFor(() => w.acks.some((a) => a.connectionsRevoked.some((c) => c.con === "con_01HREVOKEDREVOKEDREVOKEDRE")), 15000);
    await waitFor(() => w.bridge.ctx.state.reports.revoked.length === 0, 15000);
  });

  test("BSD-09: config pulls are spaced ≥ ~5 s even when Portal answers fast", async () => {
    const before = w.pulls();
    await new Promise((r) => setTimeout(r, 6000));
    assert.ok(w.pulls() - before <= 2, `pulls in 6 s: ${w.pulls() - before}`);
  });
});

describe("C62 BSD-07: internalUrl allow-list", () => {
  test("BRIDGE §5.7: railway.internal, or ownInfra + TB_OWN_INFRA_ORIGINS (isPrivateInternalUrl)", async () => {
    const { manifestApi } = await import("@opt2-tealbrick/relay");
    const api = manifestApi();
    const ok = (u: string, own = false, list: string[] = []) => internalUrlAllowed(api, u, own, list);
    assert.equal(ok("http://knowledge.railway.internal:8080"), true);
    assert.equal(ok("http://knowledge.railway.internal"), false, "explicit port");
    assert.equal(ok("https://evil.example"), false);
    assert.equal(ok("http://evil.example:80"), false);
    assert.equal(ok("http://a@knowledge.railway.internal:8080"), false);
    assert.equal(ok("http://knowledge.railway.internal:8080/x"), false);
    assert.equal(ok("http://127.0.0.1:9000", false, ["http://127.0.0.1:9000"]), false, "listed origin without ownInfra");
    assert.equal(ok("http://127.0.0.1:9000", true, ["http://127.0.0.1:9000"]), true);
    assert.equal(ok("http://127.0.0.1:9001", true, ["http://127.0.0.1:9000"]), false, "exact origin");
    assert.equal(ok("https://nas.local:8443", true, ["https://nas.local:8443"]), true);
    assert.equal(ok("https://attacker.example", true, []), false, "ownInfra alone is not enough");
  });

  test("a config pointing an app outside the allow-list marks it refused; no request is sent there", async () => {
    const w = await makeWorld();
    try {
      await w.publish((c) => {
        (c.apps[0] as { internalUrl: string; ownInfra?: boolean }).internalUrl = "https://attacker.example";
        (c.apps[0] as { ownInfra?: boolean }).ownInfra = true;
      });
      await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 10000);
      const app = w.bridge.ctx.table?.apps.get(INS as never);
      assert.equal(app?.down, true);
      assert.equal(app?.refused, true);
      assert.ok([...w.bridge.ctx.rejected.keys()].includes("config|internal_url_refused"));
      assert.equal((await fetch(`${w.publicUrl}/a/notes/`)).status, 503);
    } finally {
      await w.close();
    }
  });
});

describe("C133: plaintext state of a bridge before 0.1.12 is refused, never read or resealed", () => {
  test("a 0.1.11 data dir fails with a clear error; nothing is read or rewritten; sealed state alone loads (quiet)", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { manifestApi } = await import("@opt2-tealbrick/relay");
    const { BridgeState, keksFromEnv } = await import("../src/state.ts");
    const api = manifestApi();
    const data = mkdtempSync(join(tmpdir(), "tb-plain-"));
    try {
      const dir = join(data, "bridge");
      mkdirSync(dir, { recursive: true });
      const keks = keksFromEnv({ TB_KEK: "22".repeat(32) }, api);
      const key = await api.generateKeyPair();
      const pkcs8 = await api.exportPrivateKey(key);
      writeFileSync(join(dir, "identity.json"), JSON.stringify({ bridgeId: BRG, workspaceId: WS, kid: key.kid, publicKey: key.publicJwk, sealedPrivateKey: api.seal(pkcs8, keks.current, `tb:seal:bridge-key:${key.kid}`), portalKeys: [], enrolCodeDigest: "sha256:00", configPath: "/c", ackPath: "/a" }));
      writeFileSync(join(dir, "jtis.json"), JSON.stringify({ J1: now() + 600 }));
      const st = new BridgeState(data, api, keks);
      // BRG-25: ONE check at boot names every plaintext file
      assert.throws(() => st.load(), /^Error: identity\.json, jtis\.json: plaintext state \(a bridge before 0\.1\.12\) is not accepted; re-enrol this bridge/);
      assert.deepEqual(readdirSync(dir).sort(), ["identity.json", "jtis.json"], "nothing resealed, nothing removed");
      // quiet on the good case: a fresh sealed state saves and loads without any error
      rmSync(join(dir, "identity.json"));
      rmSync(join(dir, "jtis.json"));
      const fresh = new BridgeState(data, api, keks);
      fresh.load();
      await fresh.saveIdentity({ bridgeId: BRG as never, workspaceId: WS as never, key, portalKeys: [], enrolCodeDigest: "sha256:00" as never, configPath: "/c", ackPath: "/a" });
      const again = new BridgeState(data, api, keks);
      again.load();
      assert.equal((await again.loadIdentity())?.bridgeId, BRG, "sealed state reloads");
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});
