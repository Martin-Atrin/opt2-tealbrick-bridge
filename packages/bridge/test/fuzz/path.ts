/** C62 property (registered by http.test.ts, one shared bridge): random percent-encoded / dot-segment paths under /a/notes/ never reach an app path outside /a/notes/. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { World } from "../support/world.ts";
import { check, fc, rawRequest, tryJson } from "./support.ts";

const word = fc.constantFrom("a", "b", "tb", "v1", "ops", "notes_list", "notes_delete", "manifest", "bridge", "hooks", "launch", "assets", "configure", "p", "admin", "internal", "secret", "x.png");
const dots = fc.constantFrom(".", "..", "...", "%2e", "%2E", "%2e%2e", "%2E%2e", ".%2e", "%2e.", "%252e%252e", "%c0%ae%c0%ae", "..;", "..%00", "..%5c", ".%00.", "%u002e%u002e", "..\\");
const slash = fc.constantFrom("/", "/", "%2f", "%2F", "\\", "%5c", "%5C", "//", "/./", "/;/", "%252f", "%c0%af", "?", "#");
const randomEncoded = fc.array(fc.oneof(fc.constantFrom("%", "%2", "%zz", "%00", "%0a", "%0d", "%20", "%e2%80%ae", "%ff", "..", "/", ":", "@", "?", "#"), fc.string({ unit: "grapheme-ascii", maxLength: 3 })), { maxLength: 4 }).map((a) => a.join(""));
const segment = fc.oneof({ weight: 3, arbitrary: word }, { weight: 4, arbitrary: dots }, { weight: 2, arbitrary: randomEncoded });
// Node refuses spaces and control characters in the request line itself; everything else goes out as written
const clean = (s: string) => s.replace(/[^!-ÿ]/g, (c) => encodeURIComponent(c));
const tail = fc.array(fc.tuple(slash, segment), { minLength: 1, maxLength: 7 }).map((a) => clean(a.map(([s, g]) => s + g).join("")));
const prefix = fc.constantFrom("/a/notes/", "/a/notes", "/a/notes/x/", "/a/notes/tb/v1/");

export function pathContainment(world: () => World): void {
describe("app UI path containment (C62)", () => {

  test("a request under /a/notes/ only ever reaches an app path under /a/notes/ (200 echoes the path; an app-side 404 or a manifest/op hit is a breach)", async () => {
    let reachedApp = 0;
    await check(
      "path.containment",
      fc.asyncProperty(prefix, tail, fc.constantFrom("GET", "POST", "HEAD"), async (pre, rest, method) => {
        const path = pre + rest;
        const w = world();
        const opsBefore = w.appLog.ops.length;
        const r = await rawRequest(w.publicUrl, path, { method, ...(method === "POST" ? { headers: { "content-type": "text/plain" }, body: "x" } : {}) });
        assert.ok(r.status < 500 || r.status === 502, `no crash for ${path}: ${r.status}`);
        assert.equal(w.appLog.ops.length, opsBefore, `op route reached via ${path}`);
        if (method === "HEAD") return;
        const j = tryJson(r.body) as { path?: unknown; error?: unknown } | undefined;
        if (r.status === 200) {
          reachedApp++;
          assert.ok(typeof j?.path === "string", `200 without echoed path (manifest/op/other app route?) via ${path}: ${r.body.slice(0, 120)}`);
          assert.ok(j.path === "/a/notes" || (j.path as string).startsWith("/a/notes/"), `app saw ${j.path} for ${path}`);
        } else if (r.status === 404 && r.body === "" && new URL(path, "http://x").pathname !== "/a/notes") {
          assert.fail(`the app itself answered 404 (empty body): it was reached outside /a/notes/ via ${path}`);
        }
      }),
      { seed: 62010, numRuns: 200, timeMs: 30_000 },
    );
    assert.ok(reachedApp > 0, "the generator must reach the app at least once or the property is vacuous");
  });
});
}
