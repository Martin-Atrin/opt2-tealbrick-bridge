/**
 * Bridge 0.2.1 (LA-1, C232): the views role `TB_ROLE=views` (tb-views). L34: every alarm is proven both ways — it fires on
 * the bad input and stays quiet on the good one. The upstream is a fake bridge private listener; the real bridge and a
 * real SDK app are in views-real.test.ts.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { VIEWER_DOCUMENT_FORBIDDEN_SANDBOX, VIEWER_HEADER_FLOOR } from "@opt2-tealbrick/manifest";
import { silentLogger } from "../src/util.ts";
import { BRIDGE_ONLY_ENV, startViews, ViewsRoleError, viewsRoleEnv } from "../src/views-edge.ts";
import { VIEWS_EDGE_MAX_IN_FLIGHT, VIEWS_MAX_BODY, VIEWS_PER_CLIENT_PER_MIN, VIEWS_TIMEOUT_MS } from "../src/views-shared.ts";
import { type Fake, fake, first, rawGet } from "./support/views.ts";

const KEY = randomBytes(32).toString("base64url");
const good = (upstream: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ TB_VIEWS_UPSTREAM: upstream, TB_VIEWS_KEY: KEY, PORT: "8080", ...extra });

describe("views role: it refuses to be a second bridge", () => {
  for (const name of ["TB_ENROL_CODE", "TB_KEK", "TB_PORTAL_URL"]) {
    test(`${name} set → refuses to start, names the variable, never a value`, async () => {
      const secret = "tbe_supersecretvalue1234567890";
      assert.throws(() => viewsRoleEnv(good("http://10.0.0.1:8788", { [name]: secret })), (e: Error) => e instanceof ViewsRoleError && e.message.includes(name) && !e.message.includes(secret) && !e.message.includes(KEY));
      await assert.rejects(startViews({ env: good("http://10.0.0.1:8788", { [name]: secret }), logger: silentLogger, port: 0 }), ViewsRoleError);
    });
  }
  test("the refused names are exactly the bridge-only env (and an empty value is not 'set')", () => {
    for (const n of ["TB_ENROL_CODE", "TB_KEK", "TB_PORTAL_URL"]) assert.ok((BRIDGE_ONLY_ENV as readonly string[]).includes(n));
    assert.doesNotThrow(() => viewsRoleEnv(good("http://10.0.0.1:8788", { TB_KEK: "", TB_ENROL_CODE: "  " })));
  });
  test("TB_VIEWS_UPSTREAM or TB_VIEWS_KEY missing, a short key, a bad upstream → refuses", () => {
    assert.throws(() => viewsRoleEnv({ TB_VIEWS_KEY: KEY }), /TB_VIEWS_UPSTREAM/);
    assert.throws(() => viewsRoleEnv({ TB_VIEWS_UPSTREAM: "http://10.0.0.1:8788" }), /TB_VIEWS_KEY/);
    assert.throws(() => viewsRoleEnv(good("http://10.0.0.1:8788", { TB_VIEWS_KEY: "short" })), (e: Error) => /too short/.test(e.message) && !e.message.includes("short\n"));
    for (const bad of ["ftp://x", "not a url", "http://u:p@10.0.0.1:8788", "http://10.0.0.1:8788/base", "http://10.0.0.1:8788/?q=1"]) assert.throws(() => viewsRoleEnv(good(bad)), ViewsRoleError, bad);
    assert.throws(() => viewsRoleEnv(good("http://10.0.0.1:8788", { PORT: "x" })), /PORT/);
  });
  test("a good env is accepted (quiet)", () => {
    const e = viewsRoleEnv(good("http://bridge.railway.internal:8788"));
    assert.equal(e.upstream.origin, "http://bridge.railway.internal:8788");
    assert.equal(e.port, 8080);
  });
});

describe("views role: serves /v/* and health only, forwards with the key and the allow-list", () => {
  let up: Fake;
  let upstreamAnswer: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;
  let edge: Awaited<ReturnType<typeof startViews>>;
  let base: string;
  const logs: string[] = [];
  before(async () => {
    up = await fake((req, res) => upstreamAnswer(req, res));
    edge = await startViews({
      env: good(up.url),
      logger: { info: (e, f) => logs.push(JSON.stringify({ e, f })), warn: (e, f) => logs.push(JSON.stringify({ e, f })), error: (e, f) => logs.push(JSON.stringify({ e, f })) },
      port: 0,
    });
    base = `http://127.0.0.1:${edge.port}`;
  });
  after(async () => {
    await edge.stop();
    await up.close();
  });
  const answer = (status: number, headers: Record<string, string | string[]> = {}, body = "ok") => {
    upstreamAnswer = (_req, res) => {
      res.writeHead(status, headers);
      res.end(body);
    };
  };
  const received = () => up.seen.at(-1);

  test("GET /v/<product>/<rest>?q → GET <upstream>/tb/v1/views/<product>/<rest>?q with TB-Views-Key", async () => {
    answer(200, { "content-type": "text/html" }, "<p>hi</p>");
    const r = await rawGet(`${base}/v/notes/tok123/data?x=1&y=2`);
    assert.equal(r.status, 200);
    assert.equal(r.text, "<p>hi</p>");
    assert.equal(received()?.url, "/tb/v1/views/notes/tok123/data?x=1&y=2");
    assert.equal(received()?.method, "GET");
    assert.equal(received()?.headers["tb-views-key"], KEY);
  });

  test("only /v/*, /healthz and /readyz exist: everything else is 404 and never reaches the bridge", async () => {
    const before = up.seen.length;
    for (const p of ["/", "/mcp", "/oauth/token", "/keys", "/a/notes/", "/p/notes/x", "/tb/v1/views/notes/x", "/tb/v1/call", "/v", "/v/", "/v/notes", "/V/notes/x", "/v/Notes/x", "/v/n/x", "/healthz/x", "/admin/v1/x"]) {
      const r = await rawGet(`${base}${p}`);
      assert.equal(r.status, 404, p);
    }
    assert.equal(up.seen.length, before, "nothing was forwarded");
  });

  test("a path cannot climb out of /v/<product>/ or reach the bridge's other routes", async () => {
    const before = up.seen.length;
    for (const p of ["/v/notes/../../mcp", "/v/notes/%2e%2e/%2e%2e/tb/v1/call", "//evil.invalid/v/notes/x", "/v/notes/..\\..\\mcp"]) {
      const r = await rawGet(`${base}${p}`);
      assert.equal(r.status, 404, p);
    }
    assert.equal(up.seen.length, before, "nothing was forwarded");
    answer(200);
    await rawGet(`${base}/v/notes/a/../b`);
    assert.equal(received()?.url, "/tb/v1/views/notes/b", "a dot segment inside the product is resolved before forwarding, and stays under the route");
  });

  test("HEAD and OPTIONS are 405 everywhere; POST on the viewer path is 405; nothing is forwarded", async () => {
    const before = up.seen.length;
    for (const m of ["HEAD", "OPTIONS"]) for (const p of ["/v/notes/x", "/healthz", "/nothing"]) assert.equal((await rawGet(`${base}${p}`, {}, m)).status, 405, `${m} ${p}`);
    assert.equal((await rawGet(`${base}/v/notes/x`, {}, "POST")).status, 405);
    assert.equal((await rawGet(`${base}/v/notes/x`, {}, "PUT")).status, 405);
    assert.equal((await rawGet(`${base}/mcp`, {}, "POST")).status, 404, "an unknown path is 404 for POST");
    assert.equal(up.seen.length, before);
    assert.equal(first(await rawGet(`${base}/v/notes/x`, {}, "OPTIONS"), "allow"), "GET");
  });

  test("/healthz is always ok; /readyz follows the bridge's _ready (with the key) and is not ready when the bridge is down", async () => {
    assert.equal((await rawGet(`${base}/healthz`)).status, 200);
    upstreamAnswer = (req, res) => {
      const ok = req.url === "/tb/v1/views/_ready" && req.headers["tb-views-key"] === KEY;
      res.writeHead(ok ? 200 : 404).end("{}");
    };
    assert.equal((await rawGet(`${base}/readyz`)).status, 200);
    // a second edge on a dead upstream: not ready, still healthy
    const dead = await startViews({ env: good("http://127.0.0.1:9"), logger: silentLogger, port: 0 });
    try {
      assert.equal((await rawGet(`http://127.0.0.1:${dead.port}/readyz`)).status, 503);
      assert.equal((await rawGet(`http://127.0.0.1:${dead.port}/healthz`)).status, 200);
    } finally {
      await dead.stop();
    }
  });

  test("request headers: only Accept, Sec-Fetch-Dest/Mode/Site and If-None-Match reach the bridge; Cookie, Authorization, TB-* and the rest never; absent stays absent", async () => {
    answer(200);
    await rawGet(`${base}/v/notes/x`, {
      Accept: "text/html",
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
      "If-None-Match": '"abc"',
      Cookie: "sid=1",
      Authorization: "Bearer x",
      "TB-Assert": "x",
      "TB-Views-Key": "attacker-key",
      "TB-Grant": "g",
      "X-Forwarded-For": "1.2.3.4",
      "Accept-Language": "en",
      "User-Agent": "ua",
      Referer: "https://x.invalid/",
      Origin: "https://x.invalid",
    });
    const h = received()?.headers ?? {};
    assert.equal(h.accept, "text/html");
    assert.equal(h["sec-fetch-dest"], "iframe");
    assert.equal(h["sec-fetch-mode"], "navigate");
    assert.equal(h["sec-fetch-site"], "cross-site");
    assert.equal(h["if-none-match"], '"abc"');
    assert.equal(h["tb-views-key"], KEY, "the client's TB-Views-Key never replaces the service's");
    for (const n of ["cookie", "authorization", "tb-assert", "tb-grant", "x-forwarded-for", "accept-language", "user-agent", "referer", "origin"]) assert.equal(h[n], undefined, n);
    assert.deepEqual(Object.keys(h).filter((k) => k.startsWith("tb-")), ["tb-views-key"]);
    // absent stays absent: no Sec-Fetch-Dest in, none out (the app's "documents only to iframe" rule fails closed)
    await rawGet(`${base}/v/notes/x`, { Accept: "*/*" });
    const bare = received()?.headers ?? {};
    for (const n of ["sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "if-none-match"]) assert.equal(bare[n], undefined, n);
  });

  test("ETag passes and a 304 round trip has no body", async () => {
    upstreamAnswer = (req, res) => {
      if (req.headers["if-none-match"] === '"v1"') return void res.writeHead(304, { etag: '"v1"' }).end();
      res.writeHead(200, { etag: '"v1"', "content-type": "text/plain" }).end("body");
    };
    const a = await rawGet(`${base}/v/notes/x`);
    assert.equal(a.status, 200);
    assert.equal(first(a, "etag"), '"v1"');
    const b = await rawGet(`${base}/v/notes/x`, { "If-None-Match": '"v1"' });
    assert.equal(b.status, 304);
    assert.equal(b.body.length, 0);
    assert.equal(first(b, "etag"), '"v1"');
    assert.equal(first(b, "x-content-type-options"), "nosniff", "a 304 carries the floor too");
  });

  test("the floor is present when the app sends none, and the app cannot replace any floor header but the CSP", async () => {
    answer(200, { "content-type": "text/plain" });
    const bare = await rawGet(`${base}/v/notes/x`);
    for (const [k, v] of Object.entries(VIEWER_HEADER_FLOOR)) assert.equal(first(bare, k), v, `floor ${k}`);
    assert.equal(bare.headers["x-frame-options"], undefined, "no X-Frame-Options in the floor: framing is the app's CSP frame-ancestors");
    answer(200, {
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "sniff",
      "referrer-policy": "unsafe-url",
      "strict-transport-security": "max-age=0",
      "cross-origin-resource-policy": "cross-origin",
      "permissions-policy": "camera=*",
      "content-security-policy": "default-src 'self'; frame-ancestors https://a.invalid",
    });
    const r = await rawGet(`${base}/v/notes/x`);
    for (const k of Object.keys(VIEWER_HEADER_FLOOR).filter((n) => n !== "content-security-policy")) assert.equal(first(r, k), (VIEWER_HEADER_FLOOR as Record<string, string>)[k], `floor ${k} not replaceable`);
    assert.equal(first(r, "content-security-policy"), "default-src 'self'; frame-ancestors https://a.invalid", "the app's CSP is kept");
  });

  test("Set-Cookie, Access-Control-* and X-Frame-Options from the app never reach the viewer; ordinary headers do", async () => {
    answer(200, {
      "set-cookie": ["a=1; Path=/", "b=2"],
      "access-control-allow-origin": "*",
      "access-control-allow-credentials": "true",
      "x-frame-options": "ALLOW-FROM https://x.invalid",
      "content-type": "text/html; charset=utf-8",
      "content-language": "en",
      vary: "Accept",
    });
    const r = await rawGet(`${base}/v/notes/x`);
    for (const n of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials", "x-frame-options"]) assert.equal(r.headers[n], undefined, n);
    assert.equal(first(r, "content-type"), "text/html; charset=utf-8");
    assert.equal(first(r, "content-language"), "en");
    assert.equal(first(r, "vary"), "Accept");
  });

  test("the viewer token (path) and the views key never appear in a log line or an error body", async () => {
    answer(200);
    await rawGet(`${base}/v/notes/SECRETTOKEN-abc/x?t=QUERYSECRET`);
    const err = await rawGet(`${base}/v/notes/_d/SECRETTOKEN-abc`); // no CSP → refused
    assert.equal(err.status, 502);
    assert.ok(!err.text.includes("SECRETTOKEN") && !err.text.includes(KEY));
    const all = logs.join("\n");
    assert.ok(!all.includes("SECRETTOKEN") && !all.includes("QUERYSECRET") && !all.includes(KEY));
    assert.ok(logs.some((l) => l.includes("viewer_document_unsafe")), "but the refusal is logged (product and code only)");
  });
});

