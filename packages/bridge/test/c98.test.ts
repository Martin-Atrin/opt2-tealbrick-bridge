/**
 * C98 (S1 from real agents): model-driven MCP clients cannot set `_meta`, so every `idempotency: required` write
 * failed. The bridge now derives the key when the client sends none. REAL path: real bridge → real miniapp-sdk app
 * (receipts + idempotency in the SDK), called model-style (no `_meta`) over the remote MCP surface and through the
 * stdio relay. A write succeeds once; an identical retry returns the same result and the handler runs once.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { after, before, describe, test } from "node:test";
import { deriveIdempotencyKey } from "@opt2-tealbrick/manifest";
import { startRelay } from "@opt2-tealbrick/relay";
import { freePort, type RealSdkApp, startRealSdkApp } from "./support/sdk-app.ts";
import { AGT, BRG, CON, makeWorld, type World, waitFor } from "./support/world.ts";

const SDKINS = "ins_01HSDKWR1TESDKWR1TESDKWR1T";
const writeOp = (id: string, idempotency: "required" | "supported", crud: string[]) => ({
  id,
  title: id,
  description: `Write op (${idempotency})`,
  input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  output: { type: "object" },
  crud,
  effect: "write",
  idempotency,
  receipt: true,
  audience: "agent",
});

describe("C98: bridge-derived idempotency key for model-driven clients (real SDK app)", () => {
  let w: World;
  let sdk: RealSdkApp;
  const runs: string[] = [];

  before(async () => {
    const port = await freePort();
    w = await makeWorld({ real: true, extraOwnInfraOrigins: [`http://127.0.0.1:${port}`] });
    sdk = await startRealSdkApp(w, {
      ins: SDKINS,
      product: "jot",
      code: "tbe_sdkwriteappcode0001",
      port,
      operations: [writeOp("jot_add", "required", ["create"]), writeOp("jot_note", "supported", ["update"])],
      handlers: {
        jot_add: async (input: { text: string }) => {
          runs.push(`add:${input.text}`);
          return { id: `j${runs.length}`, text: input.text };
        },
        jot_note: async (input: { text: string }) => {
          runs.push(`note:${input.text}`);
          return { id: `n${runs.length}` };
        },
      },
      agentGrantCrud: ["read", "create", "update"],
    });
  });
  after(async () => {
    await sdk?.stop();
    await w?.close();
  });

  const session = async () => {
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "model-client" } } });
    assert.equal(init.status, 200);
    return { token, sid: init.session as string };
  };
  const call = async (s: { token: string; sid: string }, id: number, name: string, args: unknown, meta?: object) =>
    (await w.mcp(s.token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }, s.sid)).json.result;

  test("remote MCP, no _meta: a required-idempotency write succeeds once; an identical retry returns the same result", async () => {
    const s = await session();
    const before = runs.length;
    const first = await call(s, 2, "jot__jot_add", { text: "hello" });
    assert.equal(first.isError, undefined, JSON.stringify(first));
    const again = await call(s, 3, "jot__jot_add", { text: "hello" });
    assert.equal(again.isError, undefined, JSON.stringify(again));
    assert.deepEqual(again.structuredContent, first.structuredContent, "same result");
    assert.equal(runs.length - before, 1, "the handler ran once (no duplicate)");
    // a different input is a different call
    const other = await call(s, 4, "jot__jot_add", { text: "world" });
    assert.equal(other.isError, undefined);
    assert.equal(runs.length - before, 2);
  });

  test("a client that sends its own _meta key keeps exact semantics (different keys → two runs)", async () => {
    const s = await session();
    const before = runs.length;
    const k = "tealbrick/idempotencyKey";
    await call(s, 2, "jot__jot_add", { text: "same" }, { [k]: "client-key-0001" });
    await call(s, 3, "jot__jot_add", { text: "same" }, { [k]: "client-key-0002" });
    assert.equal(runs.length - before, 2);
    await call(s, 4, "jot__jot_add", { text: "same" }, { [k]: "client-key-0002" });
    assert.equal(runs.length - before, 2, "a repeated client key is deduplicated");
  });

  test("stdio relay (what harnesses run), no _meta: one run for an identical retry", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const relay = startRelay({ api: w.api, bridgeUrl: w.publicUrl, connection: { con: CON as never, agt: AGT as never, bridgeId: BRG as never }, signer: { sign: (i) => w.signRaw(i), publicJwk: () => w.agentKey.publicJwk }, stdin, stdout });
    const lines: { id?: number; result?: { isError?: boolean; structuredContent?: unknown } }[] = [];
    stdout.on("data", (d: Buffer) => {
      for (const l of d.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(l));
    });
    const rpc = (m: object) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    try {
      rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "relay-model" } } });
      await waitFor(() => lines.some((l) => l.id === 1));
      rpc({ method: "notifications/initialized" });
      const before = runs.length;
      rpc({ id: 2, method: "tools/call", params: { name: "jot__jot_add", arguments: { text: "via relay" } } });
      await waitFor(() => lines.some((l) => l.id === 2), 15000);
      rpc({ id: 3, method: "tools/call", params: { name: "jot__jot_add", arguments: { text: "via relay" } } });
      await waitFor(() => lines.some((l) => l.id === 3), 15000);
      const a = lines.find((l) => l.id === 2)?.result;
      const b = lines.find((l) => l.id === 3)?.result;
      assert.equal(a?.isError, undefined, JSON.stringify(a));
      assert.deepEqual(b?.structuredContent, a?.structuredContent);
      assert.equal(runs.length - before, 1);
    } finally {
      relay.stop();
    }
  });

  test("supported-idempotency ops get a derived key too; other sessions and windows give other keys", async () => {
    const s = await session();
    const before = runs.length;
    await call(s, 2, "jot__jot_note", { text: "x" });
    await call(s, 3, "jot__jot_note", { text: "x" });
    assert.equal(runs.length - before, 1);
    // the shared rule (manifest 0.1.9): what the bridge sends is exactly this key
    const forwarded = (k: string) => deriveIdempotencyKey({ connection: CON, session: s.sid, op: "jot_note", input: { text: k }, now: Date.now() });
    assert.match(forwarded("x"), /^drv_[0-9a-f]{64}$/);
    const t0 = 1_000_000_000_000;
    const k = deriveIdempotencyKey({ connection: CON, session: "s1", op: "jot_add", input: { text: "a" }, now: t0 });
    assert.equal(deriveIdempotencyKey({ connection: CON, session: "s1", op: "jot_add", input: { text: "a" }, now: t0 + 1000 }), k, "same window");
    assert.notEqual(deriveIdempotencyKey({ connection: CON, session: "s2", op: "jot_add", input: { text: "a" }, now: t0 }), k, "other session");
    assert.notEqual(deriveIdempotencyKey({ connection: "con_other", session: "s1", op: "jot_add", input: { text: "a" }, now: t0 }), k, "other connection");
    assert.notEqual(deriveIdempotencyKey({ connection: CON, session: "s1", op: "jot_add", input: { text: "a" }, now: t0 + 600_000 }), k, "next window");
  });
});
