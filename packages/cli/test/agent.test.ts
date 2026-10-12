import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { manifestApi } from "@opt2-tealbrick/bridge";
import { Harness } from "./fixtures.ts";

const api = manifestApi();
const BRG = "brg_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const WS = "ws_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const AGT = "agt_01HAAAAAAAAAAAAAAAAAAAAAAA";
const CON = "con_01HAAAAAAAAAAAAAAAAAAAAAAA";

describe("agent mode (key connections)", () => {
  const h = new Harness();
  let bridge: Server;
  let bridgeUrl = "";
  let registeredKey: { kty: "OKP"; crv: "Ed25519"; x: string } | undefined;
  let accepted = 0;
  let known = false;
  let lastStart: any;

  before(async () => {
    await h.setup();
    bridge = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/oauth/token") {
        const assertion = new URLSearchParams(body).get("assertion") ?? "";
        if (!known) return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant", error_description: "connection_unknown" }));
        const keys = api.keySetFrom({ keys: registeredKey ? [registeredKey] : [] }, `tb:agt:${AGT}` as never);
        const v = api.verifyAssertion(assertion, keys, { typ: "tb-agent-assert+jwt", aud: `tb:brg:${BRG}`, iss: [`tb:agt:${AGT}`], now: Math.floor(h.clock / 1000), maxLifetimeS: 60 });
        if (!v.ok) return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
        accepted += 1;
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "k5-access", token_type: "Bearer", expires_in: 900 }));
      }
      if (req.url === "/mcp" && req.method === "POST") {
        assert.equal(req.headers.authorization, "Bearer k5-access");
        const m = JSON.parse(body);
        const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", instructions: "Teal Brick apps…" } : { tools: [{ name: "notes__notes_list" }, { name: "notes__tb_skills" }] };
        return res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      }
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
    h.portal.on("POST", "/device/authorize", (req) => {
      assert.equal(req.body.scope, "agent");
      assert.equal(req.body.client_id, "tealbrick-cli");
      lastStart = req.body;
      registeredKey = req.body.agents[0].public_key;
      return { body: { device_code: "tbdv_x", user_code: "BCDF-GHJK", verification_uri: `${h.portal.origin}/device`, verification_uri_complete: `${h.portal.origin}/device?code=BCDFGHJK`, expires_in: 600, interval: 5 } };
    });
    let polls = 0;
    h.portal.on("POST", "/device/token", () => {
      polls += 1;
      if (polls === 1) return { status: 400, body: { error: { code: "authorization_pending", message: "pending", requestId: "r" } } };
      setTimeout(() => {
        known = true;
      }, 0);
      return {
        body: {
          scope: "agent",
          workspace_id: WS,
          bridge_id: BRG,
          mcp_url: `${bridgeUrl}/mcp`,
          token_endpoint: `${bridgeUrl}/oauth/token`,
          connections: [{ connection_id: CON, agent_id: AGT, public_key_thumbprint: api.thumbprint(registeredKey as never) }],
        },
      };
    });
  });
  after(async () => {
    bridge.closeAllConnections();
    await new Promise((r) => bridge.close(r));
    await h.teardown();
  });

  test("agent login: one device request, key in an agent item, waits until the bridge accepts it", async () => {
    h.clock = Date.now();
    await h.signIn(); // a person item exists, but agent login must never read it
    const r = await h.run(["agent", "login", "--agent", AGT, "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.connections[0].con, CON);
    assert.equal(r.json.connections[0].ready, true);
    assert.ok(!h.store.reads.includes("tealbrick.person"), "agent mode never loads the person item");
    const item = JSON.parse((await h.store.get(`tealbrick.agent.${CON}`)) as string);
    assert.equal(item.kind, "agent");
    assert.equal(item.bridgeId, BRG);
    assert.ok(item.privateKey.length > 40);
    assert.ok(accepted >= 1);
  });

  test("agent login --file refuses entries with neither id nor create: true, before any network call (QA S2)", async () => {
    const before = h.portal.requests.length;
    const file = join(h.dir, "agents.json");
    await writeFile(file, JSON.stringify({ format: "tealbrick.agents/1", agents: [{ name: "Agent 01", id: AGT }, { name: "Agent 02" }] }));
    const r = await h.run(["agent", "login", "--file", file, "--json"]);
    assert.equal(r.code, 8);
    assert.match(r.json.error.message, /Agent 02: no id/);
    assert.equal(h.portal.requests.length, before, "no device request was started");
  });

  test("C96: --name goes into the device request as the card suggestion; the harness id defaults to tealbrick-cli", async () => {
    h.clock = Date.now();
    const r = await h.run(["agent", "login", "--create", "--name", "Research agent", "--purpose", "Reads the inbox and drafts answers", "--json"]);
    assert.equal(r.code, 0, r.err);
    const start = lastStart as { harness: string; agents: { name?: string; purpose?: string; agt?: string }[] };
    assert.equal(start.harness, "tealbrick-cli");
    assert.equal(start.agents[0]?.name, "Research agent");
    assert.equal(start.agents[0]?.purpose, "Reads the inbox and drafts answers");
    const tooLong = await h.run(["agent", "login", "--create", "--name", "x".repeat(61), "--json"]);
    assert.equal(tooLong.code, 2, "names are 1-60 characters");
    const two = await h.run(["agent", "login", "--agent", AGT, "--agent", "agt_01HAAAAAAAAAAAAAAAAAAAAAAA", "--name", "x", "--json"]);
    assert.equal(two.code, 2, "--name names one agent");
  });

  test("agent login without --agent, --file or --create is refused", async () => {
    const r = await h.run(["agent", "login", "--json"]);
    assert.equal(r.code, 2);
  });

  test("agent login --file sends the ids of existing cards; create: true sends an unbound slot", async () => {
    const file = join(h.dir, "agents2.json");
    await writeFile(file, JSON.stringify({ format: "tealbrick.agents/1", agents: [{ name: "Agent 01", id: AGT }, { name: "New one", create: true }] }));
    known = false;
    await h.run(["agent", "login", "--file", file, "--json"]);
    assert.equal(lastStart.agents.length, 2);
    assert.equal(lastStart.agents[0].agt, AGT);
    assert.equal(lastStart.agents[1].agt, undefined);
  });

  test("agent status reaches the bridge with K5 and counts tools", async () => {
    h.store.reads = [];
    const r = await h.run(["agent", "status", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.state, "connected");
    assert.equal(r.json.tools, 2);
    assert.ok(!h.store.reads.includes("tealbrick.person"));
  });

  test("agent list and logout touch only agent items", async () => {
    const l = await h.run(["agent", "list", "--json"]);
    assert.equal(l.json.agents[0].connection, CON);
    const o = await h.run(["agent", "logout", "--json"]);
    assert.equal(o.code, 0);
    assert.equal(await h.store.get(`tealbrick.agent.${CON}`), null);
  });

  test("bridge serve requires --stdio (no listener exists)", async () => {
    const r = await h.run(["bridge", "serve", "--json"]);
    assert.equal(r.code, 2);
  });
});
