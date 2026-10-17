/**
 * Bridge 0.2.1 (LA-1, C232): the private views route `GET /tb/v1/views/<product>/<rest>` of the REAL bridge (a fake Portal
 * and a fake app, as in every world). L34: each refusal fires on the bad request and stays quiet on the good one.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";
import { VIEWER_DOCUMENT_FORBIDDEN_SANDBOX, VIEWER_HEADER_FLOOR } from "@opt2-tealbrick/manifest";
import { buildStatusReport } from "../src/portal.ts";
import { VIEWS_MAX_BODY, VIEWS_ROUTE_MAX_IN_FLIGHT, VIEWS_TIMEOUT_MS } from "../src/views-shared.ts";
import { type Fake, fake, first, rawGet } from "./support/views.ts";
import { INS, makeWorld, notesManifest, type World, waitFor } from "./support/world.ts";

const KEY = randomBytes(32).toString("base64url");
const viewerManifest = { ...notesManifest, version: "1.1.0", publicRoutes: [...notesManifest.publicRoutes, { path: "/v", purpose: "viewer" }] };

/** the app now declares a viewer route */
async function publishViewerApp(w: World): Promise<void> {
  w.updateAppTo(viewerManifest);
  await w.publish();
  await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && !!w.bridge.ctx.table?.apps.get(INS as never)?.manifest?.publicRoutes?.some((r) => r.purpose === "viewer"), 15000);
}

const route = (w: World, path: string) => `${w.internalUrl}/tb/v1/views${path}`;
const withKey = (extra: Record<string, string> = {}) => ({ "TB-Views-Key": KEY, ...extra });
const answer = (w: World, status: number, headers: Record<string, string | string[]> = {}, body = "page") => {
  w.viewer.handler = (_req, res) => void res.writeHead(status, headers).end(body);
};

