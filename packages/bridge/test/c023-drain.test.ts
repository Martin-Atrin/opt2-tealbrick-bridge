/**
 * Bridge 0.1.23 (F57a, L21: a restart is invisible). REAL process: the bridge runs as its own Node process (the test
 * harness entry, same signal wiring as the deployed image) and gets a real SIGTERM. In flight → completes once; new
 * agent and companion calls during the drain → `temporarily_unavailable` + Retry-After, nothing runs; the CLI relay
 * re-sends across the restart gap and the call runs once on the NEW instance; /readyz says draining; exit 0.
 * At the drain bound every open request id is answered (agent and companion), and such a call is never re-sent.
 * L34: the drain signal stays quiet when the bridge is not draining, and the relay re-sends nothing else.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type RunningRelay, startRelay } from "@opt2-tealbrick/relay";
import { AGT, APP_CODE, BRG, CON, INS, makeWorld, type World, WS, waitFor } from "./support/world.ts";

const ENTRY = resolve(fileURLToPath(new URL("../../bridge-server/test/conformance-entry.ts", import.meta.url)));
const now = () => Math.floor(Date.now() / 1000);
type Line = { id?: number | string; result?: { isError?: boolean; content?: { text?: string }[]; structuredContent?: { error?: { code?: string; message?: string } } }; error?: unknown };

/** a CLI relay (stdio) on the world's bridge; collects answers by id */
function relayOn(w: World): { relay: RunningRelay; lines: Line[]; events: { event: string; fields: Record<string, unknown> }[]; rpc(m: object): void; answer(id: number): Line | undefined } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const relay = startRelay({ api: w.api, bridgeUrl: w.publicUrl, connection: { con: CON as never, agt: AGT as never, bridgeId: BRG as never }, signer: { sign: (i) => w.signRaw(i), publicJwk: () => w.agentKey.publicJwk }, stdin, stdout, onEvent: (event, fields) => events.push({ event, fields }) });
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const lines: Line[] = [];
  let buf = "";
  stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const l of parts.filter(Boolean)) lines.push(JSON.parse(l) as Line);
  });
  const rpc = (m: object) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  return { relay, lines, events, rpc, answer: (id) => lines.find((l) => l.id === id) };
}

async function initRelay(r: ReturnType<typeof relayOn>): Promise<void> {
  r.rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drain-test" } } });
  await waitFor(() => !!r.answer(1));
  r.rpc({ method: "notifications/initialized" });
}

/** notes_list answers after `ms` for the tags in `slow` (the test's app); every call is recorded by tag */
function slowApp(w: World, slow: Record<string, number>): string[] {
  const calls: string[] = [];
  w.appOps.override = (op, b, res) => {
    if (op !== "notes_list") return false;
    const tag = String((b.input as { tag?: string } | undefined)?.tag ?? "");
    calls.push(tag);
    const end = () => {
      if (!res.writableEnded) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", output: { done: tag } }));
    };
    if (slow[tag]) setTimeout(end, slow[tag]);
    else end();
    return true;
  };
  return calls;
}

const codeOf = (l: Line | undefined) => l?.result?.structuredContent?.error?.code;

