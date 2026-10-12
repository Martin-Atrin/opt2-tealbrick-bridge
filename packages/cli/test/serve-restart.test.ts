/**
 * F26 / L21 (real agent, S2): `agent serve` hung when the bridge restarted mid-call: the relay wrote no answer for the
 * in-flight request and the MCP client waited forever. Real path: real bridge (test world), in-process relay, real
 * MCP client, the real serveLoop. The first inbox poll hangs in the app while the bridge restarts underneath it; serve
 * must recover by itself and process the next message.
 */
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { after, before, describe, test } from "node:test";
import { connectMcp, McpTimeoutError, startRelay } from "@opt2-tealbrick/bridge";
import { AGT, BRG, CON, makeWorld, type World } from "../../bridge/test/support/world.ts";
import { type ServeState, serveLoop, validateServeConfig } from "../src/serve.ts";

describe("agent serve survives a bridge restart mid-call (F26)", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  test("the in-flight call fails fast (relay answers), serve backs off, reconnects and handles the next message", async () => {
    const toRelay = new PassThrough();
    const fromRelay = new PassThrough();
    const relay = startRelay({ api: w.api, bridgeUrl: w.publicUrl, connection: { con: CON as never, agt: AGT as never, bridgeId: BRG as never }, signer: { sign: (i) => w.signRaw(i), publicJwk: () => w.agentKey.publicJwk }, stdin: toRelay, stdout: fromRelay });
    const mcp = connectMcp({ streams: { input: fromRelay, output: toRelay }, callTimeoutMs: 20_000 });
    await mcp.initialize("serve-restart-test");

    let polls = 0;
    let restarted = false;
    const messages: { seq: number; text: string }[] = [];
    // the inbox is the notes app's list op: the FIRST poll hangs while the bridge restarts (connection cut mid-call)
    w.appOps.override = (op: string, _b: Record<string, unknown>, res: ServerResponse) => {
      if (op !== "notes_list") return false;
      polls += 1;
      if (polls === 1) {
        void w.restart().then(() => {
          restarted = true;
          messages.push({ seq: 1, text: "after the restart" });
        });
        return true; // never answered: the bridge goes away underneath this call
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", output: { messages, nextSeq: messages.length } }));
      return true;
    };

    const abort = new AbortController();
    const turns: string[] = [];
    const logs: string[] = [];
    const started = Date.now();
    let firstErrorMs: number | undefined;
    let state: ServeState = { cursors: {}, seen: {}, primed: {} };
    const done = serveLoop(
      validateServeConfig({ format: "tealbrick.agent-serve/1", harness: { kind: "command", command: ["true"] }, inboxes: [{ tool: "notes__notes_list", items: "messages", id: "seq", wake: "all" }], backlog: true, pollSeconds: 5 }),
      {
        mcp,
        async runTurn(prompt) {
          turns.push(prompt);
          abort.abort();
          return { ok: true };
        },
        loadState: async () => structuredClone(state),
        saveState: async (s) => {
          state = structuredClone(s);
        },
        log: (e) => {
          if (e === "serve.error" && firstErrorMs === undefined) firstErrorMs = Date.now() - started;
          logs.push(e);
        },
        sleep: (ms, signal) =>
          new Promise((r) => {
            const t = setTimeout(r, Math.min(ms, 200));
            signal.addEventListener("abort", () => r(undefined), { once: true });
            void t;
          }),
        now: () => Date.now(),
        reconnect: async () => {
          await mcp.initialize("serve-restart-test");
        },
      },
      abort.signal,
    );
    const guard = setTimeout(() => abort.abort(), 25_000);
    await done;
    clearTimeout(guard);
    relay.stop();
    mcp.close();
    w.appOps.override = undefined;
    assert.ok(restarted, "the bridge restarted mid-call");
    assert.ok(logs.includes("serve.error"), "the lost call surfaced as an error (no silent hang)");
    assert.ok((firstErrorMs ?? Infinity) < 10_000, `the RELAY answered the lost call (error after ${firstErrorMs} ms, client timeout is 20 s)`);
    assert.ok(logs.includes("serve.reconnected"));
    assert.equal(turns.length, 1, "serve recovered by itself and processed the next message");
    assert.match(turns[0] as string, /after the restart/);
  });

  test("an MCP call with no answer at all fails after the per-call timeout (never waits forever)", async () => {
    const silent = new PassThrough();
    const sink = new PassThrough();
    const mcp = connectMcp({ streams: { input: silent, output: sink }, callTimeoutMs: 150 });
    await assert.rejects(mcp.callTool("x__y", {}), (e) => e instanceof McpTimeoutError);
    mcp.close();
  });

  test("the relay answers a request whose response carries no answer for it (empty stream / 202)", async () => {
    for (const reply of [() => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }), () => new Response(null, { status: 202 })]) {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const relay = startRelay({
        api: w.api,
        bridgeUrl: w.publicUrl,
        connection: { con: CON as never, agt: AGT as never, bridgeId: BRG as never },
        signer: { sign: (i) => w.signRaw(i), publicJwk: () => w.agentKey.publicJwk },
        stdin,
        stdout,
        fetch: async (url, init) => {
          let method: string | undefined;
          try {
            method = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string }).method : undefined;
          } catch {
            method = undefined; // the OAuth token request (form body)
          }
          return method === "tools/call" ? reply() : fetch(url, init);
        },
      });
      const lines: { id?: number; error?: { message?: string } }[] = [];
      stdout.on("data", (d: Buffer) => {
        for (const l of d.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(l));
      });
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } } })}\n`);
      await new Promise((r) => setTimeout(r, 300));
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "notes__notes_list", arguments: {} } })}\n`);
      const t0 = Date.now();
      while (!lines.some((l) => l.id === 2) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
      relay.stop();
      assert.equal(lines.find((l) => l.id === 2)?.error?.message, "bridge connection lost");
    }
  });
});