describe("bridge private views route", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true, env: { TB_VIEWS_KEY: KEY } });
  });
  after(async () => {
    await w.close();
  });

  test("an app WITHOUT a viewer route is not served (404), with the right key; one WITH it is (200)", async () => {
    answer(w, 200);
    const none = await rawGet(route(w, "/notes/tok"), withKey());
    assert.equal(none.status, 404);
    assert.equal(w.viewer.seen.length, 0, "the app was not called");
    await publishViewerApp(w);
    const r = await rawGet(route(w, "/notes/tok"), withKey());
    assert.equal(r.status, 200);
    assert.equal(r.text, "page");
  });

  test("the key: missing, wrong, near-miss → 404 exactly like an unknown path, and the app is never called; the right key passes", async () => {
    answer(w, 200);
    const calls = w.viewer.seen.length;
    const unknown = await rawGet(`${w.internalUrl}/tb/v1/nothing`);
    for (const headers of [{} as Record<string, string>, { "TB-Views-Key": "wrong" }, { "TB-Views-Key": KEY.slice(0, -1) }, { "TB-Views-Key": `${KEY}x` }, { "TB-Views-Key": KEY.toUpperCase() }, { "TB-Views-Key": "" }]) {
      const r = await rawGet(route(w, "/notes/tok"), headers);
      assert.equal(r.status, 404, JSON.stringify(headers));
      assert.equal(JSON.parse(r.text).error.code, JSON.parse(unknown.text).error.code, "same answer as an unknown path: no oracle");
      assert.equal(JSON.parse(r.text).error.message, JSON.parse(unknown.text).error.message);
      assert.equal(r.headers["www-authenticate"], undefined, "never 401");
    }
    assert.equal((await rawGet(route(w, "/_ready"))).status, 404, "_ready needs the key too");
    assert.equal(w.viewer.seen.length, calls);
    assert.equal((await rawGet(route(w, "/notes/tok"), withKey())).status, 200);
  });

  test("_ready: 200 with the key while the bridge has its config", async () => {
    const r = await rawGet(route(w, "/_ready"), withKey());
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { status: "ready" });
  });

  test("a request that carries Cookie, Authorization or any TB-* but the key is refused (400), never forwarded", async () => {
    answer(w, 200);
    const calls = w.viewer.seen.length;
    for (const extra of [{ Cookie: "sid=1" }, { Authorization: "Bearer x" }, { "TB-Assert": "x" }, { "TB-Grant": "x" }, { "TB-CSRF": "x" }] as Record<string, string>[]) {
      const r = await rawGet(route(w, "/notes/tok"), withKey(extra));
      assert.equal(r.status, 400, Object.keys(extra)[0]);
      assert.equal(JSON.parse(r.text).error.code, "viewer_request_refused");
    }
    assert.equal(w.viewer.seen.length, calls);
    assert.equal((await rawGet(route(w, "/notes/tok"), withKey({ Accept: "text/html" }))).status, 200, "the allow-list headers are fine");
  });

  test("only GET; the path must be /tb/v1/views/<product>/<rest> of an existing product", async () => {
    answer(w, 200);
    const calls = w.viewer.seen.length;
    assert.equal((await rawGet(route(w, "/notes/tok"), withKey(), "POST")).status, 405);
    assert.equal((await rawGet(route(w, "/notes/tok"), withKey(), "HEAD")).status, 405);
    for (const p of ["", "/", "/notes", "/Notes/x", "/n/x", "/nope/tok", "/../mcp", "/notes/../../call", "/%2e%2e/call"]) {
      const r = await rawGet(route(w, p), withKey());
      assert.equal(r.status, 404, p);
    }
    assert.equal(w.viewer.seen.length, calls);
  });

  test("forwards GET /v/<product>/<rest>?query to the app with the allow-listed headers only", async () => {
    answer(w, 200);
    await rawGet(route(w, "/notes/tok/data?a=1"), withKey({ Accept: "text/html", "Sec-Fetch-Dest": "iframe", "If-None-Match": '"x"', "X-Forwarded-For": "1.2.3.4", "User-Agent": "ua", Origin: "https://o.invalid" }));
    const seen = w.viewer.seen.at(-1);
    assert.equal(seen?.url, "/v/notes/tok/data?a=1");
    assert.equal(seen?.headers.accept, "text/html");
    assert.equal(seen?.headers["sec-fetch-dest"], "iframe");
    assert.equal(seen?.headers["if-none-match"], '"x"');
    for (const n of ["tb-views-key", "x-forwarded-for", "user-agent", "origin", "authorization", "cookie", "tb-assert"]) assert.equal(seen?.headers[n], undefined, n);
    await rawGet(route(w, "/notes/tok"), withKey());
    const bare = w.viewer.seen.at(-1);
    for (const n of ["sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "if-none-match"]) assert.equal(bare?.headers[n], undefined, `${n} stays absent`);
  });

  test("304 round trip with ETag, no body", async () => {
    w.viewer.handler = (req, res) => {
      if (req.headers["if-none-match"] === '"e1"') return void res.writeHead(304, { etag: '"e1"' }).end();
      res.writeHead(200, { etag: '"e1"' }).end("body");
    };
    const a = await rawGet(route(w, "/notes/tok"), withKey());
    assert.equal(first(a, "etag"), '"e1"');
    const b = await rawGet(route(w, "/notes/tok"), withKey({ "If-None-Match": '"e1"' }));
    assert.equal(b.status, 304);
    assert.equal(b.body.length, 0);
    assert.equal(first(b, "etag"), '"e1"');
  });

  test("floor present with an app that sends none; app Set-Cookie / ACAO / X-Frame-Options dropped; app CSP kept; floor not replaceable", async () => {
    answer(w, 200, { "content-type": "text/plain" });
    const bare = await rawGet(route(w, "/notes/tok"), withKey());
    for (const [k, v] of Object.entries(VIEWER_HEADER_FLOOR)) assert.equal(first(bare, k), v, k);
    answer(w, 200, { "set-cookie": "a=1", "access-control-allow-origin": "*", "x-frame-options": "DENY", "cache-control": "public", "content-security-policy": "default-src 'self'", "x-app": "1" });
    const r = await rawGet(route(w, "/notes/tok"), withKey());
    assert.equal(r.headers["set-cookie"], undefined);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    assert.equal(r.headers["x-frame-options"], undefined);
    assert.equal(first(r, "cache-control"), "no-store");
    assert.equal(first(r, "content-security-policy"), "default-src 'self'");
    assert.equal(first(r, "x-app"), "1");
  });

  test("the _d gate again at the bridge (defence in depth): unsafe → 502, safe → 200, two headers judged together, off _d → untouched", async () => {
    const get = (policies: string[] | undefined, path = "/notes/_d/ticket") => {
      w.viewer.handler = (_req, res) => {
        if (policies) res.setHeader("content-security-policy", policies);
        res.writeHead(200).end("<p>doc</p>");
      };
      return rawGet(route(w, path), withKey());
    };
    assert.equal((await get(["sandbox allow-scripts"])).status, 200);
    const bad = await get(["sandbox allow-scripts allow-same-origin"]);
    assert.equal(bad.status, 502);
    assert.equal(JSON.parse(bad.text).error.code, "viewer_document_unsafe");
    assert.ok(!bad.text.includes("ticket") && !bad.text.includes("<p>doc</p>"));
    for (const token of VIEWER_DOCUMENT_FORBIDDEN_SANDBOX) assert.equal((await get([`sandbox ${token}`])).status, 502, token);
    assert.equal((await get(undefined)).status, 502, "missing CSP");
    assert.equal((await get(["sandbox allow-scripts", "sandbox allow-popups"])).status, 502, "one weak header among two");
    assert.equal((await get(["sandbox allow-same-origin"], "/notes/tok")).status, 200, "not a _d path");
    assert.equal((await get(["sandbox allow-same-origin"], "/notes/%5Fd/x")).status, 502, "_d written %5Fd");
  });

  test("main origin and keys origin answer 404 for /v/*, and the private route does not exist on the public listener", async () => {
    answer(w, 200);
    const calls = w.viewer.seen.length;
    for (const p of ["/v/notes/tok", "/v/notes/", "/v/notes/_d/x"]) {
      assert.equal((await rawGet(`${w.publicUrl}${p}`)).status, 404, `main ${p}`);
      assert.equal((await rawGet(`${w.publicUrl}${p}`, { Host: new URL(w.keysUrl).host })).status, 404, `keys ${p}`);
    }
    assert.equal((await rawGet(`${w.publicUrl}/tb/v1/views/notes/tok`, withKey())).status, 404, "not on the public listener, key or not");
    assert.equal((await rawGet(`${w.publicUrl}/p/notes/v/tok`)).status, 404);
    assert.equal(w.viewer.seen.length, calls, "the app saw none of it");
  });

  test("pause: workspace pause and that instance's pause → 503 paused (app not called); not paused → 200", async () => {
    answer(w, 200);
    const calls = w.viewer.seen.length;
    await w.publish((c) => {
      c.pause.workspace = true;
    });
    await waitFor(() => w.bridge.ctx.table?.pausedWorkspace === true, 15000);
    const ws = await rawGet(route(w, "/notes/tok"), withKey());
    assert.equal(ws.status, 503);
    assert.equal(JSON.parse(ws.text).error.code, "paused");
    assert.equal(first(ws, "x-content-type-options"), "nosniff");
    await w.publish((c) => {
      c.pause.instances = [INS as never];
    });
    await waitFor(() => w.bridge.ctx.table?.pausedInstances.has(INS as never) === true, 15000);
    const ins = await rawGet(route(w, "/notes/tok"), withKey());
    assert.equal(ins.status, 503);
    assert.equal(JSON.parse(ins.text).error.code, "paused");
    assert.equal(w.viewer.seen.length, calls);
    await w.publish();
    await waitFor(() => w.bridge.ctx.table?.pausedWorkspace === false && !w.bridge.ctx.table?.pausedInstances.has(INS as never), 15000);
    assert.equal((await rawGet(route(w, "/notes/tok"), withKey())).status, 200, "quiet once the pause is lifted");
  });

  test("an app that is down is 'try again', not 'not found'", async () => {
    const t = w.bridge.ctx.table;
    const app = t?.apps.get(INS as never);
    assert.ok(app);
    app.down = true;
    try {
      const r = await rawGet(route(w, "/notes/tok"), withKey());
      assert.equal(r.status, 503);
      assert.ok(Number(first(r, "retry-after")) > 0);
    } finally {
      app.down = false;
    }
  });

  test("an app that is unreachable → 503 viewer address not ready... no: app_unavailable-style 503, without its address", async () => {
    const app = w.bridge.ctx.table?.apps.get(INS as never);
    assert.ok(app);
    const real = app.entry.internalUrl;
    // a closed port on loopback: the bridge cannot connect
    (app.entry as { internalUrl: string }).internalUrl = "http://127.0.0.1:9";
    try {
      const r = await rawGet(route(w, "/notes/tok"), withKey());
      assert.equal(r.status, 503);
      assert.ok(!r.text.includes("127.0.0.1"));
    } finally {
      (app.entry as { internalUrl: string }).internalUrl = real;
    }
  });

  test("defaults: 32 in flight, 2 MiB, 10 s; the key is not in the status report or the metrics", async () => {
    assert.equal(VIEWS_ROUTE_MAX_IN_FLIGHT, 32);
    assert.equal(VIEWS_MAX_BODY, 2 * 1024 * 1024);
    assert.equal(VIEWS_TIMEOUT_MS, 10_000);
    assert.ok(!JSON.stringify(buildStatusReport(w.bridge.ctx)).includes(KEY));
    const m = await rawGet(`${w.internalUrl}/metrics`);
    assert.ok(!m.text.includes(KEY));
  });
});

