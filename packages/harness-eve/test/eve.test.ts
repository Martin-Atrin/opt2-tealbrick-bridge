import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { connectEveToBridge } from "../src/index.ts";

test("bridge tools become Eve tools; held results are shown, not errors", async () => {
  const toBridge = new PassThrough();
  const fromBridge = new PassThrough();
  toBridge.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      const m = JSON.parse(line);
      if (m.id === undefined) continue;
      const result =
        m.method === "initialize" ? { protocolVersion: "2025-06-18", instructions: "idx" }
        : m.method === "tools/list" ? { tools: [{ name: "notes__notes_send", description: "Send", inputSchema: { type: "object" } }] }
        : { structuredContent: { status: "held", holdId: "h1", expiresAt: "2030-01-01T00:00:00Z", checkWith: "notes__tb_hold_status" } };
      fromBridge.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n`);
    }
  });
  const held: string[] = [];
  const eve = await connectEveToBridge({ agentId: "agt_X", relay: { streams: { input: fromBridge, output: toBridge } }, defineTool: (d) => d, onHeld: (_t, h) => held.push(h) });
  assert.equal(eve.instructions, "idx");
  const tool = eve.tools.notes__notes_send as { execute: (i: unknown, c: unknown) => Promise<any> };
  const r = await tool.execute({}, {});
  assert.equal(r.status, "held");
  assert.deepEqual(held, ["h1"]);
  eve.close();
});