describe("views role: the _d gate (untrusted documents), both ways", () => {
  let up: Fake;
  let csp: string[] | undefined;
  let edge: Awaited<ReturnType<typeof startViews>>;
  let base: string;
  before(async () => {
    up = await fake((_req, res) => {
      res.setHeader("content-type", "text/html");
      if (csp) res.setHeader("content-security-policy", csp);
      res.writeHead(200);
      res.end("<p>doc</p>");
    });
    edge = await startViews({ env: good(up.url), logger: silentLogger, port: 0 });
    base = `http://127.0.0.1:${edge.port}`;
  });
  after(async () => {
    await edge.stop();
    await up.close();
  });
  const get = (path: string, policies: string[] | undefined) => {
    csp = policies;
    return rawGet(`${base}${path}`);
  };

  test("a safe sandbox passes (200, the CSP kept as sent)", async () => {
    for (const p of ["sandbox allow-scripts", "default-src 'none'; sandbox allow-scripts; frame-ancestors https://v.invalid", "sandbox"]) {
      const r = await get("/v/notes/_d/ticket1", [p]);
      assert.equal(r.status, 200, p);
      assert.equal(first(r, "content-security-policy"), p);
      assert.equal(r.text, "<p>doc</p>");
    }
  });

  test("allow-same-origin → 502 viewer_document_unsafe, and the body does not contain the path", async () => {
    const r = await get("/v/notes/_d/ticket-SECRET", ["sandbox allow-scripts allow-same-origin"]);
    assert.equal(r.status, 502);
    assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "viewer_document_unsafe");
    assert.ok(!r.text.includes("ticket-SECRET") && !r.text.includes("/_d"), "no path in the body");
    assert.ok(!r.text.includes("<p>doc</p>"), "the document is not delivered");
    assert.equal(first(r, "x-content-type-options"), "nosniff", "the refusal carries the floor");
  });

  for (const token of VIEWER_DOCUMENT_FORBIDDEN_SANDBOX) {
    test(`forbidden sandbox token ${token} → 502`, async () => {
      assert.equal((await get("/v/notes/_d/t", [`sandbox allow-scripts ${token}`])).status, 502);
    });
  }

  test("no CSP at all → 502 (fail closed); an empty CSP too", async () => {
    assert.equal((await get("/v/notes/_d/t", undefined)).status, 502);
    assert.equal((await get("/v/notes/_d/t", [""])).status, 502);
  });
  test("a CSP without a sandbox directive → 502", async () => {
    assert.equal((await get("/v/notes/_d/t", ["default-src 'none'"])).status, 502);
  });

  test("two CSP headers are judged together: one weak → 502; both safe → 200 and both are delivered", async () => {
    assert.equal((await get("/v/notes/_d/t", ["sandbox allow-scripts", "sandbox allow-scripts allow-same-origin"])).status, 502);
    assert.equal((await get("/v/notes/_d/t", ["sandbox allow-scripts allow-same-origin", "sandbox allow-scripts"])).status, 502);
    assert.equal((await get("/v/notes/_d/t", ["default-src 'none'", "sandbox allow-popups"])).status, 502);
    const ok = await get("/v/notes/_d/t", ["sandbox allow-scripts", "frame-ancestors https://v.invalid"]);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.headers["content-security-policy"], ["sandbox allow-scripts", "frame-ancestors https://v.invalid"]);
  });

  test("the gate is only for _d: the same weak CSP on another path is delivered", async () => {
    for (const p of ["/v/notes/tok", "/v/notes/tok/_d/x", "/v/notes/x_d/y", "/v/notes/_data/y", "/v/notes/_s/asset"]) {
      const r = await get(p, ["sandbox allow-same-origin"]);
      assert.equal(r.status, 200, p);
    }
  });

  test("the gate also sees _d written as %5Fd, with doubled slashes, or with upper-case escapes", async () => {
    for (const p of ["/v/notes/%5Fd/x", "/v/notes/%5fd/x", "/v/notes//_d/x", "/v/notes/%5F%64/x", "/v/notes/_d"]) {
      assert.equal((await get(p, ["sandbox allow-same-origin"])).status, 502, p);
    }
  });
});

