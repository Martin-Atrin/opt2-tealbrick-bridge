/**
 * F26 / L21 (real relay <-> real bridge, L2): the agent's MCP client hung when the bridge restarted mid-call, because
 * the relay wrote no answer for the in-flight request. Real path: real bridge (test world), the in-process relay from
 * `@opt2-tealbrick/relay`, the real MCP client from the same package. A call hangs in the app while the bridge restarts
 * underneath it: the RELAY must answer it with an error at once (not the client's timeout), and after a new
 * `initialize` (what `agent serve` does on reconnect) the next call must work.
 * Moved from the CLI repo's serve-restart.test.ts (C158). The `serveLoop` part has no public export; the CLI repo's
 * serve tests cover the loop against fakes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, test } from "node:test";
import { connectMcp, McpTimeoutError, startRelay } from "@opt2-tealbrick/relay";
import { AGT, BRG, CON, makeWorld, type World } from "./support/world.ts";

/**
 * Failure diagnostics (C171): the test bridge listens on 127.0.0.1 only (world default), so a failure is never a
 * neighbour taking the port. On failure print what the bridge saw on /oauth/token and who holds the ports.
 */
function diagnose(w: World, e: unknown): never {
  const lsof = (port: number) => {
    try {
      return execFileSync("lsof", ["-nP", `-i:${port}`], { encoding: "utf8", timeout: 5000 });
    } catch (err) {
      const x = err as { stdout?: string; code?: string; status?: number };
      return x.stdout || `(lsof gave no output: ${x.code ?? `exit ${x.status}`})`;
    }
  };
  console.error(
    [
      `relay-restart diagnostics: /oauth/token requests seen by the test bridge = ${w.publicRequests("/oauth/token")}, /mcp = ${w.publicRequests("/mcp")}`,
      `lsof -nP -i :${w.ports.public} (public)`,
      lsof(w.ports.public),
      `lsof -nP -i :${w.ports.internal} (internal)`,
      lsof(w.ports.internal),
    ].join("\n"),
  );
  throw e;
}

/** above the relay's 20 s /oauth/token bound: a stuck token request is answered by the relay, not by this timeout */
const CALL_TIMEOUT_MS = 25_000;

describe("the agent side survives a bridge restart mid-call (F26)", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    try {
      await w.close();
    } finally {
      // this test's own temp dir, also when close fails (world.close removes it too)
      if (w && basename(w.dataDir).startsWith("tb-bridge-test-")) rmSync(w.dataDir, { recursive: true, force: true });
    }
  });

  test("the in-flight call fails fast (the relay answers), a new initialize reconnects and the next call works", () => restartCase().catch((e) => diagnose(w, e)));

  async function restartCase(): Promise<void> {
    const toRelay = new PassThrough();
    const fromRelay = new PassThrough();
    const relay = startRelay({ api: w.api, bridgeUrl: w.publicUrl, connection: { con: CON as never, agt: AGT as never, bridgeId: BRG as never }, signer: { sign: (i) => w.signRaw(i), publicJwk: () => w.agentKey.publicJwk }, stdin: toRelay, stdout: fromRelay });
    const mcp = connectMcp({ streams: { input: fromRelay, output: toRelay }, callTimeoutMs: CALL_TIMEOUT_MS });
    await mcp.initialize("relay-restart-test");

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

    try {
      const started = Date.now();
      await assert.rejects(mcp.callTool("notes__notes_list", {}), "the lost call surfaced as an error (no silent hang)");
      const lostAfterMs = Date.now() - started;
      assert.ok(lostAfterMs < 10_000, `the RELAY answered the lost call (error after ${lostAfterMs} ms, client timeout is ${CALL_TIMEOUT_MS / 1000} s)`);
      for (let i = 0; i < 100 && !restarted; i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(restarted, "the bridge restarted mid-call");

      // what `agent serve` does after a failed poll: initialize again, then poll again (a few tries while the bridge comes up)
      let result: Awaited<ReturnType<typeof mcp.callTool>> | undefined;
      for (let i = 0; i < 20 && !result; i++) {
        try {
          await mcp.initialize("relay-restart-test");
          result = await mcp.callTool("notes__notes_list", {});
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      assert.ok(result, "the relay reconnected by itself and the next call was answered");
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result), /after the restart/);
    } finally {
      relay.stop();
      mcp.close();
      w.appOps.override = undefined;
    }
  }

  test("an MCP call with no answer at all fails after the per-call timeout (never waits forever)", async () => {
    const silent = new PassThrough();
    const sink = new PassThrough();
    const mcp = connectMcp({ streams: { input: silent, output: sink }, callTimeoutMs: 150 });
    await assert.rejects(mcp.callTool("x__y", {}), (e) => e instanceof McpTimeoutError);
    mcp.close();
  });

  test("the relay answers a request whose response carries no answer for it (empty stream / 202)", () => noAnswerCase().catch((e) => diagnose(w, e)));

  async function noAnswerCase(): Promise<void> {
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
  }
});
