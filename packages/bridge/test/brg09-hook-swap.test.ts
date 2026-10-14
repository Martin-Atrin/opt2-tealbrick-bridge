/**
 * Bridge 0.1.27 BRG-09 (C117, L33) REAL-to-REAL (L2): a real Rules-like SDK app declares a `before` hook and an
 * `after` hook (it redacts the output) on a real target app. While the before hook runs, the bridge's table is
 * swapped (ctx.swapTable, the step applyConfig ends with; a config pull is paced at ~5 s, longer than a hook):
 *  - the new config DROPS the declared after hook → the call is refused `hook_failed` before it is forwarded
 *    (the target op never runs, the after hook never runs, the status report names `hook_not_listed`);
 *  - quiet case (L34): the new config still lists both hooks → forwarded, the after hook redacts as usual.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { buildStatusReport } from "../src/portal.ts";
import { freePort, type RealSdkApp, startRealSdkApp } from "./support/sdk-app.ts";
import { makeWorld, type World, waitFor } from "./support/world.ts";

const RULESINS = "ins_01HK0RVQESRVQESRVQESRVQESA";
const PAYINS = "ins_01HK0PAYTGTPAYTGTPAYTGTPAA";
const op = (id: string) => ({ id, title: id, description: id, input: { type: "object" }, output: { type: "object" }, crud: ["read"], effect: "read", idempotency: "supported", receipt: false, audience: "agent" });

describe("BRG-09: a config swap during the call that drops a declared hook fails closed", () => {
  let w: World;
  let rules: RealSdkApp;
  let pay: RealSdkApp;
  let payCalls = 0;
  let afterCalls = 0;
  /** what the before hook does before it answers allow (the swap under test) */
  let duringBefore: (() => Promise<void>) | undefined;

  before(async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    w = await makeWorld({ real: true, extraOwnInfraOrigins: [`http://127.0.0.1:${p1}`, `http://127.0.0.1:${p2}`] });
    pay = await startRealSdkApp(w, {
      ins: PAYINS,
      product: "samplepay",
      code: "tbe_brg09hooktargetpay0001",
      port: p1,
      operations: [op("pay_list")],
      handlers: {
        pay_list: async () => {
          payCalls += 1;
          return { items: [], secret: "not-for-agents" };
        },
      },
      agentGrantCrud: ["read"],
    });
    rules = await startRealSdkApp(w, {
      ins: RULESINS,
      product: "rulesx",
      code: "tbe_brg09hookrulesapp0001",
      port: p2,
      operations: [op("rule_list")],
      handlers: { rule_list: async () => ({ items: [] }) },
      hooks: [
        { id: "rules_gate", title: "Rules gate", phase: "before", order: 0, match: { products: ["samplepay"] }, timeoutMs: 2000 },
        { id: "rules_redact", title: "Rules redact", phase: "after", order: 0, match: { products: ["samplepay"] }, timeoutMs: 2000 },
      ],
      hookHandlers: {
        rules_gate: async () => {
          const swap = duringBefore;
          duringBefore = undefined;
          if (swap) await swap();
          return { allow: true };
        },
        rules_redact: async () => {
          afterCalls += 1;
          return { redactions: ["/secret"] };
        },
      },
    });
  });
  after(async () => {
    await rules?.stop();
    await pay?.stop();
    await w?.close();
  });

  const gate = { id: "rulesx.rules_gate", ins: RULESINS, product: "rulesx", hookId: "rules_gate", phase: "before", order: 0, timeoutMs: 2000, match: { products: ["samplepay"] } };
  const redact = { id: "rulesx.rules_redact", ins: RULESINS, product: "rulesx", hookId: "rules_redact", phase: "after", order: 0, timeoutMs: 2000, match: { products: ["samplepay"] } };
  const setHooks = async (hooks: unknown[]) => {
    await w.amend((c) => {
      (c as { hooks: unknown[] }).hooks = hooks;
    });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
  };
  /**
   * The table swap under test: a NEW table object listing only `keep` of the current hooks (same rev, so the next
   * real revision still replaces it through the config loop).
   */
  const swapTo = (keep: (hookId: string) => boolean) => async () => {
    const t = w.bridge.ctx.table;
    assert.ok(t);
    w.bridge.ctx.swapTable({ ...t, hooks: t.hooks.filter((h) => keep(h.hookId)) });
  };
  const callPay = async () => {
    const token = await w.agentToken();
    const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    return (await w.mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "samplepay__pay_list", arguments: {} } }, init.session as string)).json.result as {
      isError?: boolean;
      structuredContent?: { error?: { code?: string }; secret?: unknown; items?: unknown };
    };
  };

  test("quiet case: a swap that still lists both hooks → forwarded, the after hook redacts", async () => {
    await setHooks([gate, redact]);
    const [p, a, t0] = [payCalls, afterCalls, w.bridge.ctx.table];
    duringBefore = swapTo(() => true);
    const r = await callPay();
    assert.notEqual(w.bridge.ctx.table, t0, "the table really changed during the call");
    assert.notEqual(r.isError, true, JSON.stringify(r.structuredContent));
    assert.equal(payCalls, p + 1, "forwarded once");
    assert.equal(afterCalls, a + 1, "the after hook ran");
    assert.equal(r.structuredContent?.secret, undefined, "the after hook's redaction applied");
    assert.ok(!buildStatusReport(w.bridge.ctx).rejected.some((x) => x.code === "hook_not_listed"), "no hook_not_listed alarm");
  });

  test("the swap drops the declared after hook → hook_failed, never forwarded, reported hook_not_listed", async () => {
    await setHooks([gate, redact]);
    const [p, a, t0] = [payCalls, afterCalls, w.bridge.ctx.table];
    duringBefore = swapTo((id) => id !== "rules_redact");
    const r = await callPay();
    assert.notEqual(w.bridge.ctx.table, t0, "the table really changed during the call");
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent?.error?.code, "hook_failed");
    assert.equal(payCalls, p, "fail closed: the target op did not run");
    assert.equal(afterCalls, a, "no after hook ran");
    assert.ok(buildStatusReport(w.bridge.ctx).rejected.some((x) => x.kind === "config" && x.code === "hook_not_listed" && x.ins === RULESINS));
    // back to the full listing: the next call is forwarded again
    await setHooks([gate, redact]);
    const ok = await callPay();
    assert.notEqual(ok.isError, true, JSON.stringify(ok.structuredContent));
    assert.equal(payCalls, p + 1);
  });
});