describe("F57a (real process): SIGTERM drains — in-flight calls finish, new calls run once on the new instance", () => {
  let w: World;
  let child: ChildProcess | undefined;
  const out: string[] = [];
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    // only our own child, by its pid (L20); a stop is done only when it is gone (L28)
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((r) => child?.once("exit", r));
    }
    w.appOps.override = undefined;
    await w.close();
  });

  test("L34 quiet: not draining → no Retry-After, /readyz ready, and the relay never re-sends a failed call", async () => {
    const calls = slowApp(w, {});
    w.appOps.override = ((inner) => (op: string, b: Record<string, unknown>, res: ServerResponse) => {
      if (op === "notes_list" && (b.input as { tag?: string } | undefined)?.tag === "fails") {
        calls.push("fails");
        res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "temporarily_unavailable", message: "app busy" } }));
        return true;
      }
      return inner?.(op, b, res) ?? false;
    })(w.appOps.override);
    assert.equal((await fetch(`${w.publicUrl}/readyz`)).status, 200);
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "q" } } });
    const ok = await fetch(`${w.publicUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "mcp-session-id": init.session as string }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "notes__notes_list", arguments: { tag: "quiet" } } }) });
    assert.equal(ok.headers.get("retry-after"), null, "no Retry-After outside a drain");
    assert.notEqual(((await ok.json()) as { result: { isError?: boolean } }).result.isError, true);
    // an app answering with a look-alike code (no bridge drain, no Retry-After) is passed through once, never re-sent
    const r = relayOn(w);
    await initRelay(r);
    r.rpc({ id: 3, method: "tools/call", params: { name: "notes__notes_list", arguments: { tag: "fails" } } });
    await waitFor(() => !!r.answer(3));
    assert.equal(r.answer(3)?.result?.isError, true);
    await new Promise((res) => setTimeout(res, 2_500));
    assert.equal(calls.filter((t) => t === "fails").length, 1, "the relay re-sends only drain refusals");
    assert.deepEqual(r.events, [], "F72 quiet: no retry line without a drain");
    r.relay.stop();
  });

  test("SIGTERM to the real process: slow call completes once; calls during the drain are refused retryably and the relay's call runs once after the restart", async () => {
    const calls = slowApp(w, { slow: 1_500 });
    // the in-process bridge hands its volume and ports to a real process
    await w.bridge.stop();
    const roots = w.keySet.root ? { TBCONF_PORTAL_ROOT_KEYS: JSON.stringify([w.keySet.root.publicJwk]) } : {};
    child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, ...w.bridgeEnv(), PORT: String(w.ports.public), TB_INTERNAL_PORT: String(w.ports.internal), ...roots }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((r) => child?.once("exit", (code) => r(code)));
    child.stdout?.on("data", (d: Buffer) => out.push(d.toString()));
    child.stderr?.on("data", (d: Buffer) => out.push(d.toString()));
    await waitFor(() => out.join("").includes("bridge.listening"), 20_000);
    assert.equal((await fetch(`${w.publicUrl}/readyz`)).status, 200, out.join(""));

    const r = relayOn(w);
    await initRelay(r);
    // 1. a slow call is in flight
    r.rpc({ id: 10, method: "tools/call", params: { name: "notes__notes_list", arguments: { tag: "slow" } } });
    await waitFor(() => calls.includes("slow"));
    // 2. a real SIGTERM to our own child
    process.kill(child.pid as number, "SIGTERM");
    await waitFor(() => out.join("").includes("bridge.draining"));
    const ready = await fetch(`${w.publicUrl}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal(((await ready.json()) as { status: string }).status, "draining");
    // a direct MCP client: retryable code + Retry-After, nothing runs
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d" } } });
    const direct = await fetch(`${w.publicUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "mcp-session-id": init.session as string }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "notes__notes_list", arguments: { tag: "direct" } } }) });
    assert.equal(direct.headers.get("retry-after"), "2");
    const dj = (await direct.json()) as { id: number; result: { isError: boolean; structuredContent: { error: { code: string } } } };
    assert.equal(dj.id, 5);
    assert.equal(dj.result.isError, true);
    assert.equal(dj.result.structuredContent.error.code, "temporarily_unavailable");
    // a companion call: 503 + Retry-After, nothing runs
    const comp = await fetch(`${w.internalUrl}/tb/v1/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "notes", op: "notes_list", input: { tag: "companion" } }) });
    assert.equal(comp.status, 503);
    assert.equal(comp.headers.get("retry-after"), "2");
    assert.equal(((await comp.json()) as { error: { code: string } }).error.code, "temporarily_unavailable");
    // 3. a relay call arriving during the drain
    r.rpc({ id: 11, method: "tools/call", params: { name: "notes__notes_list", arguments: { tag: "late" } } });
    // 4. the process drains (the slow call is answered), exits 0 and is gone
    assert.equal(await exited, 0, out.join(""));
    assert.throws(() => process.kill(child?.pid as number, 0), "the process is gone");
    const drained = out
      .join("")
      .split("\n")
      .find((l) => l.includes('"bridge.drained"'));
    assert.ok(drained, out.join(""));
    assert.match(drained, /"aborted":0/);
    assert.ok(!!r.answer(10), "the in-flight call was answered before exit");
    assert.notEqual(r.answer(10)?.result?.isError, true, JSON.stringify(r.answer(10)));
    assert.equal(r.answer(11), undefined, "the refused relay call waits for the new instance");
    // 5. the gap (nothing listens), then the new instance on the same volume and ports
    await new Promise((res) => setTimeout(res, 2_500));
    await w.restart();
    await waitFor(() => !!r.answer(11), 30_000);
    assert.notEqual(r.answer(11)?.result?.isError, true, JSON.stringify(r.answer(11)));
    // F72: every re-send is one visible line (tool name, code, Retry-After, attempt), never the arguments
    const first = r.events[0];
    assert.equal(first?.event, "relay.retry");
    assert.deepEqual(first?.fields, { tool: "notes__notes_list", attempt: 1, code: "temporarily_unavailable", retryAfter: 2 });
    assert.ok(r.events.every((e) => e.event === "relay.retry" && !JSON.stringify(e.fields).includes("late")), JSON.stringify(r.events));
    assert.deepEqual(
      calls.filter((t) => t !== "quiet"),
      ["slow", "late"],
      "the slow call ran once; refused calls never ran; the relay's call ran once, on the new instance",
    );
    r.relay.stop();
  });
});

