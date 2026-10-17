/**
 * Bridge 0.2.1 (manifest 0.1.21, LR-1 C234, L1): `operations[].listing: "workflow"`. Such an op is in tools/list and passes
 * gate() only when the grant's `wf` NAMES it, in any grant mode. The rule is the manifest package's (`opVisibleToGrant`,
 * `gate`); the relay's `opInGrantWorkflow` binding has two parameters and would drop `listing`, so the bridge never calls
 * it: tools/list and the gate use `api.opVisibleToGrant` and `api.gate`, which apply `op.listing` themselves.
 * Both ways (L34): the op is hidden and refused without the wf entry, listed and allowed with it, and an ordinary op is
 * untouched.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { trustFor } from "../src/table.ts";
import { visibleOps } from "../src/tools.ts";
import { AGT, BRG, CON, INS, makeWorld, notesManifest, type World, WS, waitFor } from "./support/world.ts";

const wfOp = {
  id: "notes_wf",
  title: "Workflow only",
  description: "An op only a workflow names",
  input: { type: "object" },
  output: { type: "object" },
  crud: ["read"],
  effect: "read",
  idempotency: "none",
  receipt: false,
  audience: "agent",
  listing: "workflow",
};
const manifest = { ...notesManifest, version: "1.2.0", operations: [...notesManifest.operations, wfOp] };
const now = () => Math.floor(Date.now() / 1000);

async function session(w: World) {
  const token = await w.agentToken();
  const init = await w.mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } } });
  return { token, sid: init.session as string };
}
const toolNames = async (w: World) => {
  const s = await session(w);
  const r = await w.mcp(s.token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, s.sid);
  return (r.json.result.tools as { name: string }[]).map((t) => t.name);
};
const callTool = async (w: World, name: string) => {
  const s = await session(w);
  const r = await w.mcp(s.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } }, s.sid);
  return r.json.result as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
};

for (const real of [false, true]) {
  describe(`listing: "workflow" (${real ? "real manifest crypto" : "test double"})`, () => {
    let w: World;
    before(async () => {
      w = await makeWorld({ real });
      w.updateAppTo(manifest);
      await w.publish();
      await waitFor(() => !!w.bridge.ctx.table?.apps.get(INS as never)?.ops.has("notes_wf"), 15000);
    });
    after(async () => {
      await w.close();
    });
    const grant = (wf: string[], mode = "free") =>
      w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:agt:${AGT}`, aud: `tb:ins:${INS}`, iat: now(), exp: now() + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud: ["read", "create"], mode, held: [], caps: {}, wf, polrev: 1 });
    const gate = (token: string, opId: string) => {
      const t = w.bridge.ctx.table;
      const app = t?.apps.get(INS as never);
      const op = app?.ops.get(opId);
      assert.ok(t && app && op, "table, app and op exist");
      return w.bridge.ctx.api.gate({ paused: { workspace: false, agent: false, connection: false, instance: false }, grant: token, trust: trustFor(t, INS as never, now()), op, declaredScopeTypes: app.scopeTypes } as never);
    };

    test("no wf entry: hidden from tools/list, and the call is refused (unknown tool); the ordinary ops stay", async () => {
      const names = await toolNames(w);
      assert.ok(!names.includes("notes__notes_wf"), "hidden");
      assert.ok(names.includes("notes__notes_list") && names.includes("notes__notes_create"), "ordinary ops are listed");
      const r = await callTool(w, "notes__notes_wf");
      assert.equal(r.isError, true);
      assert.equal(r.structuredContent?.error?.code, "unknown_tool");
      assert.equal(w.appLog.ops.filter((o) => o.op === "notes_wf").length, 0, "the app never saw the op");
    });

    test("the gate refuses it for a grant whose wf does not name it, in Free and Bound mode, and passes the ordinary op", async () => {
      for (const [mode, wf] of [["free", []], ["free", ["notes_list"]], ["bound", ["notes_list"]]] as const) {
        const d = gate(await grant([...wf], mode), "notes_wf");
        assert.equal(d.decision, "refuse", `${mode} wf=${wf}`);
        assert.equal(d.reason, "not_in_workflow", `${mode} wf=${wf}`);
      }
      assert.equal(gate(await grant([]), "notes_list").decision, "pass", "an ordinary op passes for a Free grant with an empty wf");
    });

    test("a grant whose wf names it: listed, gate passes, the call reaches the app", async () => {
      const g = await grant(["notes_wf"]);
      assert.equal(gate(g, "notes_wf").decision, "pass");
      // Core lists a grant with that wf in the next config
      await w.publish((c) => {
        c.grants = [g];
      });
      await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
      const names = await toolNames(w);
      assert.ok(names.includes("notes__notes_wf"), "listed");
      const r = await callTool(w, "notes__notes_wf");
      assert.equal(r.isError, undefined);
      assert.equal(w.appLog.ops.filter((o) => o.op === "notes_wf").length, 1, "the call reached the app");
      // and the wf now confines the agent to it: the ordinary op is hidden (non-empty wf)
      assert.ok(!names.includes("notes__notes_list"));
      void CON;
    });

    test("tools/list == gate for the listing op over a grid of grants (listed ⇔ gate passes steps 3–4)", async () => {
      const t = w.bridge.ctx.table;
      const app = t?.apps.get(INS as never);
      assert.ok(t && app);
      let cells = 0;
      for (const mode of ["free", "bound"]) {
        for (const wf of [[], ["notes_list"], ["notes_wf"], ["notes_list", "notes_wf"]]) {
          if (mode === "bound" && wf.length === 0) continue;
          const g = await grant(wf, mode);
          const v = w.api.verifyGrant(g, trustFor(t, INS as never, now()));
          assert.ok("claims" in v && v.ok);
          const listed: Set<string> = new Set(visibleOps(w.bridge.ctx, app, v.claims).map((o) => o.id));
          for (const id of ["notes_wf", "notes_list"]) {
            const d = gate(g, id);
            assert.equal(listed.has(id), d.decision === "pass", `${mode} wf=${wf} op=${id}: listed ${listed.has(id)}, gate ${d.decision}/${d.reason}`);
            cells += 1;
          }
          assert.equal(listed.has("notes_wf"), wf.includes("notes_wf"), `${mode} wf=${wf}: the listing op is listed exactly when wf names it`);
        }
      }
      assert.ok(cells >= 14);
    });
  });
}

test("the bridge has no call site of the relay's two-parameter opInGrantWorkflow (it would drop `listing`)", () => {
  for (const pkg of ["../../bridge/src/", "../../bridge-server/src/"]) {
    const dir = fileURLToPath(new URL(pkg, import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      assert.ok(!/\.opInGrantWorkflow\(/.test(readFileSync(`${dir}${f}`, "utf8")), `${pkg}${f} must use api.gate / api.opVisibleToGrant`);
    }
  }
});
