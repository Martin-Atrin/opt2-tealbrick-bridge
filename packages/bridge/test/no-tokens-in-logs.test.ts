/**
 * Bridge 0.2.3 (Creative S3 review): no log line of the bridge or of tb-views ever contains a viewer token (`tbv_…`) or a
 * person ticket. The paths `/v/<product>/tbv_…`, `/tb/v1/views/<product>/tbv_…`, `/a/<product>/_p/<ticket>` and
 * `/a/<product>/_d/<ticket>` CARRY a secret, so no code may log `req.url`, a path or a query.
 *
 * The test plants random tokens, captures EVERY line the JSON logger writes while good and failing requests run (404
 * unknown product, 503 paused, 503 app down, 502 unsafe document, a refused key, a forbidden header, a refused launch
 * ticket), and asserts that no line contains a planted value (raw, percent-encoded or as part of a path).
 * It also asserts the failing requests DID log (so an empty capture cannot pass).
 *
 * Fire-on-bad (L34), reproducible: the detector is proven on a logger that does leak (see "the detector fires"), and
 * the real code is proven by this mutation, which makes this file fail:
 *   views-route.ts  `ctx.log.warn("bridge.views.request_refused", { code: "forbidden_header" })`
 *     → `ctx.log.warn("bridge.views.request_refused", { code: "forbidden_header", url: req.url })`
 *   views-edge.ts   `o.logger.warn("views.document_unsafe", { code: ..., product: target.product })`
 *     → add `url: req.url` to the fields.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { jsonLogger } from "../src/util.ts";
import { startViews } from "../src/views-edge.ts";
import { type Fake, fake, rawGet } from "./support/views.ts";
import { INS, makeWorld, notesManifest, type World, waitFor } from "./support/world.ts";

const KEY = randomBytes(32).toString("base64url");
const rnd = (n = 18): string => randomBytes(n).toString("base64url");
const viewerToken = (): string => `tbv_${rnd()}`;
/** looks like a compact JWS ticket */
const ticket = (): string => `${rnd(20)}.${rnd(40)}.${rnd(32)}`;

/** Every planted secret appears in these forms; a line containing any of them leaks. */
const forms = (secret: string): string[] => [secret, encodeURIComponent(secret), secret.replaceAll(".", "%2E")];
const leaks = (lines: string[], planted: string[]): string[] => lines.filter((l) => planted.some((p) => forms(p).some((f) => l.includes(f))));
const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

const viewerManifest = { ...notesManifest, version: "1.1.0", publicRoutes: [...notesManifest.publicRoutes, { path: "/v", purpose: "viewer" }] };

describe("the detector itself (fire-on-bad)", () => {
  test("a logger that writes req.url is caught; the real logger fed ids and codes only is not", () => {
    const lines: string[] = [];
    const log = jsonLogger((l) => lines.push(l));
    const secret = viewerToken();
    const req = { url: `/v/notes/${secret}?x=1` };
    log.warn("views.document_unsafe", { code: "viewer_document_unsafe", product: "notes" });
    assert.deepEqual(leaks(lines, [secret]), [], "quiet on good");
    log.warn("views.document_unsafe", { code: "viewer_document_unsafe_leaky", url: req.url });
    assert.equal(leaks(lines, [secret]).length, 1, "fires on a logger that logs req.url");
    log.error("x", { path: encodeURIComponent(secret) });
    assert.equal(leaks(lines, [secret]).length, 2, "fires on the percent-encoded form too");
  });
});

