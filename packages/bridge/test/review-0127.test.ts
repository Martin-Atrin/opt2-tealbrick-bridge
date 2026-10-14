/**
 * Bridge 0.1.27 code-review fixes (REVIEW-CODE-QUALITY 2026-10-14):
 *  - BRG-12 (L31): the one-time claim code is reserved before the first await. Two parallel claims with one code →
 *    exactly one succeeds, the other is refused `code_invalid`; a failed claim releases the code (a retry succeeds).
 *  - BRG-28: ONE hook comparator (phase, `order`, product id, hook id by code unit, never locale); a failed or
 *    timed-out hook is labelled `result="failed"` / `"timeout"` in tb_bridge_hook_calls_total (L34: and `done` when
 *    it answers).
 *  - BRG-29: the internal listener binds `::` in the deployed form (Railway private network, as before), 127.0.0.1
 *    on own infrastructure, and TB_INTERNAL_HOST when set.
 * BRG-09 (config swap during a call) is in brg09-hook-swap.test.ts (real SDK hook app).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HookEntry } from "@opt2-tealbrick/spec/bridge";
import { buildStatusReport } from "../src/portal.ts";
import { internalListenHost } from "../src/server.ts";
import { compareHooks } from "../src/table.ts";
import { freePort } from "./support/sdk-app.ts";
import { hookManifest, makeWorld, type World, waitFor } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);
const NINS = "ins_01HK0NBRNBRNBRNBRNBRNBRNBR";
const NCODE = "tbe_brg12neighbourclaimcode01";

const boundHost = (w: World) => (w.bridge.internalServer.address() as AddressInfo).address;

describe("BRG-12: a one-time claim code is consumed once, even by parallel claims", () => {
  let w: World;
  let neighbour: Server;
  let port = 0;
  let manifestFetches = 0;
  /** manifest answers wait for this (both claims are inside the bridge's await) */
  let release: (() => void) | undefined;
  let held: Promise<void> = Promise.resolve();
  let serveBroken = false;

  before(async () => {
    port = await freePort();
    neighbour = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== "/tb/v1/manifest") return void res.writeHead(404).end();
      manifestFetches += 1;
      void held.then(() => {
        if (serveBroken) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...hookManifest, version: "9.9.9" }));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(hookManifest));
      });
    });
    await new Promise<void>((r) => neighbour.listen(port, "127.0.0.1", r));
    w = await makeWorld({ real: true, formDefaultHosts: true, extraOwnInfraOrigins: [`http://127.0.0.1:${port}`] });
    await w.amend((c) => {
      c.enrolCodes.push({ digest: w.api.opaqueDigest(NCODE), kind: "neighbour", ins: NINS as never, product: "guard", exp: now() + 3600 } as never);
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
  });
  after(async () => {
    await w?.close();
    await new Promise((r) => neighbour?.close(r));
  });

  const claim = async () => {
    const key = await w.api.generateKeyPair();
    const res = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: NCODE, instancePublicKey: key.publicJwk, manifestDigest: w.api.manifestDigest(hookManifest as never), version: "1.0.0", sdkVersion: "1.0.0", internalUrl: `http://127.0.0.1:${port}` }),
    });
    return { status: res.status, body: (await res.json()) as { ins?: string; error?: { code?: string } }, jwk: key.publicJwk };
  };
  const hold = () => {
    held = new Promise<void>((r) => {
      release = r;
    });
  };
  const neighbourClaims = () => w.bridge.ctx.state.claims.filter((c) => c.ins === NINS);

  test("deployed form (default): the internal listener binds `::` as before (Railway private network)", () => {
    assert.ok(["::", "0.0.0.0"].includes(boundHost(w)), `bound ${boundHost(w)}`);
    if (boundHost(w) === "0.0.0.0") assert.equal(internalListenHost("deployed", {}).host, "::", "0.0.0.0 only as Node's fallback without IPv6");
  });

  test("a failed claim releases the reservation: a retry with the same code succeeds (single claim, quiet case)", async () => {
    serveBroken = true;
    const bad = await claim();
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error?.code, "manifest_mismatch");
    assert.equal(neighbourClaims().length, 0, "nothing recorded");
    serveBroken = false;
    const ok = await claim();
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ins, NINS);
    assert.equal(neighbourClaims().length, 1);
    // and the code is now consumed
    const again = await claim();
    assert.equal(again.status, 403);
    assert.equal(again.body.error?.code, "code_invalid");
  });

  test("two parallel claims with one code: exactly one succeeds, the other is refused code_invalid", async () => {
    // a fresh code for this case
    const CODE2 = "tbe_brg12neighbourclaimcode02";
    const NINS2 = "ins_01HK0NBRNBRNBRNBRNBRNBRNB2";
    await w.amend((c) => {
      c.enrolCodes.push({ digest: w.api.opaqueDigest(CODE2), kind: "neighbour", ins: NINS2 as never, product: "guard", exp: now() + 3600 } as never);
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
    const claim2 = async () => {
      const key = await w.api.generateKeyPair();
      const res = await fetch(`${w.internalUrl}/tb/v1/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: CODE2, instancePublicKey: key.publicJwk, manifestDigest: w.api.manifestDigest(hookManifest as never), version: "1.0.0", sdkVersion: "1.0.0", internalUrl: `http://127.0.0.1:${port}` }),
      });
      return { status: res.status, body: (await res.json()) as { ins?: string; error?: { code?: string } } };
    };
    hold();
    const fetchesBefore = manifestFetches;
    const first = claim2();
    // the first claim is inside its manifest fetch (the await between the code check and the record)
    await waitFor(() => manifestFetches === fetchesBefore + 1, 5000);
    const second = await claim2();
    release?.();
    const r1 = await first;
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(second.status, 403, JSON.stringify(second.body));
    assert.equal(second.body.error?.code, "code_invalid");
    assert.equal(manifestFetches, fetchesBefore + 1, "the second claim was refused before any fetch");
    assert.equal(w.bridge.ctx.state.claims.filter((c) => c.ins === NINS2).length, 1, "one claim record");
    assert.ok(buildStatusReport(w.bridge.ctx).rejected.some((x) => x.kind === "claim" && x.code === "code_invalid"));
  });
});