describe("bridge private views route: no TB_VIEWS_KEY configured", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
    await publishViewerApp(w);
  });
  after(async () => {
    await w.close();
  });
  test("every views request is 404, whatever key it carries (unset is never a way in)", async () => {
    answer(w, 200);
    for (const headers of [{} as Record<string, string>, { "TB-Views-Key": "" }, { "TB-Views-Key": "undefined" }, { "TB-Views-Key": KEY }]) assert.equal((await rawGet(route(w, "/notes/tok"), headers)).status, 404);
    assert.equal(w.viewer.seen.length, 0);
  });
  test("a key that is too short is not a key (404 for it too)", async () => {
    const short = await makeWorld({ real: true, env: { TB_VIEWS_KEY: "short" } });
    try {
      assert.equal((await rawGet(route(short, "/_ready"), { "TB-Views-Key": "short" })).status, 404);
    } finally {
      await short.close();
    }
  });
});

describe("bridge private views route: its own limits", () => {
  let w: World;
  let held: ((res?: ServerResponse) => void)[] = [];
  before(async () => {
    w = await makeWorld({ real: true, env: { TB_VIEWS_KEY: KEY }, limits: { views: { inFlight: 2, maxBytes: 1000, timeoutMs: 400 } } });
    await publishViewerApp(w);
  });
  after(async () => {
    for (const f of held.splice(0)) f();
    await w.close();
  });

  test("past its in-flight cap the route answers 503 + Retry-After, and /mcp is never starved; quiet once they finish", async () => {
    held = [];
    w.viewer.handler = (_req: IncomingMessage, res: ServerResponse) => {
      held.push(() => void res.writeHead(200).end("late"));
    };
    const a = rawGet(route(w, "/notes/a"), withKey());
    const b = rawGet(route(w, "/notes/b"), withKey());
    await waitFor(() => held.length === 2, 5000);
    const busy = await rawGet(route(w, "/notes/c"), withKey());
    assert.equal(busy.status, 503);
    assert.ok(Number(first(busy, "retry-after")) > 0);
    // /mcp on the public listener still works while the views route is saturated
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } } });
    assert.equal(init.status, 200);
    for (const f of held.splice(0)) f();
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
    answer(w, 200);
    assert.equal((await rawGet(route(w, "/notes/d"), withKey())).status, 200);
  });

  test("a body over the cap → 502 (declared and streamed); at the cap → 200", async () => {
    w.viewer.handler = (_req, res) => void res.writeHead(200, { "content-length": "1000" }).end(Buffer.alloc(1000, 97));
    assert.equal((await rawGet(route(w, "/notes/x"), withKey())).status, 200);
    w.viewer.handler = (_req, res) => void res.writeHead(200, { "content-length": "1001" }).end(Buffer.alloc(1001, 97));
    assert.equal((await rawGet(route(w, "/notes/x"), withKey())).status, 502);
    w.viewer.handler = (_req, res) => void res.writeHead(200).end(Buffer.alloc(1001, 97));
    const chunked = await rawGet(route(w, "/notes/x"), withKey());
    assert.equal(chunked.status, 502);
    assert.equal(JSON.parse(chunked.text).error.code, "viewer_response_too_large");
  });

  test("an app that does not answer in time → 504; one that answers in time → 200", async () => {
    w.viewer.handler = (_req, res) => void setTimeout(() => res.writeHead(200).end("late"), 900);
    assert.equal((await rawGet(route(w, "/notes/x"), withKey())).status, 504);
    answer(w, 200);
    assert.equal((await rawGet(route(w, "/notes/x"), withKey())).status, 200);
  });
});