describe("tb-views (the views role): no token in any log line", () => {
  const lines: string[] = [];
  let up: Fake;
  let answer: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;
  let edge: Awaited<ReturnType<typeof startViews>>;
  let base: string;
  before(async () => {
    up = await fake((req, res) => answer(req, res));
    edge = await startViews({ env: { TB_VIEWS_UPSTREAM: up.url, TB_VIEWS_KEY: KEY, PORT: "8080" }, logger: jsonLogger((l) => lines.push(l)), port: 0 });
    base = `http://127.0.0.1:${edge.port}`;
  });
  after(async () => {
    await edge.stop();
    await up.close();
  });

  test("GET /v/<p>/tbv_<random>: served, not served (upstream 404 / 503 / error), unsafe document, dead upstream", async () => {
    const planted: string[] = [];
    const get = async (path: string) => {
      const secret = path.split("/").at(-1) ?? "";
      planted.push(secret);
      return rawGet(`${base}${path}`);
    };
    answer = (_req, res) => void res.writeHead(200, { "content-type": "text/html" }).end("<p>doc</p>");
    const t1 = viewerToken();
    assert.equal((await get(`/v/notes/${t1}`)).status, 200);
    answer = (_req, res) => void res.writeHead(404).end("{}");
    assert.equal((await get(`/v/notes/${viewerToken()}`)).status, 404);
    answer = (_req, res) => void res.writeHead(503).end("{}");
    assert.equal((await get(`/v/notes/${viewerToken()}`)).status, 503);
    // an unsafe document on the _d path: tb-views logs the refusal (product only)
    answer = (_req, res) => void res.writeHead(200, { "content-security-policy": "sandbox allow-scripts allow-same-origin" }).end("<p>doc</p>");
    const dTicket = ticket();
    planted.push(dTicket);
    assert.equal((await rawGet(`${base}/v/notes/_d/${dTicket}`)).status, 502);
    // the token also in a query
    const q = viewerToken();
    planted.push(q);
    await rawGet(`${base}/v/notes/${viewerToken()}?t=${q}`);
    // a dead upstream: the fetch error path
    const dead = await startViews({ env: { TB_VIEWS_UPSTREAM: "http://127.0.0.1:9", TB_VIEWS_KEY: KEY, PORT: "8080" }, logger: jsonLogger((l) => lines.push(l)), port: 0 });
    try {
      const secret = viewerToken();
      planted.push(secret);
      const r = await rawGet(`http://127.0.0.1:${dead.port}/v/notes/${secret}`);
      assert.ok(r.status >= 500, String(r.status));
    } finally {
      await dead.stop();
    }
    assert.ok(parse(lines).some((l) => l.event === "views.document_unsafe"), "the failing variant did log (the capture is not empty)");
    assert.deepEqual(leaks(lines, planted), [], "no log line contains a planted token or ticket");
  });
});

