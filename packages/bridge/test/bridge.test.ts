import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { after, before, describe, test } from "node:test";
import { startRelay } from "@opt2-tealbrick/relay";
import { AGT, AGT2, APP_CODE, BRG, CON, INS, makeWorld, SVC_CODE, type World, WS, waitFor } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);

async function session(w: World) {
  const token = await w.agentToken();
  assert.ok(token, "key connection gets an access token");
  const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } } });
  assert.equal(init.status, 200);
  assert.ok(init.session);
  return { token, sid: init.session as string, init: init.json };
}

async function call(w: World, s: { token: string; sid: string }, name: string, args: unknown = {}, meta?: Record<string, unknown>) {
  const r = await w.mcp(s.token, { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }, s.sid);
  assert.equal(r.status, 200);
  return r.json.result;
}

for (const real of [false, true]) {
describe(`deployed bridge (${real ? "real manifest crypto" : "test double"})`, () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real });
  });
  after(async () => {
    await w.close();
  });

  test("enrols, pulls the signed config and is ready", async () => {
    assert.equal(w.bridge.ctx.identity?.bridgeId, BRG);
    assert.equal(w.bridge.ctx.table?.rev, 1);
    const r = await fetch(`${w.publicUrl}/readyz`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: "ready" });
  });

  test("initialize carries the skill index; tools/list = exactly the granted agent ops", async () => {
    const s = await session(w);
    assert.match(s.init.result.instructions, /tealbrick:\/\/skills\/notes\/use-notes/);
    const list = await w.mcp(s.token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, s.sid);
    const names = list.json.result.tools.map((t: { name: string }) => t.name).sort();
    // read+create grant: no delete op, no person op
    assert.deepEqual(names, ["notes__notes_create", "notes__notes_list", "notes__notes_send", "notes__tb_hold_status", "notes__tb_skills"]);
    const send = list.json.result.tools.find((t: { name: string }) => t.name === "notes__notes_send");
    assert.equal(send.annotations.openWorldHint, true);
  });

  test("a call is forwarded with the grant and a call proof; the agent never sees the grant", async () => {
    const s = await session(w);
    const before = w.appLog.ops.length;
    const r = await call(w, s, "notes__notes_list", { q: "x" });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.op, "notes_list");
    const sent = w.appLog.ops[before];
    assert.ok(sent?.auth?.startsWith("Bearer "));
    assert.ok(sent?.proof);
    assert.deepEqual(sent?.body.input, { q: "x" });
    assert.deepEqual(sent?.body.context, {});
    const proof = JSON.parse(Buffer.from(String(sent?.proof).split(".")[1] as string, "base64url").toString());
    assert.equal(proof.op, "notes_list");
    assert.equal(proof.aud, `tb:ins:${INS}`);
    assert.equal(proof.sub, `tb:agt:${AGT}`);
  });

  test("held results come back as a handle, not an error", async () => {
    const s = await session(w);
    const r = await call(w, s, "notes__notes_send", {}, { "tealbrick/idempotencyKey": "idem-call-two" });
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.status, "held");
    assert.equal(r.structuredContent.checkWith, "notes__tb_hold_status");
    const st = await call(w, s, "notes__tb_hold_status", { holdId: "hold_1" });
    assert.equal(st.structuredContent.status, "pending");
  });

  test("ops outside the grant are not tools; a client key is forwarded as is, none → the bridge derives one (C98)", async () => {
    const s = await session(w);
    const del = await call(w, s, "notes__notes_delete", {});
    assert.equal(del.isError, true);
    assert.equal(del.structuredContent.error.code, "unknown_tool");
    const noKey = await call(w, s, "notes__notes_create", { title: "a" });
    assert.equal(noKey.isError, undefined, "C98: a model-style call without _meta is not refused");
    assert.match(String(w.appLog.ops.at(-1)?.body.idempotencyKey), /^drv_[0-9a-f]{64}$/, "derived key forwarded (manifest deriveIdempotencyKey)");
    const ok = await call(w, s, "notes__notes_create", { title: "a" }, { "tealbrick/idempotencyKey": "idem-call-one" });
    assert.equal(ok.isError, undefined);
    assert.equal(w.appLog.ops.at(-1)?.body.idempotencyKey, "idem-call-one");
  });

  test("skills: resources and the fallback tool render agent variables", async () => {
    const s = await session(w);
    const read = await w.mcp(s.token, { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "tealbrick://skills/notes/use-notes" } }, s.sid);
    assert.equal(read.json.result.contents[0].text, "Hello Agent One");
    const tool = await call(w, s, "notes__tb_skills", { skillId: "use-notes" });
    assert.equal(tool.structuredContent.text, "Hello Agent One");
  });

  test("no person or foreign credential is accepted at /mcp (R-P1)", async () => {
    const r = await w.mcp("tbo_ownersessiontokenvalue", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(r.status, 401);
    const portalSigned = await w.signPortal("tb-agent-session+jwt", { iss: `tb:brg:${BRG}`, sub: `tb:agt:${AGT}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 900, jti: w.api.ulid(), ws: WS, con: CON, gen: 1 });
    const r2 = await w.mcp(portalSigned, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(r2.status, 401);
    const wa = (await fetch(`${w.publicUrl}/mcp`, { method: "POST", body: "{}" })).headers.get("www-authenticate");
    assert.match(String(wa), /resource_metadata=/);
  });

  test("claim, key page and key fetch: only declared keys, values never in status", async () => {
    const api = w.api;
    const appKey = await api.generateKeyPair();
    // a companion service that starts before its app: retryable refusal, code NOT consumed
    const svcKey = await api.generateKeyPair();
    const svcClaim = () =>
      fetch(`${w.internalUrl}/tb/v1/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: SVC_CODE, instancePublicKey: svcKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.2", service: "engine" }),
      });
    const early = await svcClaim();
    assert.equal(early.status, 503);
    assert.equal(early.headers.get("retry-after"), "5");
    assert.equal((await early.json()).error.code, "app_not_claimed");
    const early2 = await svcClaim();
    assert.equal(early2.status, 503, "the service code was not consumed by the early attempt");
    const tooNew = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "2.0.0" }),
    });
    assert.equal(tooNew.status, 400, "SDK major 2 is not served (C44: 0.x and 1.x are major 1)");
    assert.equal((await tooNew.json()).error.code, "sdk_major_unsupported");
    // SDK 0.1.2 counts as major 1 and is accepted (C44); the refused claim did not use up the code
    const claim = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.2" }),
    });
    assert.equal(claim.status, 200);
    const cr = await claim.json();
    assert.equal(cr.ins, INS);
    assert.equal(cr.slice, undefined, "no slice until Core lists the key");
    // after the app claimed (pending at this bridge), the service claim completes with the app key
    const late = await svcClaim();
    assert.equal(late.status, 200);
    const lr = await late.json();
    assert.deepEqual(lr.app.publicKey, appKey.publicJwk);
    assert.ok(Array.isArray(lr.serviceKeys));
    assert.equal((await svcClaim()).status, 403, "a completed service claim consumes its code");
    const reuse = await fetch(`${w.internalUrl}/tb/v1/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "1.0.0" }) });
    assert.equal(reuse.status, 403);
    // key page via a keys ticket
    const ticket = await w.signPortal("tb-ticket+jwt", { iss: "tb:portal", sub: "tb:per:per_01HPPPPPPPPPPPPPPPPPPPPPPP", aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 120, jti: w.api.ulid(), ws: WS, pur: "keys" });
    // Browser rule: the ticket arrives by a CROSS-SITE form POST (Portal → bridge). A SameSite=Strict cookie set
    // on that response is NOT sent on a redirected follow-up GET of the same navigation. So the bridge must render
    // the form in the POST response itself; the cookie is only needed for the later same-site form posts.
    const open = await fetch(`${w.keysUrl}/keys`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket }), redirect: "manual" });
    assert.equal(open.status, 200, "no redirect: the follow-up GET would arrive without the Strict cookie");
    const setCookie = String(open.headers.get("set-cookie"));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\/keys/);
    const page = await open.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] as string;
    assert.ok(csrf, "the key form (with CSRF token) is in the ticket POST response");
    const cookie = setCookie.split(";")[0] as string;
    const cookieless = await fetch(`${w.keysUrl}/keys`);
    assert.equal(cookieless.status, 401, "a GET without the cookie (what the browser would send after a cross-site redirect) has no session");
    const set = await fetch(`${w.keysUrl}/keys`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, name: "NOTES_API_KEY", value: "sk-test-123" }), redirect: "manual" });
    assert.equal(set.status, 303);
    const replay = await fetch(`${w.keysUrl}/keys`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket }), redirect: "manual" });
    assert.equal(replay.status, 401, "keys ticket is one-time");
    // key fetch with an instance assertion (pending claim key)
    const assertFor = async (path: string) => api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: api.ulid() }, appKey, { method: "GET", pathAndQuery: path });
    const k = await fetch(`${w.internalUrl}/tb/v1/keys/NOTES_API_KEY`, { headers: { "TB-Assert": await assertFor("/tb/v1/keys/NOTES_API_KEY") } });
    assert.equal(k.status, 200);
    assert.equal((await k.json()).value, "sk-test-123");
    const undeclared = await fetch(`${w.internalUrl}/tb/v1/keys/OTHER`, { headers: { "TB-Assert": await assertFor("/tb/v1/keys/OTHER") } });
    assert.equal(undeclared.status, 403);
    // declared in the manifest but not active (absent from Core's resolved config keyRequirements) → refused
    const inactive = await fetch(`${w.internalUrl}/tb/v1/keys/NOTES_EXTRA_KEY`, { headers: { "TB-Assert": await assertFor("/tb/v1/keys/NOTES_EXTRA_KEY") } });
    assert.equal(inactive.status, 403);
    assert.equal((await inactive.json()).error.code, "key_not_declared");
    const noAssert = await fetch(`${w.internalUrl}/tb/v1/keys/NOTES_API_KEY`);
    assert.equal(noAssert.status, 401);
    // status report carries presence only
    await waitFor(() => w.acks.some((a) => a.keys.some((x) => x.name === "NOTES_API_KEY" && x.set)), 5000);
    assert.ok(!JSON.stringify(w.acks).includes("sk-test-123"));
    assert.ok(w.acks.some((a) => a.claims.some((c) => c.ins === INS)));
  });

  test("launch proxy strips Authorization and TB-* headers; public routes only when declared", async () => {
    const ticket = await w.signPortal("tb-ticket+jwt", { iss: "tb:portal", sub: "tb:per:per_01HPPPPPPPPPPPPPPPPPPPPPPP", aud: `tb:ins:${INS}`, iat: now(), exp: now() + 60, jti: w.api.ulid(), ws: WS, pur: "launch" });
    const r = await fetch(`${w.publicUrl}/a/notes/tb/launch`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Bearer leak", "tb-call": "leak" }, body: new URLSearchParams({ ticket }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.auth, null);
    assert.equal(j.tb, null);
    const bad = await fetch(`${w.publicUrl}/a/notes/tb/launch`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket: "x.y.z" }) });
    assert.equal(bad.status, 401);
    assert.equal((await fetch(`${w.publicUrl}/p/notes/oauth/callback?state=1`)).status, 200);
    assert.equal((await fetch(`${w.publicUrl}/p/notes/undeclared`)).status, 404);
  });

  test("agent pause in a new config empties tools and refuses calls within one pull", async () => {
    const s = await session(w);
    await w.publish((c) => {
      c.pause.agents = [AGT];
    });
    await waitFor(() => (w.bridge.ctx.table?.rev ?? 0) === w.rev(), 10000);
    const list = await w.mcp(s.token, { jsonrpc: "2.0", id: 9, method: "tools/list" }, s.sid);
    assert.deepEqual(list.json.result.tools, []);
    const refused = await call(w, s, "notes__notes_list", {});
    assert.equal(refused.structuredContent.error.code, "paused", "pause is reported as paused, not unknown_tool");
    await w.publish();
    await waitFor(() => (w.bridge.ctx.table?.rev ?? 0) === w.rev(), 10000);
  });

  test("connection revoke in config rejects the access token at once", async () => {
    const s = await session(w);
    await w.publish((c) => {
      c.connections = c.connections.map((x) => ({ ...x, status: "revoked" as const }));
    });
    await waitFor(() => (w.bridge.ctx.table?.rev ?? 0) === w.rev(), 10000);
    const r = await w.mcp(s.token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, s.sid);
    assert.equal(r.status, 401);
    await w.publish();
    await waitFor(() => (w.bridge.ctx.table?.rev ?? 0) === w.rev(), 10000);
  });

  test("bridge assertions to Portal are valid (no 401 at the fake Portal)", () => {
    assert.equal(w.rejectedBridgeAssertions(), 0);
  });

  test("OAuth connector (C4): DCR → authorize → pairing code (path B) → PKCE token → MCP → refresh rotation; reuse revokes", async () => {
    const reg = await (await fetch(`${w.publicUrl}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:33418/callback"], client_name: "Claude" }) })).json();
    assert.ok(reg.client_id.startsWith("tbc_"));
    const verifier = "v".repeat(50);
    const challenge = Buffer.from(w.api.sha256Bytes(Buffer.from(verifier)).slice(7), "hex").toString("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:44444/callback", code_challenge: challenge, code_challenge_method: "S256", state: "st1", resource: "http://127.0.0.1/mcp" });
    const page = await (await fetch(`${w.publicUrl}/oauth/authorize?${q}`)).text();
    assert.match(page, /unverified/);
    assert.match(page, /127\.0\.0\.1:44444/, "redirect host shown (loopback port may differ, RFC 8252)");
    const rid = /name="rid" value="([^"]+)"/.exec(page)?.[1] as string;
    const code = await w.signPortal("tb-pair+jwt", { iss: "tb:portal", sub: `tb:agt:${AGT}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 600, jti: w.api.ulid(), ws: WS });
    const redeem = await fetch(`${w.publicUrl}/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ rid, action: "paste", code }), redirect: "manual" });
    assert.equal(redeem.status, 302);
    const loc = new URL(String(redeem.headers.get("location")));
    assert.equal(loc.searchParams.get("state"), "st1");
    const authCode = loc.searchParams.get("code") as string;
    const reuseCode = await fetch(`${w.publicUrl}/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ rid, action: "paste", code }) });
    assert.equal(reuseCode.status, 400, "pairing code is one-time");
    const tok = async (params: Record<string, string>) => fetch(`${w.publicUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    const bad = await tok({ grant_type: "authorization_code", code: authCode, code_verifier: "w".repeat(50), client_id: reg.client_id, redirect_uri: "http://127.0.0.1:44444/callback" });
    assert.equal(bad.status, 400, "wrong PKCE verifier refused (and the code is spent)");
    // second pass with a fresh code
    const page2 = await (await fetch(`${w.publicUrl}/oauth/authorize?${q}`)).text();
    const rid2 = /name="rid" value="([^"]+)"/.exec(page2)?.[1] as string;
    const code2 = await w.signPortal("tb-pair+jwt", { iss: "tb:portal", sub: `tb:agt:${AGT}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 600, jti: w.api.ulid(), ws: WS });
    const r2 = await fetch(`${w.publicUrl}/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ rid: rid2, action: "paste", code: code2 }), redirect: "manual" });
    const authCode2 = new URL(String(r2.headers.get("location"))).searchParams.get("code") as string;
    const t1 = await (await tok({ grant_type: "authorization_code", code: authCode2, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:44444/callback", resource: "http://127.0.0.1/mcp" })).json();
    assert.ok(t1.access_token && t1.refresh_token.startsWith("tbr_"));
    const init = await w.mcp(t1.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(init.status, 200);
    const t2 = await (await tok({ grant_type: "refresh_token", refresh_token: t1.refresh_token })).json();
    assert.ok(t2.refresh_token && t2.refresh_token !== t1.refresh_token);
    const old = await (await w.mcp(t1.access_token, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} })).status;
    assert.equal(old, 401, "access tokens of the previous generation stop working");
    const graceRetry = await tok({ grant_type: "refresh_token", refresh_token: t1.refresh_token });
    assert.equal(graceRetry.status, 200, "previous token accepted once within 30 s");
    const reuse = await tok({ grant_type: "refresh_token", refresh_token: t1.refresh_token });
    assert.equal(reuse.status, 400, "second reuse of a rotated token is refused …");
    const afterRevoke = await tok({ grant_type: "refresh_token", refresh_token: t2.refresh_token });
    assert.equal(afterRevoke.status, 400, "… and revokes the whole connection");
    await waitFor(() => w.acks.some((a) => a.connectionsRevoked.some((c) => c.reason === "refresh_reuse")), 5000);
    assert.ok(w.acks.some((a) => a.connectionsCreated.length > 0), "new pairing connections are reported to Portal");
  });

  test("Portal key rotation: announced (pending) key verifies configs and grants after activation; retire drops the old key", async () => {
    const s = await session(w);
    await w.rotateKey("announce");
    await w.publish();
    await waitFor(() => (w.bridge.ctx.table?.rev ?? 0) === w.rev(), 10000);
    await w.rotateKey("activate");
    await w.publish();
    await waitFor(() => (w.bridge.ctx.table?.rev ?? 0) === w.rev(), 10000);
    assert.equal((await call(w, s, "notes__notes_list", {})).isError, undefined, "grants signed by the new key are forwarded");
    await w.rotateKey("retire");
    await w.publish();
    await waitFor(() => (w.bridge.ctx.table?.rev ?? 0) === w.rev(), 10000);
    assert.equal((await call(w, s, "notes__notes_list", {})).isError, undefined);
  });

  test("MCP without Mcp-Session-Id → 400; unknown session → 404", async () => {
    const token = await w.agentToken();
    const r = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(r.status, 400);
    const r2 = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "01HUNKNOWNSESSIONXXXXXXXXX");
    assert.equal(r2.status, 404);
  });

  test("Approve in Portal on an http public URL answers a clear configuration error (not 500)", async () => {
    const reg = await (await fetch(`${w.publicUrl}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:1/cb"], client_name: "x" }) })).json();
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:1/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "s", resource: "http://127.0.0.1/mcp" });
    const page = await (await fetch(`${w.publicUrl}/oauth/authorize?${q}`)).text();
    const rid = /name="rid" value="([^"]+)"/.exec(page)?.[1] as string;
    const r = await fetch(`${w.publicUrl}/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ rid, action: "portal" }) });
    assert.equal(r.status, 400);
    const text = await r.text();
    assert.match(text, /Bridge address needs a fix/, "the configuration problem is named (0.1.29 copy, C185)");
    assert.match(text, /TB_PUBLIC_URL/);
  });

  test("a refused config document is not re-pulled in a tight loop", async () => {
    const before = w.configPulls();
    await w.serveForged();
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(w.configPulls() - before <= 2, `pulls in 1.5 s: ${w.configPulls() - before}`);
    await w.publish();
    await waitFor(() => (w.bridge.ctx.table?.rev ?? 0) === w.rev(), 10000);
  });

  test("C59: /keys only on the keys origin; the keys origin serves nothing else", async () => {
    assert.equal((await fetch(`${w.publicUrl}/keys`)).status, 404, "main origin (shared with app UIs) never serves the key page");
    assert.equal((await fetch(`${w.keysUrl}/a/notes/`)).status, 404, "keys origin serves no app UI");
    assert.equal((await fetch(`${w.keysUrl}/mcp`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${w.keysUrl}/oauth/authorize`)).status, 404);
  });

  test("C59: a failing authorize request gets an error page, never a redirect (no open redirect)", async () => {
    const reg = await (await fetch(`${w.publicUrl}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://example.com/cb"], client_name: "x" }) })).json();
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://example.com/cb", code_challenge_method: "plain", state: "s", resource: "http://127.0.0.1/mcp" });
    const r = await fetch(`${w.publicUrl}/oauth/authorize?${q}`, { redirect: "manual" });
    assert.equal(r.status, 400);
    assert.equal(r.headers.get("location"), null);
    const unregistered = await fetch(`${w.publicUrl}/oauth/authorize?${new URLSearchParams({ client_id: reg.client_id, redirect_uri: "https://evil.example/cb" })}`, { redirect: "manual" });
    assert.equal(unregistered.status, 400);
    assert.equal(unregistered.headers.get("location"), null);
  });

  test("C59: rate-limit buckets are per client address (X-Forwarded-For from the edge), not shared", async () => {
    const reg = (ip: string) => fetch(`${w.publicUrl}/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.7, ${ip}` }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:1/cb"] }) });
    let last = 201;
    for (let i = 0; i < 31; i++) last = (await reg("203.0.113.10")).status;
    assert.equal(last, 429, "one client is limited");
    assert.equal((await reg("203.0.113.11")).status, 201, "another client is not affected");
  });

  test("C59: a forged assertion naming another agent's connection cannot spend that connection's token budget", async () => {
    for (let i = 0; i < 70; i++) {
      await fetch(`${w.publicUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${50 + (i % 5)}` }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `x.${Buffer.from(JSON.stringify({ con: CON })).toString("base64url")}.y` }) });
    }
    assert.ok(await w.agentToken(), "the real agent still gets a token");
  });

  test("Portal down: calls keep working on the last good config (C9)", async () => {
    const s = await session(w);
    w.portalDown();
    await new Promise((r) => setTimeout(r, 400));
    const r = await call(w, s, "notes__notes_list", {});
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.op, "notes_list");
  });

  test("relay (stdio) forwards JSON-RPC verbatim to the deployed bridge", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const statuses: string[] = [];
    const api = w.api;
    const relay = startRelay({
      api,
      bridgeUrl: w.publicUrl,
      connection: { con: CON as never, agt: AGT as never, bridgeId: BRG as never },
      signer: { sign: (i) => w.signRaw(i), publicJwk: () => w.agentKey.publicJwk },
      onStatus: (s) => statuses.push(s),
      stdin,
      stdout,
    });
    const lines: any[] = [];
    stdout.on("data", (d: Buffer) => {
      for (const l of d.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(l));
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "relay-test" } } })}\n`);
    await waitFor(() => lines.some((l) => l.id === 1));
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await waitFor(() => lines.some((l) => l.id === 2));
    const tools = lines.find((l) => l.id === 2).result.tools.map((t: { name: string }) => t.name);
    assert.ok(tools.includes("notes__notes_list"));
    assert.deepEqual(statuses, ["connected"]);
    relay.stop();
  });
});

describe(`hooks and offline rules (${real ? "real" : "double"})`, () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ withHook: true, real });
  });
  after(async () => {
    await w.close();
  });

  test("before hook allow → forwarded; deny → hook_denied; failure → hook_failed (fail closed)", async () => {
    const s = await session(w);
    w.hookMode.mode = "allow";
    const ok = await call(w, s, "notes__notes_list", {});
    assert.equal(ok.isError, undefined);
    assert.equal(w.appLog.hooks.at(-1)?.body.phase, "before");
    const forwarded = w.appLog.ops.length;
    w.hookMode.mode = "deny";
    const denied = await call(w, s, "notes__notes_list", {});
    assert.equal(denied.structuredContent.error.code, "hook_denied");
    w.hookMode.mode = "fail";
    const failed = await call(w, s, "notes__notes_list", {});
    assert.equal(failed.structuredContent.error.code, "hook_failed");
    assert.equal(w.appLog.ops.length, forwarded, "refused calls never reach the app");
  });

  test("a config older than 12 h fails closed for agent calls", async () => {
    const s = await session(w);
    w.hookMode.mode = "allow";
    const t = w.bridge.ctx.table;
    assert.ok(t);
    t.exp = now() - 1;
    const r = await call(w, s, "notes__notes_list", {});
    assert.equal(r.structuredContent.error.code, "config_expired");
    t.exp = now() + 3600;
  });

  test("the second agent has no grant, so no tools", async () => {
    // a key connection for AGT2 is not in config → token refused (connection_unknown)
    const assertion = await w.agentAssertion(AGT2, `con_${w.api.ulid()}`);
    const r = await fetch(`${w.publicUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error_description, "connection_unknown");
  });
});
}