describe("F57a: the drain bound — every open request id is answered (agent and companion), never re-sent", () => {
  let w: World;
  let appKey: Awaited<ReturnType<World["api"]["generateKeyPair"]>>;
  let grant: string;
  before(async () => {
    w = await makeWorld({ real: true });
    appKey = await w.api.generateKeyPair();
    const claim = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.2" }),
    });
    assert.equal(claim.status, 200);
    grant = await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read"], mode: "bound", held: ["money"], caps: {}, wf: ["notes_list"], polrev: 1 });
    const slice = await w.signPortal("tb-slice+jws", { v: 1, iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 43200, jti: w.api.ulid(), ws: WS, rev: 2, ins: INS, product: "notes", grants: [grant] });
    await w.publish((c) => {
      (c.apps[0] as { slice: string }).slice = slice;
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && w.bridge.ctx.table?.apps.get(INS as never)?.down === false, 15000);
  });
  after(async () => {
    w.appOps.override = undefined;
    await w.close();
  });

  test("calls still running at the bound are cut off and answered app_unavailable (outcome unknown); the relay does not re-send them", async () => {
    const calls = slowApp(w, { stuck: 20_000, stuckc: 20_000 });
    const r = relayOn(w);
    await initRelay(r);
    r.rpc({ id: 7, method: "tools/call", params: { name: "notes__notes_list", arguments: { tag: "stuck" } } });
    const raw = Buffer.from(JSON.stringify({ target: "notes", op: "notes_list", input: { tag: "stuckc" } }));
    const a = await w.api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: w.api.ulid() }, appKey, { method: "POST", pathAndQuery: "/tb/v1/call", body: raw });
    const companion = fetch(`${w.internalUrl}/tb/v1/call`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": a, "TB-Grant": grant }, body: raw });
    await waitFor(() => calls.includes("stuck") && calls.includes("stuckc"));
    const t0 = Date.now();
    const d = await w.bridge.drain(500);
    assert.equal(d.aborted, 2, "L34 fires: both running calls were cut off at the bound");
    assert.ok(Date.now() - t0 < 5_000, "the bound holds");
    const c = await companion;
    assert.equal(c.status, 503);
    const cj = (await c.json()) as { error: { code: string; message: string } };
    assert.equal(cj.error.code, "app_unavailable");
    assert.match(cj.error.message, /outcome is unknown/);
    await waitFor(() => !!r.answer(7));
    assert.equal(r.answer(7)?.result?.isError, true);
    assert.equal(codeOf(r.answer(7)), "app_unavailable");
    await w.restart();
    await new Promise((res) => setTimeout(res, 3_000));
    assert.equal(calls.filter((t) => t === "stuck").length, 1, "a cut-off call is never re-sent (it may have run)");
    assert.deepEqual(r.events, [], "no retry line for a cut-off call");
    r.relay.stop();
  });
});
