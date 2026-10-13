/**
 * Bridge limits (BSD-01, BSD-02, BSD-05, H-4, H-6, H-7, nosniff/HSTS): slow bodies, connection caps,
 * per-client limiters, MCP session/stream/rate/concurrency caps and capped app answers.
 */
// short body deadline for this file (read by readBody on every call)
process.env.TB_BODY_DEADLINE_MS = "800";

import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";
import { clientIp, RateLimiter, setProxyTrust } from "../src/util.ts";
import { AGT, APP_CODE, BRG, CON, INS, makeWorld, type World, waitFor } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CON_B = "con_01HBBBBBBBBBBBBBBBBBBBBBBB";
const CON_C = "con_01HCCCCCCCCCCCCCCCCCCCCCCC";
const CON_D = "con_01HDDDDDDDDDDDDDDDDDDDDDDD";
const CON_E = "con_01HEEEEEEEEEEEEEEEEEEEEEEE";
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "limits" } } };
const PING = { jsonrpc: "2.0", id: 2, method: "ping" };

const portOf = (url: string) => Number(new URL(url).port);

/** Raw HTTP exchange: writes `head`, collects everything until the server closes (or `untilHead`). */
function raw(port: number, head: string, o: { untilHead?: boolean } = {}): { socket: Socket; done: Promise<{ text: string; ms: number }> } {
  const started = Date.now();
  const socket = netConnect(port, "127.0.0.1");
  socket.write(head);
  const done = new Promise<{ text: string; ms: number }>((resolve) => {
    let text = "";
    const finish = () => resolve({ text, ms: Date.now() - started });
    socket.on("data", (c: Buffer) => {
      text += c.toString("utf8");
      if (o.untilHead && text.includes("\r\n\r\n")) finish();
    });
    socket.on("close", finish);
    socket.on("error", () => undefined);
  });
  return { socket, done };
}

const slowHead = (path: string, ip: string, length = 100) =>
  `POST ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/x-www-form-urlencoded\r\ncontent-length: ${length}\r\nx-forwarded-for: ${ip}\r\n\r\n`;

