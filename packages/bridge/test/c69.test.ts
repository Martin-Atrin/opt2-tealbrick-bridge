import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { APP_CODE, BRG, INS, makeWorld, type World, waitFor } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);

describe("C69: companion key fetch decides from the signed config, not the live manifest", () => {
  let w: World;
  let assertFor: (path: string) => Promise<string>;
  before(async () => {
    w = await makeWorld({ real: true });
    const appKey = await w.api.generateKeyPair();
    const claim = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.2" }),
    });
    assert.equal(claim.status, 200);
    assertFor = (path) => w.api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: w.api.ulid() }, appKey, { method: "GET", pathAndQuery: path });
    w.bridge.ctx.state.keyStore.values.NOTES_API_KEY = "sk-c69-test";
  });
  after(async () => {
    await w.close();
  });

  const fetchKey = async (name: string) => fetch(`${w.internalUrl}/tb/v1/keys/${name}`, { headers: { "TB-Assert": await assertFor(`/tb/v1/keys/${name}`) } });

  test("manifest fetch_failed during an update: companions still get declared keys; undeclared ones are transient 503, never 403", async () => {
    assert.equal((await fetchKey("NOTES_API_KEY")).status, 200, "baseline");
    w.updateApp(1_000_000);
    await w.publish();
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 10000);
    const app = w.bridge.ctx.table?.apps.get(INS as never);
    assert.ok(app && (app.down || !app.manifest), "the app is mid-deploy (manifest not loaded)");
    const k = await fetchKey("NOTES_API_KEY");
    assert.equal(k.status, 200, "declared in the signed config keyRequirements → served");
    assert.equal((await k.json()).value, "sk-c69-test");
    const other = await fetchKey("OTHER");
    assert.equal(other.status, 503, "cannot decide while the app updates: transient, not key_not_declared");
    assert.equal(other.headers.get("retry-after"), "5");
    assert.equal((await other.json()).error.code, "app_unavailable");
  });
});
