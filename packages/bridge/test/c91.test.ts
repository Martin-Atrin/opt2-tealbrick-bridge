/**
 * C91 (S1 hotfix): bridge-op proofs carry exactly the claims the SDK binds (SDK-API §3.2):
 * catalog {bop, op} · resolve {bop, op, in} · mark {bop, in} · scope_summary {bop}.
 * The bridge's REAL proofs are verified here with the REAL manifest `verifyBridgeOpProof` and the exact bindings
 * miniapp-sdk 0.1.12 uses (bridge-routes.ts), so a drift on either side fails this test.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { digest, verifyBridgeOpProof } from "@opt2-tealbrick/manifest";
import { CallRouter } from "../src/calls.ts";
import { trustFor } from "../src/table.ts";
import { INS, makeWorld, type World } from "./support/world.ts";

/** miniapp-sdk 0.1.12 bridge-routes.ts: the bind per bop (copied verbatim in shape) */
const sdkBind = (bop: string, body: Record<string, unknown>) => {
  const op = typeof body.op === "string" ? body.op : "";
  return bop === "catalog" ? { bop, op } : bop === "resolve" ? { bop, op, inputDigest: digest(body as never) } : bop === "mark" ? { bop, inputDigest: digest(body as never) } : { bop };
};

describe("C91: bridge-op proofs match the SDK's exact binding", () => {
  let w: World;
  const seen: { bop: string; proof: string; body: Record<string, unknown> }[] = [];
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  test("catalog (list + search), resolve, mark and scope_summary all verify", async () => {
    const t = w.bridge.ctx.table;
    const app = t?.apps.get(INS as never);
    assert.ok(t && app);
    // capture what the bridge sends instead of a fake app answering: the real fetch goes through ctx.fetch
    const orig = w.bridge.ctx.fetch;
    (w.bridge.ctx as { fetch: typeof fetch }).fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.pathname.startsWith("/tb/v1/bridge/")) {
        const headers = init?.headers as Record<string, string>;
        const bodyObj = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        seen.push({ bop: u.pathname.slice("/tb/v1/bridge/".length), proof: headers["TB-Call"] as string, body: bodyObj });
        const answer = u.pathname.endsWith("/resolve") ? { tool: bodyObj.tool, crud: ["read"], effect: "read" } : u.pathname.endsWith("/mark") ? { ok: true } : [];
        return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
      }
      return orig(url, init);
    };
    try {
      const r = new CallRouter(w.bridge.ctx);
      await r.bridgeOp(app, "catalog", { op: "notes_list" });
      await r.bridgeOp(app, "catalog", { op: "notes_list", query: "gmail list messages", limit: 5 });
      await r.bridgeOp(app, "resolve", { op: "notes_list", tool: "gmail_list" });
      await r.bridgeOp(app, "mark", { call: "call_01HXXXXXXXXXXXXXXXXXXXXXXX", mark: "after_failed" });
      await r.bridgeOp(app, "scope_summary", {});
    } finally {
      (w.bridge.ctx as { fetch: typeof fetch }).fetch = orig;
    }
    assert.equal(seen.length, 5);
    const pathToBop: Record<string, string> = { catalog: "catalog", resolve: "resolve", mark: "mark", "scope-summary": "scope_summary" };
    for (const s of seen) {
      const bop = pathToBop[s.bop] as string;
      const v = verifyBridgeOpProof(s.proof, trustFor(t, INS as never, Math.floor(Date.now() / 1000)), sdkBind(bop, s.body) as never);
      assert.equal(v.ok, true, `${bop}: ${JSON.stringify(v)}`);
      const claims = JSON.parse(Buffer.from(s.proof.split(".")[1] as string, "base64url").toString("utf8")) as Record<string, unknown>;
      assert.equal("in" in claims, bop === "resolve" || bop === "mark", `${bop}: in only where the body is input`);
      assert.equal("op" in claims, bop === "catalog" || bop === "resolve", `${bop}: op only where the SDK binds it`);
    }
  });
});