describe("BRG-28: one hook order, independent of the locale", () => {
  const h = (phase: string, order: number, product: string, hookId = "h") => ({ id: `${product}.${hookId}`, ins: "ins_x", product, hookId, phase, order, timeoutMs: 1000, match: { products: ["*"] } }) as unknown as HookEntry;
  const ids = (list: HookEntry[]) => list.map((x) => `${x.phase}:${x.order}:${x.product}.${x.hookId}`);

  test("phase, then order, then product id, then hook id (code-unit order)", () => {
    const list = [h("after", 0, "za"), h("before", 1, "ka"), h("context", -1, "ya"), h("before", 0, "ya"), h("before", 0, "ia", "b"), h("before", 0, "ia", "a"), h("before", 0, "sa")];
    assert.deepEqual(ids([...list].sort(compareHooks)), ["before:0:ia.a", "before:0:ia.b", "before:0:sa.h", "before:0:ya.h", "before:1:ka.h", "context:-1:ya.h", "after:0:za.h"]);
    assert.deepEqual(ids([...list].reverse().sort(compareHooks)), ids([...list].sort(compareHooks)), "a total order: the input order does not matter");
  });

  test("the same order under en-US, lt-LT and et-EE (localeCompare would differ)", () => {
    const table = fileURLToPath(new URL("../src/table.ts", import.meta.url));
    const script = `import { compareHooks } from ${JSON.stringify(table)};
const ps = ["ka", "ya", "ia", "za", "sa"];
const hooks = ps.map((product) => ({ product, hookId: "h", phase: "before", order: 0 }));
console.log(JSON.stringify({ ours: [...hooks].sort(compareHooks).map((x) => x.product), locale: [...ps].sort((a, b) => a.localeCompare(b)) }));`;
    const runs = ["en_US", "lt_LT", "et_EE"].map((l) => {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, LC_ALL: `${l}.UTF-8`, LANG: `${l}.UTF-8` }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout) as { ours: string[]; locale: string[] };
    });
    for (const r of runs) assert.deepEqual(r.ours, ["ia", "ka", "sa", "ya", "za"]);
    // the alarm side (L34): the locales really differ, so a localeCompare tie-break would have changed the chain
    assert.notDeepEqual(runs[0]?.locale, runs[1]?.locale, "lt-LT collates y before k");
    assert.notDeepEqual(runs[0]?.locale, runs[2]?.locale, "et-EE collates z before y");
  });
});