describe("the bridge: no token in any log line (private views route, person proxy)", () => {
  const lines: string[] = [];
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true, env: { TB_VIEWS_KEY: KEY }, logger: jsonLogger((l) => lines.push(l)) });
    w.updateAppTo(viewerManifest);
    await w.publish();
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && !!w.bridge.ctx.table?.apps.get(INS as never)?.manifest?.publicRoutes?.some((r) => r.purpose === "viewer"), 15000);
  });
  after(async () => {
    await w.close();
  });
  const privateRoute = (path: string, headers: Record<string, string> = { "TB-Views-Key": KEY }) => rawGet(`${w.internalUrl}/tb/v1/views${path}`, headers);

  test("private route /tb/v1/views/<p>/tbv_<random>: 200, 404 unknown product, 404 wrong key, 400 forbidden header, 503 paused, 503 app down, 502 unsafe document", async () => {
    const planted: string[] = [];
    const tok = (): string => {
      const t = viewerToken();
      planted.push(t);
      return t;
    };
    w.viewer.handler = (_req, res) => void res.writeHead(200).end("page");
    assert.equal((await privateRoute(`/notes/${tok()}`)).status, 200);
    assert.equal((await privateRoute(`/notes/${tok()}?t=${tok()}`)).status, 200);
    assert.equal((await privateRoute(`/nothere/${tok()}`)).status, 404, "unknown product");
    assert.equal((await privateRoute(`/notes/${tok()}`, { "TB-Views-Key": "wrong-wrong-wrong-wrong-wrong-wrong" })).status, 404, "wrong key");
    assert.equal((await privateRoute(`/notes/${tok()}`, { "TB-Views-Key": KEY, Cookie: "a=b" })).status, 400, "forbidden header");
    // 502: an unsafe _d document
    w.viewer.handler = (_req, res) => void res.writeHead(200, { "content-security-policy": "sandbox allow-same-origin" }).end("<p>doc</p>");
    const dTicket = ticket();
    planted.push(dTicket);
    assert.equal((await privateRoute(`/notes/_d/${dTicket}`)).status, 502, "unsafe document");
    w.viewer.handler = (_req, res) => void res.writeHead(200).end("page");
    // 503 app down
    const app = w.bridge.ctx.table?.apps.get(INS as never);
    assert.ok(app);
    app.down = true;
    try {
      assert.equal((await privateRoute(`/notes/${tok()}`)).status, 503, "app down");
    } finally {
      app.down = false;
    }
    // 503 paused
    await w.publish((c) => {
      c.pause.workspace = true;
    });
    await waitFor(() => w.bridge.ctx.table?.pausedWorkspace === true, 15000);
    try {
      assert.equal((await privateRoute(`/notes/${tok()}`)).status, 503, "paused");
      assert.equal((await privateRoute(`/notes/_d/${ticket()}`)).status, 503, "paused, _d");
    } finally {
      await w.publish();
      await waitFor(() => w.bridge.ctx.table?.pausedWorkspace === false, 15000);
    }
    const events = parse(lines).map((l) => l.event);
    assert.ok(events.includes("bridge.views.document_unsafe"), "the failing variant did log");
    assert.ok(events.includes("bridge.views.request_refused"), "the refused header did log");
    assert.deepEqual(leaks(lines, planted), [], "no log line contains a planted token or ticket");
  });

  test("person proxy /a/<p>/_p/<ticket> and /a/<p>/_d/<ticket>: 200, 404 unknown product, 503 app down, a refused launch ticket in the body and the query", async () => {
    const planted: string[] = [];
    const t = (): string => {
      const x = ticket();
      planted.push(x);
      return x;
    };
    const pub = (path: string, init?: RequestInit) => fetch(`${w.publicUrl}${path}`, init);
    assert.equal((await pub(`/a/notes/_p/${t()}`)).status, 200);
    assert.equal((await pub(`/a/notes/_d/${t()}`)).status, 200);
    assert.equal((await pub(`/a/notes/_p/${t()}?ticket=${t()}`)).status, 200, "ticket also in the query");
    assert.equal((await pub(`/a/nothere/_p/${t()}`)).status, 404, "unknown product");
    assert.equal((await pub(`/a/nothere/_d/${t()}`)).status, 404, "unknown product, _d");
    // a launch with a bad ticket in the form body: refused and logged as a ticket rejection, without the ticket
    const bad = t();
    const launch = await pub("/a/notes/tb/launch", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `ticket=${encodeURIComponent(bad)}` });
    assert.equal(launch.status, 401);
    const app = w.bridge.ctx.table?.apps.get(INS as never);
    assert.ok(app);
    app.down = true;
    try {
      assert.equal((await pub(`/a/notes/_p/${t()}`)).status, 503, "app down");
      assert.equal((await pub(`/a/notes/_d/${t()}`)).status, 503, "app down, _d");
    } finally {
      app.down = false;
    }
    const rejected = parse(lines).filter((l) => l.event === "bridge.rejected" && l.kind === "ticket");
    assert.ok(rejected.length >= 1, "the refused launch ticket did log (code only)");
    assert.deepEqual(leaks(lines, planted), [], "no log line contains a planted ticket");
  });

  test("the whole capture of this world has no viewer or person path in any field", () => {
    // the bridge logs ids, codes and digests only: nothing path-shaped at all
    for (const l of parse(lines)) {
      for (const v of Object.values(l)) {
        if (typeof v === "string") assert.ok(!/(^|\W)(\/v\/|\/a\/|\/tb\/v1\/views\/)\S*(tbv_|_p\/|_d\/)/.test(v), `a log field looks like a viewer or person path: ${v.slice(0, 40)}`);
      }
    }
  });
});
