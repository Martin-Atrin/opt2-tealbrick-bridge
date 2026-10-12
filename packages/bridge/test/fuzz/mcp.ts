/** C62 fuzz (registered by http.test.ts): MCP JSON-RPC robustness. Never HTTP 5xx, the process stays up, a valid initialize still works. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { World } from "../support/world.ts";
import { check, fc, freshIp } from "./support.ts";

const METHODS = ["initialize", "ping", "tools/list", "tools/call", "resources/list", "resources/read", "resources/templates/list", "prompts/list", "notifications/initialized", "completion/complete", "logging/setLevel", "__proto__", "constructor", "tools/call\u0000", ""];
const TOOLS = ["notes__notes_list", "notes__notes_create", "notes__notes_send", "notes__notes_delete", "notes__tb_skills", "notes__tb_hold_status", "__proto__", "constructor", "notes__", "__", "tb_search", "x".repeat(300)];
const URIS = ["tealbrick://skills/notes/use-notes", "tealbrick://skills/notes/../x", "tealbrick://", "file:///etc/passwd", "__proto__", ""];

const json = fc.jsonValue({ maxDepth: 4 });
const id = fc.oneof(fc.integer(), fc.string({ maxLength: 8 }), fc.constant(null), fc.constant(undefined), fc.double(), fc.constant({}), fc.constant([]), fc.boolean());
const params = fc.oneof(
  json,
  fc.record({ name: fc.oneof(fc.constantFrom(...TOOLS), json), arguments: json, _meta: json }, { requiredKeys: [] }),
  fc.record({ uri: fc.oneof(fc.constantFrom(...URIS), json), protocolVersion: json, capabilities: json, clientInfo: json, cursor: json, limit: json }, { requiredKeys: [] }),
);
const rpc = fc.record({ jsonrpc: fc.oneof({ weight: 8, arbitrary: fc.constant("2.0") }, { weight: 1, arbitrary: json }), id, method: fc.oneof(fc.constantFrom(...METHODS), json), params }, { requiredKeys: ["method"] });

type Wrap = "raw" | "params" | "arguments" | "id" | "method";
const spec = fc.oneof(
  { weight: 4, arbitrary: fc.record({ k: fc.constant("value" as const), v: json }) },
  { weight: 8, arbitrary: fc.record({ k: fc.constant("rpc" as const), v: rpc }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("batch" as const), v: fc.array(rpc, { maxLength: 6 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("text" as const), text: fc.string({ maxLength: 40 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("bytes" as const), bytes: fc.uint8Array({ maxLength: 40 }) }) },
  // deep nesting is built iteratively below (never by recursion in the test itself)
  { weight: 2, arbitrary: fc.record({ k: fc.constant("deep" as const), depth: fc.constantFrom(10, 100, 1000, 5000, 10_000), shape: fc.constantFrom("array", "object", "mixed"), wrap: fc.constantFrom<Wrap>("raw", "params", "arguments", "id") }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("big" as const), size: fc.constantFrom(1 << 16, 1 << 20, 1_900_000), wrap: fc.constantFrom<Wrap>("raw", "params", "arguments", "id", "method") }) },
);
type Spec = typeof spec extends fc.Arbitrary<infer T> ? T : never;

function nest(depth: number, shape: string): string {
  const open: string[] = [];
  const close: string[] = [];
  for (let i = 0; i < depth; i++) {
    const obj = shape === "object" || (shape === "mixed" && i % 2 === 1);
    open.push(obj ? '{"a":' : "[");
    close.push(obj ? "}" : "]");
  }
  return `${open.join("")}1${close.reverse().join("")}`;
}

function wrapIn(wrap: Wrap, inner: string): string {
  switch (wrap) {
    case "raw":
      return inner;
    case "params":
      return `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":${inner}}`;
    case "arguments":
      return `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"notes__notes_list","arguments":${inner}}}`;
    case "id":
      return `{"jsonrpc":"2.0","id":${inner},"method":"ping"}`;
    case "method":
      return `{"jsonrpc":"2.0","id":1,"method":${inner}}`;
  }
}

export function bodyOf(s: Spec): Buffer {
  switch (s.k) {
    case "value":
    case "rpc":
    case "batch":
      return Buffer.from(JSON.stringify(s.v) ?? "null", "utf8");
    case "text":
      return Buffer.from(s.text, "utf8");
    case "bytes":
      return Buffer.from(s.bytes);
    case "deep":
      return Buffer.from(wrapIn(s.wrap, nest(s.depth, s.shape)), "utf8");
    case "big":
      return Buffer.from(wrapIn(s.wrap, s.wrap === "id" ? `"${"y".repeat(s.size)}"` : `"${"x".repeat(s.size)}"`), "utf8");
  }
}

export function mcpRobustness(world: () => World): void {
  describe("MCP JSON-RPC robustness (C62)", () => {
    async function post(w: World, token: string, body: Buffer, sid: string | undefined, contentType = "application/json"): Promise<{ status: number; text: string }> {
      const r = await fetch(`${w.publicUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": contentType, authorization: `Bearer ${token}`, "x-forwarded-for": freshIp(), ...(sid ? { "mcp-session-id": sid } : {}) },
        body: new Uint8Array(body),
      });
      return { status: r.status, text: await r.text() };
    }
    async function init(w: World, token: string): Promise<string> {
      const r = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fuzz" } } });
      assert.equal(r.status, 200, "a valid initialize works");
      assert.ok(r.session);
      return r.session;
    }

    test("random shapes, batches, 10 000-deep nesting and ~1.9 MB strings never produce HTTP 5xx, and the next valid initialize works", async () => {
      const w = world();
      const token = await w.agentToken();
      const sid = await init(w, token);
      const seen = new Map<string, number>();
      await check(
        "mcp.robustness",
        fc.asyncProperty(spec, fc.constantFrom("session", "session", "nosession", "badsession"), async (s, mode) => {
          const body = bodyOf(s);
          const r = await post(w, token, body, mode === "session" ? sid : mode === "badsession" ? "not-a-session" : undefined);
          assert.ok(r.status < 500, `HTTP ${r.status} for ${s.k} (${body.length} bytes): ${r.text.slice(0, 200)}`);
          seen.set(s.k, (seen.get(s.k) ?? 0) + 1);
          await init(w, token);
        }),
        { seed: 62030, numRuns: 300, timeMs: 40_000 },
      );
      for (const k of ["rpc", "batch", "deep", "big"]) assert.ok((seen.get(k) ?? 0) > 0, `generator produced ${k} at least once`);
    });

    test("the extremes, always: depth 10 000 (array, object, mixed) in every position and a 1.9 MB string in every position", async () => {
      const w = world();
      const token = await w.agentToken();
      const sid = await init(w, token);
      for (const wrap of ["raw", "params", "arguments", "id"] as const) {
        for (const shape of ["array", "object", "mixed"] as const) {
          const body = bodyOf({ k: "deep", depth: 10_000, shape, wrap });
          const r = await post(w, token, body, sid);
          assert.ok(r.status < 500, `deep ${shape} in ${wrap}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
        }
      }
      for (const wrap of ["raw", "params", "arguments", "id", "method"] as const) {
        const body = bodyOf({ k: "big", size: 1_900_000, wrap });
        const r = await post(w, token, body, sid);
        assert.ok(r.status < 500, `1.9 MB in ${wrap}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
      }
      // over the 2 MB cap: refused, not a crash
      const over = await post(w, token, Buffer.from(wrapIn("arguments", `"${"x".repeat(2_200_000)}"`)), sid);
      assert.ok(over.status >= 400 && over.status < 500, `over the cap: HTTP ${over.status}`);
      await init(w, token);
    });
  });
}
