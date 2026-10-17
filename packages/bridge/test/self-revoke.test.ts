/**
 * F39 REAL-to-REAL (L2): an agent revokes its OWN key connection (`tealbrick adopt --undo`). The CLI's `selfRevoke`
 * HTTP shape is reproduced here byte for byte (POST <tokenEndpoint origin>/agent/connection/revoke, JSON body
 * `{ assertion }`, a signed agent assertion, redirects refused, a 20 s bound) against a REAL bridge (test world): the
 * bridge refuses the connection at once and reports `client_revoke` to Portal; a second run says `already`; a dead
 * bridge is a soft failure. Moved from the CLI repo (C158); the CLI side stays unit-tested there (adopt.test.ts, stub bridge).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AGT, CON, makeWorld, type World } from "./support/world.ts";

type Revoked = { ok: true; already: boolean } | { ok: false; reason: string };

describe("F39: the CLI's self-revoke request against a real bridge", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
  });
  after(async () => {
    await w.close();
  });

  /** the CLI's `selfRevoke` (packages/cli/src/lead.ts), request and answer handling */
  async function selfRevoke(tokenEndpoint: string): Promise<Revoked> {
    let url: string;
    try {
      url = new URL("/agent/connection/revoke", tokenEndpoint).toString();
    } catch {
      return { ok: false, reason: "no bridge address in the local agent item" };
    }
    try {
      const assertion = await w.agentAssertion(AGT, CON);
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion }), redirect: "error", signal: AbortSignal.timeout(20_000) });
      const body = (await res.json().catch(() => ({}))) as { con?: string; status?: string; already?: boolean };
      if (res.ok && body.con === CON && body.status === "revoked") return { ok: true, already: body.already === true };
      if (res.status === 404) return { ok: false, reason: "the bridge is older than 0.1.18 (no self-revoke)" };
      return { ok: false, reason: `the bridge refused the revoke (HTTP ${res.status})` };
    } catch {
      return { ok: false, reason: "bridge unreachable" };
    }
  }

  test("revokes the own connection, the bridge reports client_revoke; a second run says already; a dead bridge is a soft failure", async () => {
    const tokenEndpoint = `${w.publicUrl}/oauth/token`;
    assert.deepEqual(await selfRevoke(tokenEndpoint), { ok: true, already: false });
    await new Promise((r) => setTimeout(r, 50));
    const tok = await fetch(tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await w.agentAssertion(AGT, CON) }) });
    assert.notEqual(tok.status, 200, "no access token after the revoke");
    for (let i = 0; i < 150 && !w.acks.some((a) => a.connectionsRevoked.some((x) => x.con === CON && x.reason === "client_revoke")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      w.acks.some((a) => a.connectionsRevoked.some((x) => x.con === CON && x.reason === "client_revoke")),
      "reported to Portal",
    );
    assert.deepEqual(await selfRevoke(tokenEndpoint), { ok: true, already: true });
    const dead = await selfRevoke("http://127.0.0.1:9/oauth/token");
    assert.equal(dead.ok, false);
  });
});
