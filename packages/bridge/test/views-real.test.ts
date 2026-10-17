/**
 * Bridge 0.2.1 (LA-1, C232) REAL to REAL (L2): the real views role (tb-views) → the real bridge private views route → a
 * real miniapp-sdk 0.1.26 app serving its `viewer` public route. Only Portal is faked (the world). Nothing between the
 * viewer and the app is a double: each hop's rule is the shared manifest helper, and the SDK applies them a third time.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { VIEWER_HEADER_FLOOR } from "@opt2-tealbrick/manifest";
import { silentLogger } from "../src/util.ts";
import { startViews } from "../src/views-edge.ts";
import { freePort, type RealSdkApp, startRealSdkApp } from "./support/sdk-app.ts";
import { first, rawGet } from "./support/views.ts";
import { makeWorld, type World, waitFor } from "./support/world.ts";

const KEY = randomBytes(32).toString("base64url");
const SDKINS = "ins_01HVWAPPVWAPPVWAPPVWAPPVWA";
const PRODUCT = "pages";

describe("views, real to real: viewer → real tb-views → real bridge → real SDK app", () => {
  let w: World;
  let sdk: RealSdkApp;
  let edge: Awaited<ReturnType<typeof startViews>>;
  let base: string;
  let appCalls = 0;
  before(async () => {
    const port = await freePort();
    w = await makeWorld({ real: true, env: { TB_VIEWS_KEY: KEY }, extraOwnInfraOrigins: [`http://127.0.0.1:${port}`] });
    sdk = await startRealSdkApp(w, {
      ins: SDKINS,
      product: PRODUCT,
      code: "tbe_viewappinstancecode01",
      port,
      operations: [
        { id: "pages_list", title: "List pages", description: "List pages", input: { type: "object" }, output: { type: "object" }, crud: ["read"], effect: "read", idempotency: "none", receipt: false, audience: "agent" },
      ],
      handlers: { pages_list: async () => ({ pages: [] }) },
      publicRoutes: [{ path: "/v", purpose: "viewer" }],
      publicHandlers: {
        "/v": async (request: Request) => {
          appCalls += 1;
          const url = new URL(request.url);
          const seen = Object.fromEntries(request.headers.entries());
          const dirty = { "set-cookie": "sid=1; Path=/", "access-control-allow-origin": "*", "x-frame-options": "DENY", "x-app": "pages" };
          if (url.pathname === "/tok1") {
            if (request.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
            return new Response("<p>hello</p>", { status: 200, headers: { "content-type": "text/html; charset=utf-8", etag: '"v1"', "content-security-policy": "default-src 'none'; frame-ancestors https://v.invalid", ...dirty } });
          }
          if (url.pathname === "/tok1/data") return Response.json({ path: url.pathname, query: url.search, seen });
          if (url.pathname === "/_d/safe") return new Response("<p>doc</p>", { headers: { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts" } });
          if (url.pathname === "/_d/weak") return new Response("<p>doc</p>", { headers: { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts allow-same-origin" } });
          if (url.pathname === "/_s/a.js") return new Response("x", { headers: { "content-type": "text/javascript" } });
          if (url.pathname === "/big") return new Response(Buffer.alloc(2 * 1024 * 1024 + 1, 97));
          return new Response("not found", { status: 404 });
        },
      },
    });
    edge = await startViews({ env: { TB_VIEWS_UPSTREAM: w.internalUrl, TB_VIEWS_KEY: KEY }, logger: silentLogger, port: 0 });
    base = `http://127.0.0.1:${edge.port}`;
  });
  after(async () => {
    await edge?.stop();
    await sdk?.stop();
    await w?.close();
  });

  test("the page arrives; the floor is set; Set-Cookie, ACAO and X-Frame-Options never reach the viewer; the app's CSP is kept", async () => {
    const r = await rawGet(`${base}/v/${PRODUCT}/tok1`, { "Sec-Fetch-Dest": "iframe", Accept: "text/html" });
    assert.equal(r.status, 200);
    assert.equal(r.text, "<p>hello</p>");
    assert.equal(first(r, "content-type"), "text/html; charset=utf-8");
    for (const [k, v] of Object.entries(VIEWER_HEADER_FLOOR)) if (k !== "content-security-policy") assert.equal(first(r, k), v, k);
    assert.equal(first(r, "content-security-policy"), "default-src 'none'; frame-ancestors https://v.invalid");
    for (const n of ["set-cookie", "access-control-allow-origin", "x-frame-options"]) assert.equal(r.headers[n], undefined, n);
    assert.equal(first(r, "x-app"), "pages", "an ordinary app header passes");
  });

  test("Sec-Fetch-Dest: iframe reaches the app unchanged; a request without it reaches the app without it; Cookie, Authorization, TB-* never", async () => {
    const withDest = JSON.parse((await rawGet(`${base}/v/${PRODUCT}/tok1/data?q=1`, { "Sec-Fetch-Dest": "iframe", Cookie: "sid=9", Authorization: "Bearer z", "TB-Assert": "a", "X-Forwarded-For": "9.9.9.9" })).text) as { path: string; query: string; seen: Record<string, string> };
    assert.equal(withDest.path, "/tok1/data");
    assert.equal(withDest.query, "?q=1");
    assert.equal(withDest.seen["sec-fetch-dest"], "iframe");
    for (const n of ["cookie", "authorization", "tb-assert", "tb-views-key", "x-forwarded-for"]) assert.equal(withDest.seen[n], undefined, n);
    const without = JSON.parse((await rawGet(`${base}/v/${PRODUCT}/tok1/data`, { Accept: "application/json" })).text) as { seen: Record<string, string> };
    assert.equal(without.seen["sec-fetch-dest"], undefined, "absent stays absent through all three hops");
    assert.equal(without.seen.accept, "application/json");
  });

  test("If-None-Match round trip through all three hops gives 304 with no body, ETag kept", async () => {
    const calls = appCalls;
    const r = await rawGet(`${base}/v/${PRODUCT}/tok1`, { "If-None-Match": '"v1"' });
    assert.equal(r.status, 304);
    assert.equal(r.body.length, 0);
    assert.equal(first(r, "etag"), '"v1"');
    assert.equal(first(r, "x-content-type-options"), "nosniff");
    assert.equal(appCalls, calls + 1, "the app answered it");
  });

  test("_d: a safe sandbox is delivered; allow-same-origin is refused 502 viewer_document_unsafe (without the path)", async () => {
    const ok = await rawGet(`${base}/v/${PRODUCT}/_d/safe`, { "Sec-Fetch-Dest": "iframe" });
    assert.equal(ok.status, 200);
    assert.equal(first(ok, "content-security-policy"), "sandbox allow-scripts");
    const bad = await rawGet(`${base}/v/${PRODUCT}/_d/weak`, { "Sec-Fetch-Dest": "iframe" });
    assert.equal(bad.status, 502);
    assert.equal((JSON.parse(bad.text) as { error: { code: string } }).error.code, "viewer_document_unsafe");
    assert.ok(!bad.text.includes("/_d/") && !bad.text.includes("weak"));
    assert.equal((await rawGet(`${base}/v/${PRODUCT}/_s/a.js`)).status, 200, "an asset path is not a document");
  });

  test("a response over 2 MiB is 502; an unknown page is the app's 404 with the floor", async () => {
    const big = await rawGet(`${base}/v/${PRODUCT}/big`);
    assert.equal(big.status, 502);
    const nf = await rawGet(`${base}/v/${PRODUCT}/nothing-here`);
    assert.equal(nf.status, 404);
    assert.equal(first(nf, "x-content-type-options"), "nosniff");
  });

  test("a wrong views key at tb-views gets 404 from the bridge; the main origin has no /v at all; an app without a viewer route is 404", async () => {
    const calls = appCalls;
    const wrong = await startViews({ env: { TB_VIEWS_UPSTREAM: w.internalUrl, TB_VIEWS_KEY: randomBytes(32).toString("base64url") }, logger: silentLogger, port: 0 });
    try {
      assert.equal((await rawGet(`http://127.0.0.1:${wrong.port}/v/${PRODUCT}/tok1`)).status, 404);
      assert.equal((await rawGet(`http://127.0.0.1:${wrong.port}/readyz`)).status, 503, "and it is not ready");
    } finally {
      await wrong.stop();
    }
    assert.equal((await rawGet(`${w.publicUrl}/v/${PRODUCT}/tok1`)).status, 404);
    assert.equal((await rawGet(`${base}/v/notes/tok`)).status, 404, "the fake notes app declares no viewer route");
    assert.equal(appCalls, calls, "the app saw none of these");
    assert.equal((await rawGet(`${base}/readyz`)).status, 200);
  });

  test("a paused workspace → 503 paused, the app is not called; resumed → 200 again", async () => {
    await w.publish((c) => {
      c.pause.workspace = true;
    });
    await waitFor(() => w.bridge.ctx.table?.pausedWorkspace === true, 15000);
    const calls = appCalls;
    const r = await rawGet(`${base}/v/${PRODUCT}/tok1`);
    assert.equal(r.status, 503);
    assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "paused");
    assert.equal(appCalls, calls);
    await w.publish();
    await waitFor(() => w.bridge.ctx.table?.pausedWorkspace === false, 15000);
    assert.equal((await rawGet(`${base}/v/${PRODUCT}/tok1`)).status, 200);
  });
});
