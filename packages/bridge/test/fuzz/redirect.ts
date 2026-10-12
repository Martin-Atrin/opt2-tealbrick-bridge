/** C62 property (registered by http.test.ts): OAuth redirect matching via DCR + GET /oauth/authorize. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { World } from "../support/world.ts";
import { check, fc, freshIp } from "./support.ts";

const REGISTERED = "https://app.example.com/cb";
const CHALLENGE = "A".repeat(43);

async function register(w: World, uri: string): Promise<string> {
  const r = await fetch(`${w.publicUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshIp() },
    body: JSON.stringify({ redirect_uris: [uri], client_name: "fuzz" }),
  });
  assert.equal(r.status, 201, `register ${uri}`);
  return ((await r.json()) as { client_id: string }).client_id;
}

async function authorize(w: World, clientId: string, redirectUris: string[]): Promise<{ status: number; location: string | null; body: string }> {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s" });
  for (const u of redirectUris) q.append("redirect_uri", u);
  const r = await fetch(`${w.publicUrl}/oauth/authorize?${q}`, { redirect: "manual", headers: { "x-forwarded-for": freshIp() } });
  return { status: r.status, location: r.headers.get("location"), body: await r.text() };
}

const scheme = fc.constantFrom("https://", "https://", "https://", "http://", "HTTPS://", "//", "javascript:", "data:text/html,", "file://", "ftp://");
const userinfo = fc.constantFrom("", "", "good@", "app.example.com@", "user:pw@", "app.example.com:443@", "%61pp@");
const host = fc.constantFrom(
  "app.example.com", "app.example.com", "APP.EXAMPLE.COM", "app.example.com.", "evil.example", "good", "app.example.com.evil.example", "evil.example#@app.example.com", "evil.example\\@app.example.com",
  "app.example.com%2eevil.example", "xn--pp-example.com", "[::1]", "127.0.0.1", "localhost", "0x7f.1", "app.example.com\t.evil.example",
);
const port = fc.constantFrom("", "", ":443", ":8443", ":0", ":65536", ":80");
const path = fc.constantFrom("/cb", "/cb", "/cb/", "/CB", "/cb/..", "/cb/../cb", "/cb%2e", "/%63b", "/cb;x", "/cb\\x", "//cb", "/other", "", "/", "/cb%00", "/cb%0a", "/cb/%2e%2e/x");
const suffix = fc.constantFrom("", "", "?x=1", "?", "#f", "#", "?redirect=https://evil.example");
const mutated = fc.tuple(scheme, userinfo, host, port, path, suffix).map(([a, b, c, d, e, f]) => a + b + c + d + e + f);
const candidate = fc.oneof({ weight: 6, arbitrary: mutated }, { weight: 1, arbitrary: fc.webUrl() }, { weight: 1, arbitrary: fc.string({ maxLength: 40 }) }, { weight: 1, arbitrary: fc.constant(REGISTERED) });

export function redirectMatching(world: () => World): void {
  describe("OAuth redirect_uri matching (C62)", () => {
    test("control: exactly the registered https URI gets the consent page", async () => {
      const w = world();
      const r = await authorize(w, await register(w, REGISTERED), [REGISTERED]);
      assert.equal(r.status, 200);
      assert.equal(r.location, null);
      assert.match(r.body, /app\.example\.com/);
    });

    test("any redirect_uri other than the registered one gets neither a 302/Location nor the consent page", async () => {
      const w = world();
      const clientId = await register(w, REGISTERED);
      let exact = 0;
      await check(
        "redirect.https",
        fc.asyncProperty(candidate, async (uri) => {
          const r = await authorize(w, clientId, [uri]);
          assert.ok(r.status < 500, `no crash for ${JSON.stringify(uri)}: ${r.status}`);
          assert.equal(r.location, null, `Location header for ${JSON.stringify(uri)}`);
          assert.ok(r.status < 300 || r.status >= 400, `redirect status ${r.status} for ${JSON.stringify(uri)}`);
          if (uri === REGISTERED) {
            exact++;
            assert.equal(r.status, 200);
          } else {
            assert.equal(r.status, 400, `${JSON.stringify(uri)} must be refused, got ${r.status}`);
          }
        }),
        { seed: 62020, numRuns: 250, timeMs: 30_000 },
      );
      assert.ok(exact > 0);
    });

    test("duplicate redirect_uri parameters: only the first (the one the page shows) counts, and it must be the registered one", async () => {
      const w = world();
      const clientId = await register(w, REGISTERED);
      await check(
        "redirect.pollution",
        fc.asyncProperty(candidate, fc.boolean(), async (uri, registeredFirst) => {
          const r = await authorize(w, clientId, registeredFirst ? [REGISTERED, uri] : [uri, REGISTERED]);
          assert.equal(r.location, null);
          if (registeredFirst) {
            assert.equal(r.status, 200);
            assert.ok(!r.body.includes("evil"), "the page must show the registered host only");
          } else assert.equal(r.status, uri === REGISTERED ? 200 : 400);
        }),
        { seed: 62021, numRuns: 60, timeMs: 30_000 },
      );
    });

    test("a loopback http client matches other ports only on the same loopback host, path and query", async () => {
      const w = world();
      const reg = "http://127.0.0.1:5000/cb";
      const clientId = await register(w, reg);
      const hosts = fc.constantFrom("127.0.0.1", "[::1]", "localhost", "127.1", "0.0.0.0", "127.0.0.1.evil.example", "evil.example", "127.0.0.1@evil.example");
      const cand = fc.tuple(fc.constantFrom("http://", "https://"), hosts, fc.constantFrom("", ":1", ":5000", ":80"), fc.constantFrom("/cb", "/cb/", "/x", "/cb?a=1", "/cb#f")).map((t) => t.join(""));
      await check(
        "redirect.loopback",
        fc.asyncProperty(cand, async (uri) => {
          const r = await authorize(w, clientId, [uri]);
          assert.equal(r.location, null);
          assert.ok(r.status === 200 || r.status === 400, `status ${r.status} for ${uri}`);
          if (r.status === 200) {
            const u = new URL(uri);
            assert.ok(u.protocol === "http:" && u.hostname === "127.0.0.1" && u.pathname === "/cb" && u.search === "", `consent page for ${uri}`);
          }
        }),
        { seed: 62022, numRuns: 60, timeMs: 30_000 },
      );
    });
  });
}