describe("BRG-28: tb_bridge_hook_calls_total labels a failed or timed-out hook", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true, withHook: true });
  });
  after(async () => {
    w.hookMode.mode = "allow";
    w.hookMode.answer = undefined;
    await w?.close();
  });

  const callNotes = async () => {
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    return (await w.mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "notes__notes_list", arguments: {} } }, init.session as string)).json.result as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
  };
  const hookCount = async (result: string): Promise<number> => {
    const text = await (await fetch(`${w.internalUrl}/metrics`)).text();
    const m = new RegExp(`^tb_bridge_hook_calls_total\\{hook="guard\\.check",result="${result}"\\} (\\d+)$`, "m").exec(text);
    return m ? Number(m[1]) : 0;
  };

  test("an answering hook counts done, never failed (quiet case)", async () => {
    w.hookMode.mode = "allow";
    const [done, failed] = [await hookCount("done"), await hookCount("failed")];
    const r = await callNotes();
    assert.notEqual(r.isError, true, JSON.stringify(r.structuredContent));
    assert.equal(await hookCount("done"), done + 1);
    assert.equal(await hookCount("failed"), failed);
    assert.equal(await hookCount("timeout"), 0);
  });

  test("a hook that answers HTTP 500 counts failed (the call is refused hook_failed)", async () => {
    w.hookMode.mode = "fail";
    const [done, failed] = [await hookCount("done"), await hookCount("failed")];
    const r = await callNotes();
    w.hookMode.mode = "allow";
    assert.equal(r.structuredContent?.error?.code, "hook_failed");
    assert.equal(await hookCount("failed"), failed + 1);
    assert.equal(await hookCount("done"), done, "not labelled done");
  });

  test("a hook with a bad answer counts failed", async () => {
    w.hookMode.answer = () => ({ nope: true });
    const failed = await hookCount("failed");
    const r = await callNotes();
    w.hookMode.answer = undefined;
    assert.equal(r.structuredContent?.error?.code, "hook_failed");
    assert.equal(await hookCount("failed"), failed + 1);
  });

  test("a hook slower than its timeout counts timeout", async () => {
    // the world lists guard.check with timeoutMs 1000
    w.hookMode.answer = () => new Promise((r) => setTimeout(() => r({ allow: true }), 1500));
    const [done, timeouts] = [await hookCount("done"), await hookCount("timeout")];
    const r = await callNotes();
    w.hookMode.answer = undefined;
    assert.equal(r.structuredContent?.error?.code, "hook_failed");
    assert.equal(await hookCount("timeout"), timeouts + 1);
    assert.equal(await hookCount("done"), done, "not labelled done");
  });
});

describe("BRG-29: the internal listener's address per form", () => {
  test("internalListenHost: deployed `::`, own_infra 127.0.0.1, TB_INTERNAL_HOST wins", () => {
    assert.deepEqual(internalListenHost("deployed", {}), { host: "::", explicit: false });
    assert.deepEqual(internalListenHost("own_infra", {}), { host: "127.0.0.1", explicit: false });
    assert.deepEqual(internalListenHost("own_infra", { TB_INTERNAL_HOST: "10.0.0.5" }), { host: "10.0.0.5", explicit: true });
    assert.deepEqual(internalListenHost("deployed", { TB_INTERNAL_HOST: " 127.0.0.1 " }), { host: "127.0.0.1", explicit: true });
    assert.deepEqual(internalListenHost("own_infra", { TB_INTERNAL_HOST: "" }), { host: "127.0.0.1", explicit: false }, "empty = unset");
  });

  test("own_infra: bound to 127.0.0.1 (never every interface), advertised as 127.0.0.1, reachable there", async () => {
    const w = await makeWorld({ real: true, form: "own_infra", formDefaultHosts: true });
    try {
      assert.equal(boundHost(w), "127.0.0.1");
      assert.match(w.bridge.ctx.internalUrl, /^http:\/\/127\.0\.0\.1:\d+$/, "advertised as the bound address (tests listen on port 0)");
      const res = await fetch(`${w.internalUrl}/metrics`);
      assert.equal(res.status, 200);
    } finally {
      await w.close();
    }
  });

  test("deployed with TB_INTERNAL_HOST: bound to exactly that address", async () => {
    const w = await makeWorld({ real: true, env: { TB_INTERNAL_HOST: "127.0.0.1" } });
    try {
      assert.equal(boundHost(w), "127.0.0.1");
    } finally {
      await w.close();
    }
  });
});
