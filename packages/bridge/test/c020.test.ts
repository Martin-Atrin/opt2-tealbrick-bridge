/**
 * Bridge 0.1.20 (manifest 0.1.14, L1): tools/list uses `opVisibleToGrant` and gate() uses `opInGrantWorkflow` from the
 * manifest package. Equivalence: over a grid of grants (mode × crud × wf) and every op of the app (incl. a scoped op
 * with an undeclared scopeType), an op is LISTED iff the bridge's REAL gate() passes steps 3–4 for it with that grant
 * (the same verified grant, the same declared scope types; pause off).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { trustFor } from "../src/table.ts";
import { visibleOps } from "../src/tools.ts";
import { AGT, BRG, INS, makeWorld, type World, WS } from "./support/world.ts";

const GATE_STEP_3_4 = new Set(["crud_exceeds_grant", "audience_not_agent", "scope_type_unknown", "not_in_workflow"]);

describe("0.1.20: tools/list == gate() steps 3–4 (manifest opVisibleToGrant / opInGrantWorkflow)", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  test("every op × every grant shape: listed ⇔ gate passes steps 3–4", async () => {
    const t = w.bridge.ctx.table;
    assert.ok(t);
    const app = [...t.apps.values()].find((a) => a.entry.ins === INS);
    assert.ok(app);
    const now = Math.floor(Date.now() / 1000);
    const ops = [...app.ops.values()].filter((o) => !o.standard);
    // one extra op whose scopeType the manifest does not declare
    ops.push({ ...(ops[0] as (typeof ops)[number]), id: "notes_scoped", scopeType: "undeclared_scope" } as (typeof ops)[number]);
    const ids = ops.map((o) => o.id);
    const crudSets: string[][] = [["read"], ["read", "create"], ["read", "create", "update", "delete"]];
    const wfSets: string[][] = [[], ["notes_list"], ["notes_create", "notes_delete", "notes_scoped"], ids];
    let cells = 0;
    for (const mode of ["free", "bound"]) {
      for (const crud of crudSets) {
        for (const wf of wfSets) {
          if (mode === "bound" && wf.length === 0) continue; // a Bound grant always carries a non-empty wf
          const grant = await w.signPortal("tb-grant+jwt", { iss: "tb:portal", sub: `tb:agt:${AGT}`, aud: `tb:ins:${INS}`, iat: now, exp: now + 3600, jti: w.api.ulid(), ws: WS, cnf: { brg: BRG }, crud, mode, held: [], caps: {}, wf, polrev: 1 });
          const v = w.api.verifyGrant(grant, trustFor(t, INS as never, now));
          assert.ok("claims" in v && v.ok, "the grant verifies");
          const listed: Set<string> = new Set(visibleOps(w.bridge.ctx, { ...app, ops: new Map(ops.map((o) => [o.id, o])) } as never, v.claims).map((o) => o.id));
          for (const op of ops) {
            const d = w.bridge.ctx.api.gate({ paused: { workspace: false, agent: false, connection: false, instance: false }, grant, trust: trustFor(t, INS as never, now), op, declaredScopeTypes: app.scopeTypes } as never);
            const passes34 = d.decision === "pass" || !GATE_STEP_3_4.has(d.reason);
            assert.equal(listed.has(op.id), passes34, `${mode} crud=${crud} wf=${wf} op=${op.id}: listed ${listed.has(op.id)}, gate ${d.decision}/${d.reason}`);
            cells += 1;
          }
        }
      }
    }
    assert.ok(cells >= 100, `grid covered ${cells} cells`);
  });
});
