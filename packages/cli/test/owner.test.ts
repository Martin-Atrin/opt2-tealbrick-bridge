import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { SPEC_VERSION } from "@opt2-tealbrick/spec";
import { apiError, Harness } from "./fixtures.ts";

describe("owner commands: envelope, exit codes, credential kind", () => {
  let h: Harness;
  beforeEach(async () => {
    h = new Harness();
    await h.setup();
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("--version --json prints {cli, bridge, spec}", async () => {
    const r = await h.run(["--version", "--json"]);
    assert.equal(r.code, 0);
    assert.deepEqual(Object.keys(r.json).sort(), ["bridge", "cli", "spec"]);
    assert.equal(r.json.spec, SPEC_VERSION);
  });

  it("whoami --json: one JSON value, K3 sent as Bearer, session expiry included", async () => {
    await h.signIn();
    h.portal.on("GET", "/me", () => ({ body: { account: { id: "acc_1" }, person: { id: "per_1", email: "a@example.test" }, currentWorkspaceId: "ws_1", workspaceCount: 1, firstSignIn: false } }));
    const r = await h.run(["whoami", "--json"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.currentWorkspaceId, "ws_1");
    assert.equal(r.json.session.id, "osn_01TEST");
    assert.equal(h.portal.requests[0]?.headers.authorization, "Bearer tbo_testtoken0123456789");
    assert.ok(!r.out.includes("tbo_"));
  });

  it("HTTP status to exit code mapping, with the CORE envelope on stdout", async () => {
    await h.signIn();
    const cases: [number, string, number][] = [
      [401, "unauthenticated", 3],
      [403, "forbidden", 5],
      [404, "not_found", 6],
      [409, "conflict", 7],
      [422, "validation_failed", 8],
      [400, "bad_request", 8],
      [500, "internal", 9],
      [503, "upstream_timeout", 9],
    ];
    for (const [status, code, exit] of cases) {
      h.portal.on("GET", "/me", () => apiError(status, code, `msg ${status}`));
      const r = await h.run(["whoami", "--json"]);
      assert.equal(r.code, exit, `${status} -> ${exit}`);
      assert.deepEqual(Object.keys(r.json), ["error"]);
      assert.equal(r.json.error.code, code);
      assert.equal(r.json.error.requestId, "req_fake");
      assert.equal(r.json.error.message, `msg ${status}`);
    }
  });

  it("network failure exits 9", async () => {
    await h.signIn();
    const r = await h.run(["whoami", "--json"], {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.equal(r.code, 9);
    assert.equal(r.json.error.code, "upstream_timeout");
  });

  it("not signed in exits 3 before any network call", async () => {
    const r = await h.run(["whoami", "--json"]);
    assert.equal(r.code, 3);
    assert.equal(h.portal.requests.length, 0);
  });

  it("an agent-looking credential in the person item is refused with exit 4 and no network call", async () => {
    for (const value of [
      JSON.stringify({ kind: "agent", agt: "agt_1", privateKey: "never-printed" }),
      JSON.stringify({ v: 1, kind: "person", token: "tbr_refreshtoken", sessionId: "osn_1", portal: h.portal.origin, expiresAt: "2099-01-01T00:00:00Z" }),
      "eyJhbGciOiJFZERTQSJ9.payload.sig",
    ]) {
      await h.store.put("tealbrick.person", value);
      const r = await h.run(["whoami", "--json"]);
      assert.equal(r.code, 4, value);
      assert.equal(r.json.error.code, "wrong_credential_kind");
      assert.ok(!r.out.includes("never-printed") && !r.err.includes("never-printed"));
    }
    assert.equal(h.portal.requests.length, 0);
  });

  it("owner commands never read an agent item", async () => {
    await h.signIn();
    await h.store.put("tealbrick.agent.con_01X", JSON.stringify({ kind: "agent", agt: "agt_1", bridgeUrl: "https://b.example.test" }));
    h.portal.on("GET", "/me", () => ({ body: { account: { id: "acc_1" }, person: { id: "p", email: "e" }, currentWorkspaceId: "ws_1", workspaceCount: 1 } }));
    h.portal.on("GET", "/workspaces", () => ({ body: { items: [], nextCursor: null } }));
    h.portal.on("GET", "/workspaces/{ws}/agents", () => ({ body: { items: [], nextCursor: null } }));
    h.portal.on("GET", "/catalog", () => ({ body: { digest: "sha256:x", items: [] } }));
    h.portal.on("GET", "/drafts", () => ({ body: { items: [], nextCursor: null } }));
    for (const argv of [["whoami"], ["workspaces", "list"], ["agents", "list"], ["catalog"], ["draft", "list"]]) {
      const r = await h.run([...argv, "--json"]);
      assert.equal(r.code, 0, argv.join(" "));
    }
    assert.deepEqual(h.store.reads.filter((n) => n !== "tealbrick.person"), []);
  });

  it("a token for another Portal is never sent there", async () => {
    await h.signIn();
    const r = await h.run(["whoami", "--json", "--portal", "https://other.example.test"]);
    assert.equal(r.code, 3);
    assert.match(r.json.error.message, /signed in to/);
    assert.equal(h.portal.requests.length, 0);
  });

  it("portal origin must be https unless loopback", async () => {
    await h.signIn();
    const r = await h.run(["whoami", "--json", "--portal", "http://portal.example.test"]);
    assert.equal(r.code, 2);
  });

  it("usage errors exit 2 (also for unknown agent/bridge/admin/standalone subcommands)", async () => {
    assert.equal((await h.run(["nope", "--json"])).code, 2);
    assert.equal((await h.run(["--bogus", "--json"])).code, 2);
    assert.equal((await h.run(["--json"])).code, 2);
    for (const g of ["agent", "bridge", "standalone"]) assert.equal((await h.run([g, "x"])).code, 2);
  });

  it("catalog --search filters locally over intents and keywords", async () => {
    await h.signIn();
    h.portal.on("GET", "/catalog", () => ({
      body: {
        digest: "sha256:abc",
        items: [
          { slug: "alpha", name: "Alpha", category: "knowledge", summary: "s", intents: ["remember things"], keywords: ["notes"] },
          { slug: "beta", name: "Beta", category: "connect", summary: "s", intents: ["send mail"], keywords: ["email"] },
        ],
      },
    }));
    const r = await h.run(["catalog", "--search", "EMAIL", "--json"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.items.map((i: any) => i.slug), ["beta"]);
    const none = await h.run(["catalog", "--search", "zzz", "--json"]);
    assert.deepEqual(none.json.items, []);
  });

  it("path params, query params and bodies come from the route row", async () => {
    await h.signIn();
    h.portal.on("GET", "/licences", () => ({ body: { items: [], nextCursor: null } }));
    h.portal.on("GET", "/workspaces/{ws}/agents/{agt}", () => ({ body: { id: "agt_1", name: "A" } }));
    h.portal.on("GET", "/workspaces/{ws}/agents/{agt}/connections", () => ({ body: { items: [{ id: "con_1" }] } }));
    await h.run(["licences", "list", "--product", "p1", "--assigned", "true", "--limit", "5", "--json"]);
    const q = h.portal.requests.find((r) => r.path === "/api/v1/licences");
    assert.equal(q?.query.get("product"), "p1");
    assert.equal(q?.query.get("assigned"), "true");
    assert.equal(q?.query.get("limit"), "5");
    const show = await h.run(["agents", "show", "agt_1", "--ws", "ws_9", "--json"]);
    assert.equal(show.code, 0);
    assert.equal(show.json.connections[0].id, "con_1");
    assert.ok(h.portal.requests.some((r) => r.path === "/api/v1/workspaces/ws_9/agents/agt_1/connections"));
  });
});

describe("agents export (owner): card ids for agent login --file", () => {
  const h = new Harness();
  before(async () => {
    await h.setup();
  });
  after(async () => {
    await h.teardown();
  });
  it("fills ids by unique name into an existing file and reports the rest", async () => {
    await h.signIn();
    h.portal.on("GET", "/workspaces/{ws}/agents", () => ({
      body: {
        items: [
          { id: "agt_01HAAAAAAAAAAAAAAAAAAAAAAA", name: "Agent 01", purpose: "p", harnessOptionId: "generic-mcp" },
          { id: "agt_01HBBBBBBBBBBBBBBBBBBBBBBB", name: "Twin", purpose: "p", harnessOptionId: "generic-mcp" },
          { id: "agt_01HCCCCCCCCCCCCCCCCCCCCCCC", name: "Twin", purpose: "p", harnessOptionId: "generic-mcp" },
        ],
        nextCursor: null,
      },
    }));
    const file = join(h.dir, "agents.json");
    await writeFile(file, JSON.stringify({ format: "tealbrick.agents/1", agents: [{ name: "Agent 01", create: true }, { name: "Twin" }, { name: "Missing" }] }));
    const r = await h.run(["agents", "export", "--file", file, "--ws", "ws_01HZZZZZZZZZZZZZZZZZZZZZZZ", "--json"]);
    assert.equal(r.code, 0, r.err);
    const doc = JSON.parse(await readFile(file, "utf8"));
    assert.equal(doc.agents[0].id, "agt_01HAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(doc.agents[0].create, undefined, "a resolved entry no longer asks to create");
    assert.equal(doc.agents[1].id, undefined, "ambiguous names are not guessed");
    assert.equal(doc.agents[2].id, undefined);
    assert.equal(r.json.unmatched.length, 2);
  });
});