describe("views role: limits", () => {
  test("defaults: 120 requests/min per client, 32 in flight, 2 MiB, 10 s", () => {
    assert.equal(VIEWS_PER_CLIENT_PER_MIN, 120);
    assert.equal(VIEWS_EDGE_MAX_IN_FLIGHT, 32);
    assert.equal(VIEWS_MAX_BODY, 2 * 1024 * 1024);
    assert.equal(VIEWS_TIMEOUT_MS, 10_000);
  });

  test("the per-client bucket counts the FIRST X-Forwarded-For hop; another client has its own bucket; health is not counted", async () => {
    const up = await fake((_q, res) => void res.writeHead(200).end("ok"));
    const edge = await startViews({ env: good(up.url), logger: silentLogger, port: 0, limits: { perClientPerMin: 3 } });
    const base = `http://127.0.0.1:${edge.port}`;
    try {
      const a = { "X-Forwarded-For": "203.0.113.7, 10.0.0.1" };
      for (let i = 0; i < 3; i++) assert.equal((await rawGet(`${base}/v/notes/x`, a)).status, 200, `request ${i + 1}`);
      const limited = await rawGet(`${base}/v/notes/x`, a);
      assert.equal(limited.status, 429);
      assert.ok(Number(first(limited, "retry-after")) > 0);
      // same client, a different proxy hop behind it: still the same bucket (the first hop is the client)
      assert.equal((await rawGet(`${base}/v/notes/x`, { "X-Forwarded-For": "203.0.113.7, 10.9.9.9" })).status, 429);
      // another client: not limited
      assert.equal((await rawGet(`${base}/v/notes/x`, { "X-Forwarded-For": "198.51.100.9" })).status, 200);
      // without X-Forwarded-For the socket address is the client
      for (let i = 0; i < 3; i++) assert.equal((await rawGet(`${base}/v/notes/x`)).status, 200);
      assert.equal((await rawGet(`${base}/v/notes/x`)).status, 429);
      for (let i = 0; i < 6; i++) assert.equal((await rawGet(`${base}/healthz`, a)).status, 200, "health is never limited");
    } finally {
      await edge.stop();
      await up.close();
    }
  });

  test("the global in-flight cap answers 503 with Retry-After; it frees up when requests finish", async () => {
    const waiting: (() => void)[] = [];
    const up = await fake((_q, res) => {
      waiting.push(() => res.writeHead(200).end("late"));
    });
    const edge = await startViews({ env: good(up.url), logger: silentLogger, port: 0, limits: { inFlight: 2 } });
    const base = `http://127.0.0.1:${edge.port}`;
    try {
      const a = rawGet(`${base}/v/notes/a`, { "X-Forwarded-For": "1.1.1.1" });
      const b = rawGet(`${base}/v/notes/b`, { "X-Forwarded-For": "2.2.2.2" });
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (waiting.length === 2) {
            clearInterval(t);
            resolve();
          }
        }, 5);
      });
      const busy = await rawGet(`${base}/v/notes/c`, { "X-Forwarded-For": "3.3.3.3" });
      assert.equal(busy.status, 503);
      assert.ok(Number(first(busy, "retry-after")) > 0);
      assert.equal((await rawGet(`${base}/healthz`)).status, 200, "health still answers when viewers are saturated");
      for (const f of waiting.splice(0)) f();
      assert.equal((await a).status, 200);
      assert.equal((await b).status, 200);
      const after = rawGet(`${base}/v/notes/d`, { "X-Forwarded-For": "4.4.4.4" });
      await new Promise((r) => setTimeout(r, 50));
      for (const f of waiting.splice(0)) f();
      assert.equal((await after).status, 200, "quiet once the requests are done");
    } finally {
      for (const f of waiting.splice(0)) f();
      await edge.stop();
      await up.close();
    }
  });

  test("a response of exactly 2 MiB passes; one byte more → 502 (declared and streamed)", async () => {
    let size = VIEWS_MAX_BODY;
    let declare = true;
    const up = await fake((_q, res) => {
      const body = Buffer.alloc(size, 97);
      res.writeHead(200, declare ? { "content-length": String(body.length) } : {});
      res.end(body);
    });
    const edge = await startViews({ env: good(up.url), logger: silentLogger, port: 0 });
    const base = `http://127.0.0.1:${edge.port}`;
    try {
      const ok = await rawGet(`${base}/v/notes/x`);
      assert.equal(ok.status, 200);
      assert.equal(ok.body.length, VIEWS_MAX_BODY);
      size = VIEWS_MAX_BODY + 1;
      const big = await rawGet(`${base}/v/notes/x`);
      assert.equal(big.status, 502);
      assert.equal((JSON.parse(big.text) as { error: { code: string } }).error.code, "viewer_response_too_large");
      declare = false; // chunked: the cap holds while streaming
      assert.equal((await rawGet(`${base}/v/notes/x`)).status, 502);
    } finally {
      await edge.stop();
      await up.close();
    }
  });

  test("an upstream that does not answer in time → 504; one that answers in time passes", async () => {
    let delay = 600;
    const up = await fake((_q, res) => void setTimeout(() => res.writeHead(200).end("late"), delay));
    const edge = await startViews({ env: good(up.url), logger: silentLogger, port: 0, limits: { timeoutMs: 300 } });
    const base = `http://127.0.0.1:${edge.port}`;
    try {
      const slow = await rawGet(`${base}/v/notes/x`);
      assert.equal(slow.status, 504);
      delay = 10;
      assert.equal((await rawGet(`${base}/v/notes/x`)).status, 200);
      // a body that stalls after the headers is cut by the same deadline
      const stall = await fake((_q, res) => {
        res.writeHead(200, { "content-length": "100" });
        res.write("partial");
      });
      const edge2 = await startViews({ env: good(stall.url), logger: silentLogger, port: 0, limits: { timeoutMs: 300 } });
      try {
        assert.equal((await rawGet(`http://127.0.0.1:${edge2.port}/v/notes/x`)).status, 504);
      } finally {
        await edge2.stop();
        await stall.close();
      }
    } finally {
      await edge.stop();
      await up.close();
    }
  });

  test("an unreachable bridge → 503 'viewer address not ready' (not a stack, not an address)", async () => {
    const edge = await startViews({ env: good("http://127.0.0.1:9"), logger: silentLogger, port: 0 });
    try {
      const r = await rawGet(`http://127.0.0.1:${edge.port}/v/notes/x`);
      assert.equal(r.status, 503);
      assert.match(r.text, /viewer address not ready/);
      assert.ok(!r.text.includes("127.0.0.1"));
      assert.ok(Number(first(r, "retry-after")) > 0);
    } finally {
      await edge.stop();
    }
  });

  test("the bridge's own answers (404 for a wrong key, 503 paused) pass through with the floor", async () => {
    const up = await fake((_q, res) => void res.writeHead(503, { "content-type": "application/json", "set-cookie": "x=1" }).end('{"error":{"code":"paused"}}'));
    const edge = await startViews({ env: good(up.url), logger: silentLogger, port: 0 });
    try {
      const r = await rawGet(`http://127.0.0.1:${edge.port}/v/notes/x`);
      assert.equal(r.status, 503);
      assert.match(r.text, /paused/);
      assert.equal(first(r, "x-content-type-options"), "nosniff");
      assert.equal(r.headers["set-cookie"], undefined);
    } finally {
      await edge.stop();
      await up.close();
    }
  });

  test("drain: a request in flight finishes, then the server stops", async () => {
    let release: () => void = () => undefined;
    const up = await fake((_q, res) => {
      release = () => res.writeHead(200).end("done");
    });
    const edge = await startViews({ env: good(up.url), logger: silentLogger, port: 0 });
    const pending = rawGet(`http://127.0.0.1:${edge.port}/v/notes/x`);
    await new Promise((r) => setTimeout(r, 100));
    const draining = edge.drain(5000);
    setTimeout(() => release(), 100);
    assert.equal((await pending).status, 200);
    const d = await draining;
    assert.equal(d.aborted, 0);
    await up.close();
  });
});
