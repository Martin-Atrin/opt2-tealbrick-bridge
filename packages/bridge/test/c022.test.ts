/**
 * Bridge 0.1.22 (C117, BRIDGE v0.1.24) REAL-to-REAL (L2): a real Rules-like SDK app declares a `before` hook on the
 * real target app. A matching declared hook is NEVER skipped silently:
 *  - listed (enabled) → it runs and its refusal applies;
 *  - declared but ABSENT from config.hooks (old Core during an app update) → hook_failed, the target op never runs;
 *  - the hook app is updated (new manifest digest not fetchable yet) and the config omits the hook → still hook_failed;
 *  - listed with enabled:false (the owner's switch) → skipped, the call is forwarded.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { buildStatusReport } from "../src/portal.ts";
import { freePort, type RealSdkApp, startRealSdkApp } from "./support/sdk-app.ts";
import { makeWorld, type World, waitFor } from "./support/world.ts";

const RULESINS = "ins_01HK0RVQESRVQESRVQESRVQESR";
const PAYINS = "ins_01HK0PAYTGTPAYTGTPAYTGTPAY";

describe("C117: declared hooks fail closed (real Rules-like hook app + real target app)", () => {
  let w: World;
  let rules: RealSdkApp;
  let pay: RealSdkApp;
  let payCalls = 0;
  let gateCalls = 0;

  before(async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    w = await makeWorld({ real: true, extraOwnInfraOrigins: [`http://127.0.0.1:${p1}`, `http://127.0.0.1:${p2}`] });
    pay = await startRealSdkApp(w, {
      ins: PAYINS,
      product: "samplepay",
      code: "tbe_hooktargetpayapp0001",
      port: p1,
      operations: [{ id: "pay_list", title: "pay_list", description: "List payments", input: { type: "object" }, output: { type: "object" }, crud: ["read"], effect: "read", idempotency: "supported", receipt: false, audience: "agent" }],
      handlers: {
        pay_list: async () => {
          payCalls += 1;
          return { items: [] };
        },
      },
      agentGrantCrud: ["read"],
    });
    rules = await startRealSdkApp(w, {
      ins: RULESINS,
      product: "rulesx",
      code: "tbe_hookrulesappcode0001",
      port: p2,
      operations: [{ id: "rule_list", title: "rule_list", description: "List rules", input: { type: "object" }, output: { type: "object" }, crud: ["read"], effect: "read", idempotency: "supported", receipt: false, audience: "agent" }],
      handlers: { rule_list: async () => ({ items: [] }) },
      hooks: [{ id: "rules_gate", title: "Rules gate", phase: "before", order: 0, match: { products: ["samplepay"] }, timeoutMs: 1000 }],
      hookHandlers: {
        rules_gate: async () => {
          gateCalls += 1;
          return { allow: false, reason: "denied by the probe rule" };
        },
      },
    });
  });
  after(async () => {
    await rules?.stop();
    await pay?.stop();
    await w?.close();
  });

  const entry = (enabled?: boolean) => ({ id: "rulesx.rules_gate", ins: RULESINS, product: "rulesx", hookId: "rules_gate", phase: "before", order: 0, timeoutMs: 1000, match: { products: ["samplepay"] }, ...(enabled === undefined ? {} : { enabled }) });
  const setHooks = async (hooks: unknown[], tweak?: (c: Record<string, any>) => void) => {
    await w.amend((c) => {
      (c as { hooks: unknown[] }).hooks = hooks;
      tweak?.(c as never);
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
  };
  const callPay = async () => {
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    return (await w.mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "samplepay__pay_list", arguments: {} } }, init.session as string)).json.result as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
  };

  test("listed + enabled: the real hook runs and its refusal applies", async () => {
    await setHooks([entry()]);
    const [p, g] = [payCalls, gateCalls];
    const r = await callPay();
    assert.equal(r.isError, true);
    assert.equal(gateCalls, g + 1, "the hook ran");
    assert.equal(payCalls, p, "the target op did not run");
  });

  test("declared but absent from config.hooks (old Core during an update): hook_failed, never forwarded, reported", async () => {
    await setHooks([]);
    const [p, g] = [payCalls, gateCalls];
    const r = await callPay();
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent?.error?.code, "hook_failed");
    assert.equal(payCalls, p, "fail closed: the target op did not run");
    assert.equal(gateCalls, g);
    assert.ok(buildStatusReport(w.bridge.ctx).rejected.some((x) => x.kind === "config" && x.code === "hook_not_listed" && x.ins === RULESINS));
  });

  test("the hook app is updated (new digest, manifest not fetchable yet) and the hook is omitted: still hook_failed", async () => {
    await setHooks([], (c) => {
      const e = (c.apps as { ins: string; manifestDigest: string; version: string }[]).find((a) => a.ins === RULESINS);
      if (e) {
        e.manifestDigest = `sha256:${"ab".repeat(32)}`;
        e.version = "9.9.9";
      }
    });
    assert.equal(w.bridge.ctx.table?.apps.get(RULESINS as never)?.down, true, "the updated app's manifest is not fetched yet");
    const p = payCalls;
    const r = await callPay();
    assert.equal(r.structuredContent?.error?.code, "hook_failed");
    assert.equal(payCalls, p);
    // back to the served release
    await setHooks([entry()], (c) => {
      const e = (c.apps as { ins: string; manifestDigest: string; version: string }[]).find((a) => a.ins === RULESINS);
      if (e) {
        e.manifestDigest = rules.digest;
        e.version = "1.0.0";
      }
    });
    await waitFor(() => w.bridge.ctx.table?.apps.get(RULESINS as never)?.down === false, 15000);
  });

  test("listed with enabled:false (the owner's switch): skipped, the call is forwarded", async () => {
    await setHooks([entry(false)]);
    const [p, g] = [payCalls, gateCalls];
    const r = await callPay();
    assert.notEqual(r.isError, true, JSON.stringify(r.structuredContent));
    assert.equal(payCalls, p + 1);
    assert.equal(gateCalls, g, "a disabled hook is not called");
  });
});