describe("C57: an app restarting or updating during a config apply", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ manifestFailures: 1 });
  });
  after(async () => {
    await w.close();
  });

  test("first apply fails the manifest: UI 503 app_unavailable (+Retry-After, never 404), serves after the background retry", async () => {
    const first = await fetch(`${w.publicUrl}/a/notes/`);
    assert.equal(first.status, 503);
    assert.equal(first.headers.get("retry-after"), "5");
    assert.equal((await first.json()).error.code, "app_unavailable");
    await waitFor(() => w.bridge.ctx.table?.apps.get(INS as never)?.down === false, 10000);
    assert.equal((await fetch(`${w.publicUrl}/a/notes/`)).status, 200);
  });

  test("app update (new manifestDigest) while the app answers 503: tools say app_unavailable, then recover without a new config", async () => {
    const s = await session(w);
    const digest = w.updateApp(2);
    await w.publish();
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 10000);
    assert.equal(w.bridge.ctx.table?.apps.get(INS as never)?.entry.manifestDigest, digest);
    const during = await call(w, s, "notes__notes_list", {});
    if (during.isError) assert.equal(during.structuredContent.error.code, "app_unavailable", "never unknown_tool while the app restarts");
    const revBefore = w.rev();
    await waitFor(() => w.bridge.ctx.table?.apps.get(INS as never)?.down === false, 15000);
    assert.equal(w.rev(), revBefore, "recovered without a new config revision");
    const after = await call(w, s, "notes__notes_list", {});
    assert.equal(after.isError, undefined);
    assert.equal((await fetch(`${w.publicUrl}/a/notes/`)).status, 200);
  });
});

