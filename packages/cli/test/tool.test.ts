import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { Harness } from "./fixtures.ts";

const BRG = "brg_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const WS = "ws_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const AGT = "agt_01HAAAAAAAAAAAAAAAAAAAAAAA";
const CON = "con_01HAAAAAAAAAAAAAAAAAAAAAAA";
const NPUB = "npub1testtesttesttesttesttesttesttesttesttesttesttesttesttest";

const TOOLS = [
  { name: "connect__buzz_identity", title: "Buzz identity", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "connect__buzz_post", title: "Post to Buzz", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
  { name: "connect__buzz_fail", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];

describe("tealbrick tool list | call (F65)", () => {
  const h = new Harness();
  let bridge: Server;
  let calls: { name: string; arguments: unknown }[] = [];

  before(async () => {
    await h.setup();
    bridge = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const json = { "content-type": "application/json" };
      if (req.url === "/oauth/token") return res.writeHead(200, json).end(JSON.stringify({ access_token: "k5-access", token_type: "Bearer", expires_in: 900 }));
      if (req.url === "/mcp" && req.method === "POST") {
        const m = JSON.parse(body);
        if (m.method === "notifications/initialized") return res.writeHead(202).end();
        let result: unknown = {};
        if (m.method === "initialize") result = { protocolVersion: "2025-06-18" };
        else if (m.method === "tools/list") result = { tools: TOOLS };
        else if (m.method === "tools/call") {
          calls.push({ name: m.params.name, arguments: m.params.arguments });
          result =
            m.params.name === "connect__buzz_fail"
              ? { isError: true, content: [{ type: "text", text: "failed" }], structuredContent: { error: { code: "grant_missing", message: "no grant for this tool" } } }
              : { content: [{ type: "text", text: "ok" }], structuredContent: { npub: NPUB } };
        }
        return res.writeHead(200, { ...json, "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      }
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    const bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    await h.store.put(
      `tealbrick.agent.${CON}`,
      JSON.stringify({
        v: 1,
        kind: "agent",
        con: CON,
        agt: AGT,
        ws: WS,
        bridgeId: BRG,
        bridgeUrl,
        tokenEndpoint: `${bridgeUrl}/oauth/token`,
        harness: "tealbrick-cli",
        label: "test",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
        privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
        createdAt: "2026-10-11T12:00:00.000Z",
      }),
    );
  });
  beforeEach(() => {
    calls = [];
  });
  after(async () => {
    bridge.closeAllConnections();
    await new Promise((r) => bridge.close(r));
    await h.teardown();
  });

  test("tool list shows every tool with its read-only flag", async () => {
    const r = await h.run(["tool", "list", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.agent, AGT);
    assert.deepEqual(
      r.json.tools.map((t: any) => [t.name, t.readOnly]),
      [
        ["connect__buzz_identity", true],
        ["connect__buzz_post", false],
        ["connect__buzz_fail", true],
      ],
    );
    assert.equal(r.json.tools[0].title, "Buzz identity");
    const human = await h.run(["tool", "list"]);
    assert.match(human.out, /connect__buzz_identity\s+read-only\s+Buzz identity/);
    assert.match(human.out, /connect__buzz_post\s+write\s+Post to Buzz/);
    assert.equal(calls.length, 0);
  });

  test("tool call on a read-only tool prints the structured result and calls once", async () => {
    const r = await h.run(["tool", "call", "connect__buzz_identity", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json, { tool: "connect__buzz_identity", isError: false, result: { npub: NPUB } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.arguments, {});
    const human = await h.run(["tool", "call", "connect__buzz_identity"]);
    assert.equal(human.code, 0);
    assert.match(human.out, new RegExp(NPUB));
    assert.ok(!h.store.reads.includes("tealbrick.person"), "agent mode never loads the person item");
  });

  test("a write tool without --yes is refused and never called", async () => {
    const r = await h.run(["tool", "call", "connect__buzz_post", "--json"]);
    assert.equal(r.code, 5);
    assert.equal(r.json.error.code, "confirmation_required");
    assert.match(r.json.error.message, /connect__buzz_post/);
    assert.match(r.json.error.message, /it can change data; pass --yes to run it/);
    assert.equal(calls.length, 0);
  });

  test("a write tool with --yes runs once, with --input from JSON text and from a file", async () => {
    const r = await h.run(["tool", "call", "connect__buzz_post", "--yes", "--input", '{"text":"hi"}', "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.arguments, { text: "hi" });
    const file = join(h.dir, "input.json");
    await writeFile(file, '{"text":"from file"}');
    const f = await h.run(["tool", "call", "connect__buzz_post", "--yes", "--input", `@${file}`, "--json"]);
    assert.equal(f.code, 0, f.err);
    assert.deepEqual(calls[1]?.arguments, { text: "from file" });
    const bad = await h.run(["tool", "call", "connect__buzz_post", "--yes", "--input", "{nope", "--json"]);
    assert.equal(bad.code, 8);
    assert.equal(bad.json.error.code, "input_invalid");
    assert.equal(calls.length, 2, "invalid input never reaches the bridge");
  });

  test("an unknown tool is not found and never called", async () => {
    const r = await h.run(["tool", "call", "connect__nope", "--json"]);
    assert.equal(r.code, 6);
    assert.equal(r.json.error.code, "unknown_tool");
    assert.equal(calls.length, 0);
  });

  test("a result with isError exits refused and shows the error code", async () => {
    const r = await h.run(["tool", "call", "connect__buzz_fail", "--json"]);
    assert.equal(r.code, 5);
    assert.equal(r.json.error.code, "grant_missing");
    assert.equal(r.json.error.message, "no grant for this tool");
    assert.equal(calls.length, 1);
    const human = await h.run(["tool", "call", "connect__buzz_fail"]);
    assert.equal(human.code, 5);
    assert.match(human.err, /no grant for this tool/);
  });
});