describe("StatusReport.views (BRIDGE §5.6, spec 0.1.43)", () => {
  let viewsSvc: Fake;
  let viewsStatus = 200;
  let w: World;
  before(async () => {
    viewsSvc = await fake((req, res) => {
      if (req.url === "/readyz") return void res.writeHead(viewsStatus).end("{}");
      res.writeHead(404).end();
    });
    w = await makeWorld({ real: true, env: { TB_VIEWS_PUBLIC_URL: viewsSvc.url, TB_VIEWS_KEY: KEY } });
  });
  after(async () => {
    await w.close();
    await viewsSvc.close();
  });
  const last = () => w.acks.at(-1)?.views;

  test("a ready views service is reported ok with the check time and its origin", async () => {
    await waitFor(() => w.acks.some((a) => a.views?.ok === true), 15000);
    const v = last();
    assert.equal(v?.url, viewsSvc.url);
    assert.equal(v?.ok, true);
    assert.ok(Math.abs(Date.parse(v?.lastCheckAt ?? "") - Date.now()) < 20_000);
    assert.ok(viewsSvc.seen.every((s) => s.method === "GET" && s.url === "/readyz"), "the probe is GET /readyz only");
    assert.ok(!JSON.stringify(w.acks).includes(KEY), "the key is never reported");
  });

  test("a views service that stops being ready is reported not ok at once (poked by health), and recovers", async () => {
    viewsStatus = 503;
    w.bridge.ctx.emit("health");
    await waitFor(() => last()?.ok === false, 15000);
    viewsStatus = 200;
    w.bridge.ctx.emit("health");
    await waitFor(() => last()?.ok === true, 15000);
  });

  test("a views service that does not answer within 3 s is not ok", async () => {
    const hang = await fake(() => undefined);
    const w2 = await makeWorld({ real: true, env: { TB_VIEWS_PUBLIC_URL: hang.url } });
    try {
      await waitFor(() => w2.acks.some((a) => a.views !== undefined), 20000);
      const v = w2.acks.at(-1)?.views;
      assert.equal(v?.ok, false);
      assert.equal(v?.url, hang.url);
    } finally {
      await w2.close();
      await hang.close();
    }
  });

  test("without TB_VIEWS_PUBLIC_URL the report has no views member at all", async () => {
    const w3 = await makeWorld({ real: true });
    try {
      await waitFor(() => w3.acks.length > 0, 15000);
      assert.ok(w3.acks.every((a) => !("views" in a)));
      assert.ok(!("views" in buildStatusReport(w3.bridge.ctx)));
    } finally {
      await w3.close();
    }
  });
});
