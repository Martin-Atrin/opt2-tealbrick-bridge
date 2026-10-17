/**
 * Bridge 0.2.2 (LA-1): the viewer cache rule, on BOTH surfaces that shape a viewer answer: the views role (tb-views) and
 * the bridge private route. One rule, the manifest's `viewerFloorOverride(name, value, path)` (0.1.22): the app's
 * `Cache-Control` replaces the floor's `no-store` ONLY as `public, max-age=<n>, immutable` on `/v/<product>/_s/…`;
 * a token page, a data answer and a `_d` document stay `no-store` (a revoked link must not come from a cache).
 * L34: each case fires on the bad input and stays quiet on the good one.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";
import { VIEWER_HEADER_FLOOR, viewerFloorOverride } from "@opt2-tealbrick/manifest";
import { silentLogger } from "../src/util.ts";
import { startViews } from "../src/views-edge.ts";
import { type Fake, fake, first, type RawResponse, rawGet } from "./support/views.ts";
import { INS, makeWorld, notesManifest, type World, waitFor } from "./support/world.ts";

const KEY = randomBytes(32).toString("base64url");
const IMMUTABLE = "public, max-age=31536000, immutable";
const SAFE_DOC_CSP = "sandbox allow-scripts";
const viewerManifest = { ...notesManifest, version: "1.1.0", publicRoutes: [...notesManifest.publicRoutes, { path: "/v", purpose: "viewer" }] };

interface Surface {
  /** the app (or the bridge, for the views role) answers every request with these headers */
  answer(headers: Record<string, string | string[]>): void;
  get(path: string): Promise<RawResponse>;
}

/** The cases both surfaces must agree on: path under /v/<product>, what the app sends, the Cache-Control the viewer gets. */
function cases(s: () => Surface): void {
  const cache = async (path: string, headers: Record<string, string | string[]>): Promise<{ r: RawResponse; cc: string[] | undefined }> => {
    s().answer(headers);
    const r = await s().get(path);
    return { r, cc: r.headers["cache-control"] };
  };

  test("an /_s/ asset keeps the app's immutable value (any order of the directives), and still gets the rest of the floor", async () => {
    for (const value of [IMMUTABLE, "immutable, max-age=60, public", "max-age=0, immutable", "PUBLIC, Max-Age=300, IMMUTABLE"]) {
      const { r, cc } = await cache("/notes/_s/app.3f9a1c.js", { "content-type": "text/javascript", "cache-control": value });
      assert.equal(r.status, 200, value);
      assert.deepEqual(cc, [value], value);
      for (const [k, v] of Object.entries(VIEWER_HEADER_FLOOR)) if (k !== "cache-control" && k !== "content-security-policy") assert.equal(first(r, k), v, `${value}: floor ${k}`);
    }
  });

  test("the app's value is judged by the manifest rule itself (no second copy of it here)", async () => {
    const values = [IMMUTABLE, "public, max-age=3600", "private, max-age=60, immutable", "public, max-age=60, immutable, no-cache", "immutable", "public, max-age=1e9, immutable", "no-store", ""];
    for (const value of values) {
      const { cc } = await cache("/notes/_s/app.js", { "cache-control": value });
      const expected = viewerFloorOverride("cache-control", value, "/v/notes/_s/app.js") ? [value] : ["no-store"];
      assert.deepEqual(cc, expected, JSON.stringify(value));
    }
  });

  test("a value that is not public+immutable on /_s/ stays no-store", async () => {
    for (const value of ["public, max-age=3600", "max-age=31536000", "private, max-age=60, immutable", "public, immutable", "no-cache", "public, max-age=60, immutable, no-cache"]) {
      assert.deepEqual((await cache("/notes/_s/app.js", { "cache-control": value })).cc, ["no-store"], value);
    }
  });

  test("a token page and a data answer stay no-store even when the app sends immutable", async () => {
    for (const path of ["/notes/tok1", "/notes/tok1/data", "/notes/tok1/_s/app.js", "/notes/x_s/app.js", "/notes/_sx/app.js"]) {
      assert.deepEqual((await cache(path, { "cache-control": IMMUTABLE })).cc, ["no-store"], path);
    }
  });

  test("a _d document stays no-store (its safe sandbox is delivered, its immutable value is not)", async () => {
    for (const path of ["/notes/_d/doc", "/notes/_d/_s/app.js"]) {
      const { r, cc } = await cache(path, { "cache-control": IMMUTABLE, "content-security-policy": SAFE_DOC_CSP });
      assert.equal(r.status, 200, path);
      assert.deepEqual(cc, ["no-store"], path);
      assert.equal(first(r, "content-security-policy"), SAFE_DOC_CSP);
    }
  });

  test("a doubled slash does not turn a path into an asset path; the same app path written with %5F is the asset path", async () => {
    assert.deepEqual((await cache("/notes//_s/app.js", { "cache-control": IMMUTABLE })).cc, ["no-store"]);
    assert.deepEqual((await cache("/notes/%5Fs/app.js", { "cache-control": IMMUTABLE })).cc, [IMMUTABLE], "the app sees /_s/app.js, so does the rule");
  });

  test("two Cache-Control lines never count as one immutable value", async () => {
    assert.deepEqual((await cache("/notes/_s/app.js", { "cache-control": [IMMUTABLE, "public, max-age=60, immutable"] })).cc, ["no-store"]);
  });

  test("the CSP still replaces the floor's on an asset; an app that sends no Cache-Control gets no-store", async () => {
    const { r } = await cache("/notes/_s/app.js", { "cache-control": IMMUTABLE, "content-security-policy": "default-src 'self'" });
    assert.equal(first(r, "content-security-policy"), "default-src 'self'");
    assert.deepEqual((await cache("/notes/_s/app.js", { "content-type": "text/javascript" })).cc, ["no-store"]);
  });
}