async function mcpPost(w: World, token: string, body: unknown, sid?: string): Promise<Response> {
  return fetch(`${w.publicUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
}

async function openSession(w: World, con: string) {
  const token = await w.agentTokenFor(AGT, con);
  assert.ok(token, `token for ${con}`);
  const r = await w.mcp(token, INIT);
  assert.equal(r.status, 200);
  return { token, sid: r.session as string };
}

const callBody = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });

describe("bridge limits (https public URL, short timeouts)", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({
      env: { TB_PUBLIC_URL: "https://127.0.0.1" },
      limits: { requestTimeoutMs: 1500, headersTimeoutMs: 1000, checkIntervalMs: 100 },
      extraConnections: [CON_B, CON_C, CON_D, CON_E],
    });
  });
  after(async () => {
    w.appOps.override = undefined;
    await w.close();
  });

  test("every public response carries nosniff, and HSTS when the public URL is https", async () => {
    for (const url of [`${w.publicUrl}/healthz`, `${w.publicUrl}/nothing-here`, `${w.keysUrl}/other`]) {
      const r = await fetch(url);
      await r.arrayBuffer();
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", url);
      assert.equal(r.headers.get("strict-transport-security"), "max-age=31536000", url);
    }
  });

  test("BSD-01: a body sent at 1 byte/s is cut at the deadline with 408 request_timeout and the socket closes", async () => {
    const { socket, done } = raw(portOf(w.publicUrl), slowHead("/oauth/revoke", "10.1.1.1"));
    const drip = setInterval(() => socket.writable && socket.write("a"), 1000);
    socket.write("a");
    const { text, ms } = await done;
    clearInterval(drip);
    assert.match(text, /^HTTP\/1\.1 408/);
    assert.match(text, /request_timeout/);
    assert.match(text, /connection: close/i);
    assert.ok(ms >= 700 && ms < 1500, `cut at the body deadline (${ms} ms)`);
  });

  test("BSD-01: the internal status long-poll still answers after the request timeout", async () => {
    const api = w.api;
    const appKey = await api.generateKeyPair();
    const claim = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.2" }),
    });
    assert.equal(claim.status, 200);
    const status = async (wait: number, sliceRevision: number, keysRev: number) => {
      const pathAndQuery = `/tb/v1/status?wait=${wait}`;
      const body = Buffer.from(JSON.stringify({ readiness: "ready", version: "1.0.0", sdkVersion: "0.1.2", scopesRev: 0, sliceRevision, keysRev, pendingHolds: 0 }));
      const assertion = await api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: api.ulid() }, appKey, { method: "POST", pathAndQuery, body });
      return fetch(`${w.internalUrl}${pathAndQuery}`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": assertion }, body });
    };
    const first = await status(0, -1, -1);
    assert.ok(first.status === 200 || first.status === 204);
    const cur = first.status === 200 ? ((await first.json()) as { sliceRevision: number; keysRev: number }) : { sliceRevision: -1, keysRev: -1 };
    const started = Date.now();
    const long = await status(3, cur.sliceRevision, cur.keysRev);
    assert.equal(long.status, 204, "nothing changed: 204 after the full wait");
    assert.ok(Date.now() - started >= 2500, "the long-poll held past the 1.5 s request timeout");
  });

  test("BSD-01: per-client limiter on the unauthenticated body routes (revoke, pair callback, key page, launch)", async () => {
    const form = { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.4.4.4" };
    const cases: [string, string][] = [
      [`${w.publicUrl}/oauth/revoke`, "token=x"],
      [`${w.publicUrl}/oauth/pair/callback`, "code=x"],
      [`${w.keysUrl}/keys`, "ticket=x"],
      [`${w.publicUrl}/a/notes/tb/launch`, "ticket=x"],
    ];
    for (const [url, body] of cases) {
      for (let i = 0; i < 30; i++) {
        const r = await fetch(url, { method: "POST", headers: form, body, redirect: "manual" });
        await r.arrayBuffer();
        assert.notEqual(r.status, 429, `${url} #${i + 1} within the limit`);
      }
      const over = await fetch(url, { method: "POST", headers: form, body, redirect: "manual" });
      await over.arrayBuffer();
      assert.equal(over.status, 429, `${url} over the per-client limit`);
      const other = await fetch(url, { method: "POST", headers: { ...form, "x-forwarded-for": "10.5.5.5" }, body, redirect: "manual" });
      await other.arrayBuffer();
      assert.notEqual(other.status, 429, `${url}: another client is not affected`);
    }
  });

  test("BSD-02: 40 initialize from one connection keep at most 16 sessions (least recently used evicted); ids are random 128-bit", async () => {
    const token = await w.agentTokenFor(AGT, CON_B);
    const sids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await w.mcp(token, INIT);
      assert.equal(r.status, 200, `initialize #${i + 1}`);
      sids.push(r.session as string);
    }
    assert.equal(new Set(sids).size, 40);
    for (const sid of sids) assert.match(sid, /^[A-Za-z0-9_-]{22}$/);
    await sleep(2500); // refill the POST bucket
    for (const sid of [sids[0], sids[10], sids[23]]) assert.equal((await w.mcp(token, PING, sid)).status, 404, "evicted");
    for (const sid of sids.slice(24)) assert.equal((await w.mcp(token, PING, sid)).status, 200, "one of the 16 most recent sessions");
  });

  test("H-4: a session is bound to its connection, not only to the agent", async () => {
    const a = await openSession(w, CON);
    const tokenE = await w.agentTokenFor(AGT, CON_E);
    assert.equal((await w.mcp(tokenE, PING, a.sid)).status, 404, "same agent, other connection: POST refused");
    const get = await fetch(`${w.publicUrl}/mcp`, { headers: { authorization: `Bearer ${tokenE}`, "mcp-session-id": a.sid } });
    assert.equal(get.status, 404);
    await get.arrayBuffer();
    const del = await fetch(`${w.publicUrl}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${tokenE}`, "mcp-session-id": a.sid } });
    assert.equal(del.status, 404);
    await del.arrayBuffer();
    assert.equal((await w.mcp(a.token, PING, a.sid)).status, 200, "the owner connection still uses it");
  });

  test("BSD-02: at most 2 GET streams per session (third → 429 rate_limited); streams outlive the request timeout", async () => {
    const s = await openSession(w, CON_E);
    const aborts: AbortController[] = [];
    const open = async () => {
      const ac = new AbortController();
      aborts.push(ac);
      return fetch(`${w.publicUrl}/mcp`, { headers: { authorization: `Bearer ${s.token}`, "mcp-session-id": s.sid }, signal: ac.signal });
    };
    try {
      const one = await open();
      const two = await open();
      assert.equal(one.status, 200);
      assert.equal(two.status, 200);
      const three = await open();
      assert.equal(three.status, 429);
      assert.equal(((await three.json()) as { error: { code: string } }).error.code, "rate_limited");
      assert.ok(three.headers.get("retry-after"));
      const reader = (one.body as ReadableStream<Uint8Array>).getReader();
      await reader.read(); // ": ok"
      await sleep(2200);
      const next = await Promise.race([reader.read().then((r) => (r.done ? "closed" : "data")), sleep(300).then(() => "open")]);
      assert.equal(next, "open", "an SSE stream is not cut by the 1.5 s request timeout");
    } finally {
      for (const ac of aborts) ac.abort();
    }
  });

  test("BSD-02: POST /mcp token bucket per connection → HTTP 429 rate_limited + Retry-After; another connection is not affected", async () => {
    const s = await openSession(w, CON_C);
    let limited: Response | undefined;
    for (let i = 0; i < 60 && !limited; i++) {
      const r = await mcpPost(w, s.token, PING, s.sid);
      if (r.status === 429) limited = r;
      else await r.arrayBuffer();
    }
    assert.ok(limited, "the burst is limited");
    assert.equal(((await limited.json()) as { error: { code: string } }).error.code, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    const other = await openSession(w, CON);
    assert.equal((await w.mcp(other.token, PING, other.sid)).status, 200);
  });

  test("BSD-02: at most 8 concurrent tools/call per connection (rate_limited result); another connection is not affected", async () => {
    const held: ServerResponse[] = [];
    w.appOps.override = (op, body, res) => {
      if (op !== "notes_list" || !(body.input as { hold?: boolean } | undefined)?.hold) return false;
      held.push(res);
      return true;
    };
    try {
      const s = await openSession(w, CON_D);
      const settled: any[] = [];
      const calls = Array.from({ length: 10 }, () =>
        w.mcp(s.token, callBody("notes__notes_list", { hold: true }), s.sid).then((r) => {
          settled.push(r.json.result);
          return r.json.result;
        }),
      );
      await waitFor(() => held.length === 8 && settled.length === 2, 5000);
      for (const r of settled) {
        assert.equal(r.isError, true);
        assert.equal(r.structuredContent.error.code, "rate_limited");
      }
      const o = await openSession(w, CON);
      const free = await w.mcp(o.token, callBody("notes__notes_list", { q: "free" }), o.sid);
      assert.equal(free.json.result.isError, undefined, "another connection still calls");
      for (const res of held) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", output: { done: true } }));
      const all = await Promise.all(calls);
      assert.equal(all.filter((r) => r.isError).length, 2);
      assert.equal(all.filter((r) => r.structuredContent?.done === true).length, 8);
      const again = await w.mcp(s.token, callBody("notes__notes_list", { q: "after" }), s.sid);
      assert.equal(again.json.result.isError, undefined, "slots are released");
    } finally {
      w.appOps.override = undefined;
    }
  });

  test("BSD-05: an app answering a huge body → payload_too_large; the bridge stays responsive", async () => {
    let written = 0;
    w.appOps.override = (op, body, res) => {
      if (op !== "notes_list" || !(body.input as { huge?: boolean } | undefined)?.huge) return false;
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(256 * 1024, 0x61);
      const pump = () => {
        while (written < 64 * 1024 * 1024 && !res.destroyed) {
          written += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("error", () => undefined);
      pump();
      return true;
    };
    try {
      const s = await openSession(w, CON);
      const started = Date.now();
      const r = await w.mcp(s.token, callBody("notes__notes_list", { huge: true }), s.sid);
      assert.equal(r.json.result.isError, true);
      assert.equal(r.json.result.structuredContent.error.code, "payload_too_large");
      assert.ok(Date.now() - started < 10_000);
      const ok = await w.mcp(s.token, callBody("notes__notes_list", { q: "after" }), s.sid);
      assert.equal(ok.json.result.isError, undefined, "next call works");
      const health = await fetch(`${w.publicUrl}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok" }, "BRIDGE §12: {status} only");
    } finally {
      w.appOps.override = undefined;
    }
  });

  test("H-7: an app cannot answer with a bridge verdict code, malformed codes or control characters", async () => {
    const answers: Record<string, { status: number; error: { code: string; message: string } }> = {
      verdict: { status: 403, error: { code: "paused", message: "paused by the owner" } },
      malformed: { status: 200, error: { code: "Bad-Code!", message: "x" } },
      app: { status: 409, error: { code: "scope_denied", message: "line1\u001b[31m\nline2\u202e" } },
    };
    w.appOps.override = (op, body, res) => {
      const kind = (body.input as { kind?: string } | undefined)?.kind;
      const a = kind ? answers[kind] : undefined;
      if (op !== "notes_list" || !a) return false;
      res.writeHead(a.status, { "content-type": "application/json" }).end(JSON.stringify({ error: a.error }));
      return true;
    };
    try {
      const s = await openSession(w, CON);
      const code = async (kind: string) => (await w.mcp(s.token, callBody("notes__notes_list", { kind }), s.sid)).json.result.structuredContent.error;
      assert.equal((await code("verdict")).code, "app_error");
      assert.equal((await code("malformed")).code, "app_error");
      const app = await code("app");
      assert.equal(app.code, "scope_denied", "a well-formed app code passes through");
      assert.doesNotMatch(app.message, /[\p{Cc}\u202e]/u);
    } finally {
      w.appOps.override = undefined;
    }
  });

  test("H-6: WebSocket upgrade strips client X-Forwarded-*, caps open upgrades per client", async () => {
    const port = portOf(w.publicUrl);
    const head = (ip: string) => `GET /a/notes/ HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: Upgrade\r\nupgrade: websocket\r\nx-forwarded-for: ${ip}\r\nx-forwarded-host: evil.example\r\n\r\n`;
    const first = raw(port, head("10.7.7.7"), { untilHead: true });
    const { text } = await first.done;
    assert.match(text, /^HTTP\/1\.1 101/);
    const seen = JSON.parse(Buffer.from(/x-seen: (\S+)/.exec(text)?.[1] ?? "", "base64url").toString("utf8")) as Record<string, string>;
    assert.equal(seen["x-forwarded-host"], "127.0.0.1", "the bridge's own host, not the client's");
    assert.equal(seen["x-forwarded-proto"], "https");
    assert.equal(seen["x-forwarded-for"], undefined);
    const open = [first.socket];
    try {
      for (let i = 1; i < 20; i++) {
        const u = raw(port, head("10.7.7.7"), { untilHead: true });
        open.push(u.socket);
        assert.match((await u.done).text, /^HTTP\/1\.1 101/);
      }
      const over = raw(port, head("10.7.7.7"), { untilHead: true });
      open.push(over.socket);
      assert.match((await over.done).text, /^HTTP\/1\.1 429/);
      const other = raw(port, head("10.8.8.8"), { untilHead: true });
      open.push(other.socket);
      assert.match((await other.done).text, /^HTTP\/1\.1 101/, "another client is not affected");
    } finally {
      for (const s of open) s.destroy();
    }
  });
});

describe("bridge limits: per-client open requests and connections", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ limits: { perClient: 3 } });
  });
  after(async () => {
    await w.close();
  });

  test("BSD-01: behind the edge proxy, open requests per client address are capped", async () => {
    const port = portOf(w.publicUrl);
    const slow = [0, 1, 2].map(() => raw(port, slowHead("/oauth/revoke", "10.2.2.2", 10)));
    try {
      await sleep(150);
      const over = await fetch(`${w.publicUrl}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.2.2.2" }, body: "token=x" });
      assert.equal(over.status, 429);
      assert.equal(((await over.json()) as { error: { code: string } }).error.code, "rate_limited");
      const other = await fetch(`${w.publicUrl}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.3.3.3" }, body: "token=x" });
      assert.equal(other.status, 200);
      await other.arrayBuffer();
    } finally {
      for (const s of slow) s.socket.destroy();
    }
    await sleep(100);
    const later = await fetch(`${w.publicUrl}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.2.2.2" }, body: "token=x" });
    assert.equal(later.status, 200, "released when the requests end");
    await later.arrayBuffer();
  });

  test("BSD-01: reached directly (own_infra / TB_TRUST_PROXY=0), open connections per address are capped and the public listener has maxConnections", async () => {
    assert.equal(w.bridge.publicServer.maxConnections, 2000);
    const port = portOf(w.publicUrl);
    setProxyTrust("own_infra", {});
    const socks: Socket[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const s = netConnect(port, "127.0.0.1");
        s.on("error", () => undefined);
        socks.push(s);
        await new Promise((r) => s.once("connect", r));
      }
      await sleep(50);
      const over = raw(port, "GET /healthz HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n");
      socks.push(over.socket);
      const { text } = await over.done;
      assert.equal(text, "", "the over-cap socket is closed without an answer");
    } finally {
      for (const s of socks) s.destroy();
      setProxyTrust("deployed", {});
    }
  });

  test("H-2: X-Forwarded-For is trusted only for the deployed form or TB_TRUST_PROXY=1", () => {
    const req = (xff?: string) => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: "10.0.0.9" } }) as never;
    try {
      assert.equal(setProxyTrust("deployed", {}), true);
      assert.equal(clientIp(req("1.2.3.4, 5.6.7.8")), "5.6.7.8", "rightmost entry (the edge appends)");
      assert.equal(setProxyTrust("own_infra", {}), false);
      assert.equal(clientIp(req("1.2.3.4")), "10.0.0.9", "own-infra default: the socket address, XFF ignored");
      assert.equal(setProxyTrust("own_infra", { TB_TRUST_PROXY: "1" }), true);
      assert.equal(setProxyTrust("deployed", { TB_TRUST_PROXY: "0" }), false);
    } finally {
      setProxyTrust("deployed", {});
    }
  });

  test("H-2: RateLimiter evicts oldest-first instead of clearing every bucket", () => {
    const l = new RateLimiter(1);
    assert.equal(l.take("busy"), true);
    assert.equal(l.take("busy"), false);
    for (let i = 0; i < 10_050; i++) l.take(`fresh-${i}`);
    l.take("busy-2");
    assert.equal(l.take("fresh-10049"), false, "recent buckets survive the eviction");
  });
});
