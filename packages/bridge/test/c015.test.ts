/**
 * Bridge 0.1.15 (BRIDGE "v0.1.13 additions"): parts that need no manifest 0.1.8 helper — app-initiated companion
 * calls (C85), the reserved `tb.*` context namespace (G4b), the launch redirect re-check (C86).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { isValidLaunchPath } from "@opt2-tealbrick/manifest";
import { launchRedirect as redirectWith } from "../src/person.ts";

const launchRedirect = (product: string, location: string | undefined) => redirectWith(product, location, isValidLaunchPath);

import { AGT, CON, INS, makeWorld, type World } from "./support/world.ts";

describe("C86 launch redirect re-check", () => {
  test("keeps a redirect under the ticket's own /a/<product>/ that passes the path rule", () => {
    assert.equal(launchRedirect("notes", "/a/notes/board/7?tab=a"), "/a/notes/board/7?tab=a");
    assert.equal(launchRedirect("notes", "/a/notes"), "/a/notes/");
    assert.equal(launchRedirect("notes", "/a/notes/"), "/a/notes/");
    // a colon inside a same-origin path segment is not a scheme (the Location stays /a/notes/…): shared rule allows it
    assert.equal(launchRedirect("notes", "/a/notes/javascript:alert(1)"), "/a/notes/javascript:alert(1)");
  });
  test("anything doubtful falls back to /a/<product>/", () => {
    for (const bad of [
      undefined,
      "https://evil.example/a/notes/",
      "//evil.example/a/notes/",
      "/a/kanban/",
      "/a/notesx/",
      "/a/notes/../kanban/",
      "/a/notes/%2e%2e/kanban/",
      "/a/notes//evil.example",
      "/a/notes/x\\\\y",
      "/a/notes/%5Cevil",
      "/a/notes/x%0d%0aSet-Cookie:a",
      "/a/notes/%zz",
    ]) {
      assert.equal(launchRedirect("notes", bad), "/a/notes/", String(bad));
    }
  });
});

describe("G4b reserved tb.* context namespace", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true, withHook: true });
    await w.publish((c) => {
      // the owner switches the declared context hook on (C117: it is listed with enabled:false by default)
      c.hooks = c.hooks.filter((h) => h.hookId !== "enrich");
      c.hooks.push({ id: "guard.enrich", ins: c.hooks[0]?.ins as never, product: "guard", hookId: "enrich", phase: "context", order: 2, timeoutMs: 1000, match: { products: ["notes"] } } as never);
    });
  });
  after(async () => {
    await w.close();
  });

  const callNotesList = async (): Promise<string> => {
    const { CallRouter } = await import("../src/calls.ts");
    const { BridgeError } = await import("../src/util.ts");
    const { waitFor } = await import("./support/world.ts");
    await waitFor(() => !!w.bridge.ctx.table?.hooks.some((h) => h.phase === "context" && h.enabled !== false), 15000);
    const app = w.bridge.ctx.table?.apps.get(INS as never);
    const op = app?.ops.get("notes_list");
    assert.ok(app && op);
    try {
      await new CallRouter(w.bridge.ctx).route({ caller: { type: "agent", agt: AGT as never, con: CON as never }, target: { app, op }, input: {} as never });
      return "ok";
    } catch (e) {
      return e instanceof BridgeError ? e.code : String(e);
    }
  };

  test("a context hook writing its own namespace is accepted", async () => {
    w.hookMode.answer = (hook) => (hook === "enrich" ? { add: { "guard.level": "low" } } : undefined);
    assert.equal(await callNotesList(), "ok");
    const forwarded = w.appLog.ops.at(-1)?.body as { context?: Record<string, unknown> } | undefined;
    assert.equal(forwarded?.context?.["guard.level"], "low");
  });

  test("a context hook writing tb.* → hook_failed (fail closed), the app is not called", async () => {
    w.hookMode.answer = (hook) => (hook === "enrich" ? { add: { "tb.onBehalfOf": { claim: { kind: "person", id: "x" }, verified: true } } } : undefined);
    const ops = w.appLog.ops.length;
    assert.equal(await callNotesList(), "hook_failed");
    assert.equal(w.appLog.ops.length, ops);
    w.hookMode.answer = undefined;
  });
});

describe("C85 app-initiated companion calls", () => {
  let w: World;
  const events: { e: string; f: Record<string, unknown> }[] = [];
  const now = () => Math.floor(Date.now() / 1000);
  before(async () => {
    const quiet = () => undefined;
    w = await makeWorld({ real: true, logger: { info: (e: string, f?: Record<string, unknown>) => void events.push({ e, f: f ?? {} }), warn: quiet, error: quiet, debug: quiet } as never });
  });
  after(async () => {
    await w.close();
  });

  test("no parentCall → passes the pipeline, audited call.app_initiated; burst 30 then 429 rate_limited + Retry-After", async () => {
    const { APP_CODE, BRG, WS, waitFor } = await import("./support/world.ts");
    const appKey = await w.api.generateKeyPair();
    const claim = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.2" }),
    });
    assert.equal(claim.status, 200);
    const grant = await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read"], mode: "bound", held: ["money"], caps: {}, wf: ["notes_list"], polrev: 1 });
    const slice = await w.signPortal("tb-slice+jws", { v: 1, iss: "tb:portal", sub: `tb:ins:${INS}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 43200, jti: w.api.ulid(), ws: WS, rev: 2, ins: INS, product: "notes", grants: [grant] });
    await w.publish((c) => {
      (c.apps[0] as { slice: string }).slice = slice;
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev() && w.bridge.ctx.table?.apps.get(INS as never)?.down === false, 15000);
    const call = async () => {
      const body = Buffer.from(JSON.stringify({ target: "notes", op: "notes_list", input: {} }));
      const a = await w.api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: w.api.ulid() }, appKey, { method: "POST", pathAndQuery: "/tb/v1/call", body });
      return fetch(`${w.internalUrl}/tb/v1/call`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": a, "TB-Grant": grant }, body });
    };
    const first = await call();
    assert.equal(first.status, 200, await first.clone().text());
    assert.ok(events.some((x) => x.e === "call.app_initiated" && x.f.ins === INS && x.f.parentCall === null), "audited as app-initiated");
    let limited: Response | undefined;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await call();
      if (r.status === 429) limited = r;
      else await r.arrayBuffer();
    }
    assert.ok(limited, "rate limited within the burst");
    assert.equal((await limited.json()).error.code, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  });
});

describe("G4b relay: toolCallMeta is added to every tools/call", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  test("the claim reaches the bridge in params._meta; the relay's claim wins for its key (BRG-13) and the client's other _meta keys are kept; other methods untouched", async () => {
    const { PassThrough } = await import("node:stream");
    const { startRelay } = await import("@opt2-tealbrick/relay");
    const { BRG, waitFor } = await import("./support/world.ts");
    const sent: { method?: string; params?: { _meta?: Record<string, unknown> } }[] = [];
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const claim = { kind: "channel_sender", id: "slack:U024BE7LH", display: "Ann" };
    const relay = startRelay({
      api: w.api,
      bridgeUrl: w.publicUrl,
      connection: { con: CON as never, agt: AGT as never, bridgeId: BRG as never },
      signer: { sign: (i) => w.signRaw(i), publicJwk: () => w.agentKey.publicJwk },
      stdin,
      stdout,
      toolCallMeta: { "tealbrick/onBehalfOf": claim },
      fetch: async (url, init) => {
        if (String(url).endsWith("/mcp") && typeof init?.body === "string") sent.push(JSON.parse(init.body));
        return fetch(url, init);
      },
    });
    const lines: { id?: number }[] = [];
    stdout.on("data", (d: Buffer) => {
      for (const l of d.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(l));
    });
    const rpc = (m: object) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "relay-meta-test" } } });
    await waitFor(() => lines.some((l) => l.id === 1));
    rpc({ method: "notifications/initialized" });
    rpc({ id: 2, method: "tools/call", params: { name: "notes__notes_list", arguments: {} } });
    rpc({ id: 3, method: "tools/call", params: { name: "notes__notes_list", arguments: {}, _meta: { "tealbrick/onBehalfOf": { kind: "person", id: "own" }, "tealbrick/idempotencyKey": "retry-12345678" } } });
    try {
      await waitFor(() => lines.some((l) => l.id === 3) && lines.some((l) => l.id === 2));
      const calls = sent.filter((m) => m.method === "tools/call");
      assert.deepEqual(calls[0]?.params?._meta, { "tealbrick/onBehalfOf": claim });
      // BRG-13 / L13 (relay 0.1.0): the turn's sender claim cannot be replaced or dropped by the harness; its other keys stay
      assert.deepEqual(calls[1]?.params?._meta, { "tealbrick/onBehalfOf": claim, "tealbrick/idempotencyKey": "retry-12345678" }, "the relay's claim wins; the client's other keys are kept");
      assert.ok(!sent.some((m) => m.method !== "tools/call" && m.params?._meta), "other methods are forwarded unchanged");
    } finally {
      relay.stop();
    }
  });
});