describe("viewer cache rule: the views role (tb-views)", () => {
  let up: Fake;
  let edge: Awaited<ReturnType<typeof startViews>>;
  let current: Record<string, string | string[]> = {};
  before(async () => {
    up = await fake((_req: IncomingMessage, res: ServerResponse) => void res.writeHead(200, current).end("body"));
    edge = await startViews({ env: { TB_VIEWS_UPSTREAM: up.url, TB_VIEWS_KEY: KEY, PORT: "8080" }, logger: silentLogger, port: 0 });
  });
  after(async () => {
    await edge.stop();
    await up.close();
  });
  const surface = (): Surface => ({
    answer: (h) => {
      current = h;
    },
    get: (path) => rawGet(`http://127.0.0.1:${edge.port}/v${path}`),
  });
  cases(surface);
});

describe("viewer cache rule: the bridge private route", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true, env: { TB_VIEWS_KEY: KEY } });
    w.updateAppTo(viewerManifest);
    await w.publish();
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && !!w.bridge.ctx.table?.apps.get(INS as never)?.manifest?.publicRoutes?.some((r) => r.purpose === "viewer"), 15000);
  });
  after(async () => {
    await w.close();
  });
  const surface = (): Surface => ({
    answer: (h) => {
      w.viewer.handler = (_req, res) => void res.writeHead(200, h).end("body");
    },
    get: (path) => rawGet(`${w.internalUrl}/tb/v1/views${path}`, { "TB-Views-Key": KEY }),
  });
  cases(surface);
});

describe("viewer cache rule: all hops together (tb-views → bridge route → app)", () => {
  let w: World;
  let edge: Awaited<ReturnType<typeof startViews>>;
  before(async () => {
    w = await makeWorld({ real: true, env: { TB_VIEWS_KEY: KEY } });
    w.updateAppTo(viewerManifest);
    await w.publish();
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && !!w.bridge.ctx.table?.apps.get(INS as never)?.manifest?.publicRoutes?.some((r) => r.purpose === "viewer"), 15000);
    edge = await startViews({ env: { TB_VIEWS_UPSTREAM: w.internalUrl, TB_VIEWS_KEY: KEY }, logger: silentLogger, port: 0 });
  });
  after(async () => {
    await edge.stop();
    await w.close();
  });
  cases(() => ({
    answer: (h) => {
      w.viewer.handler = (_req, res) => void res.writeHead(200, h).end("body");
    },
    get: (path) => rawGet(`http://127.0.0.1:${edge.port}/v${path}`),
  }));
});
