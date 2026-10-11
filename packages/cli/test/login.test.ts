import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { apiError, Harness } from "./fixtures.ts";

const TOKEN = "tbo_secret_token_value_12345";

describe("login / logout", () => {
  let h: Harness;
  beforeEach(async () => {
    h = new Harness();
    await h.setup();
  });
  afterEach(async () => {
    await h.teardown();
  });

  function startRoute(): void {
    h.portal.on("POST", "/device/authorize", () => ({
      body: {
        device_code: "tbdv_secretdevicecode",
        user_code: "BCDF-GHJK",
        verification_uri: `${h.portal.origin}/device`,
        verification_uri_complete: `${h.portal.origin}/device?user_code=BCDF-GHJK`,
        expires_in: 600,
        interval: 5,
      },
    }));
  }

  it("device flow: pending, slow_down, success; honours interval; stores K3 without printing it", async () => {
    startRoute();
    const script = [apiError(400, "authorization_pending"), apiError(400, "slow_down"), { body: { scope: "owner", access_token: TOKEN, token_type: "Bearer", expires_in: 86400, session_id: "osn_01ABC" } }];
    h.portal.on("POST", "/device/token", () => script.shift() as any);
    await h.store.put("tealbrick.agent.con_01X", JSON.stringify({ kind: "agent", agt: "agt_01X" }));

    const r = await h.run(["login", "--json", "--open"]);
    assert.equal(r.code, 0);
    assert.deepEqual(h.sleeps, [5000, 5000, 10000]);
    assert.equal(r.json.signedIn, true);
    assert.equal(r.json.sessionId, "osn_01ABC");
    // start request shape
    const start = h.portal.calls("POST", "/device/authorize")[0];
    assert.deepEqual(start?.body, { scope: "owner", client_id: "tealbrick-cli", machine_label: "test-host" });
    // token request shape
    const tok = h.portal.calls("POST", "/device/token")[0];
    assert.equal(tok?.body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(tok?.body.client_id, "tealbrick-cli");
    assert.equal(tok?.headers.authorization, undefined);
    // user code on stderr, secrets nowhere
    assert.match(r.err, /BCDF-GHJK/);
    assert.match(r.err, /same OS user/);
    for (const text of [r.out, r.err]) {
      assert.ok(!text.includes(TOKEN));
      assert.ok(!text.includes("tbdv_secretdevicecode"));
    }
    assert.deepEqual(h.opened, [`${h.portal.origin}/device?user_code=BCDF-GHJK`]);
    // stored in the person item
    const stored = JSON.parse((await h.store.get("tealbrick.person")) as string);
    assert.equal(stored.token, TOKEN);
    assert.equal(stored.sessionId, "osn_01ABC");
    assert.equal(stored.portal, h.portal.origin);
    assert.ok(stored.expiresAt);
  });

  it("denied and expired map to exit 10", async () => {
    startRoute();
    h.portal.on("POST", "/device/token", () => apiError(400, "access_denied"));
    const denied = await h.run(["login", "--json"]);
    assert.equal(denied.code, 10);
    assert.equal(denied.json.error.code, "access_denied");

    h.portal.on("POST", "/device/token", () => apiError(400, "expired_token"));
    const expired = await h.run(["login", "--json"]);
    assert.equal(expired.code, 10);
    assert.equal(expired.json.error.code, "expired_token");
    assert.equal(await h.store.get("tealbrick.person"), null);
  });

  it("stops at expires_in", async () => {
    h.portal.on("POST", "/device/authorize", () => ({
      body: { device_code: "tbdv_x", user_code: "BCDF-GHJK", verification_uri: "x", verification_uri_complete: `${h.portal.origin}/d`, expires_in: 12, interval: 5 },
    }));
    h.portal.on("POST", "/device/token", () => apiError(400, "authorization_pending"));
    const r = await h.run(["login", "--json"]);
    assert.equal(r.code, 10);
    assert.equal(r.json.error.code, "expired_token");
    assert.ok(h.sleeps.length <= 3);
  });

  it("refuses the file store for the person item (exit 3), before any network call", async () => {
    startRoute();
    h.injectStore = false;
    h.env.TB_CREDENTIAL_STORE = "file";
    for (const argv of [["login"], ["whoami"], ["logout"]]) {
      const r = await h.run([...argv, "--json"]);
      assert.equal(r.code, 3, argv.join(" "));
      assert.match(r.json.error.message, /keychain/);
    }
    assert.equal(h.portal.requests.length, 0);
  });

  it("logout revokes server side, then deletes the item", async () => {
    await h.signIn();
    h.portal.on("POST", "/owner-sessions/logout", () => ({ body: { ok: true } }));
    const r = await h.run(["logout", "--json"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { loggedOut: true, revokedOnServer: true, deletedLocally: true });
    const call = h.portal.calls("POST", "/owner-sessions/logout")[0];
    assert.equal(call?.headers.authorization, "Bearer tbo_testtoken0123456789");
    assert.equal(await h.store.get("tealbrick.person"), null);
  });

  it("logout deletes locally even when the Portal is unreachable, and says so", async () => {
    await h.signIn();
    await h.portal.stop();
    const r = await h.run(["logout", "--json"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.revokedOnServer, false);
    assert.equal(r.json.deletedLocally, true);
    assert.match(r.err, /could not be reached/);
    assert.equal(await h.store.get("tealbrick.person"), null);
    await h.portal.start(); // so teardown can stop it again
  });

  it("logout without an item exits 3", async () => {
    const r = await h.run(["logout", "--json"]);
    assert.equal(r.code, 3);
    assert.equal(r.json.error.code, "unauthenticated");
  });
});
