/**
 * `tealbrick adopt` phase 1 (C96/C106): dry-run on a fake v1 dir (nothing written, no network, no secret value in any
 * output), a real run + idempotent re-run (no second device flow, nothing rewritten), and harness wiring + --undo
 * (backups restored byte for byte, local key deleted). Fake Portal (device flow) + fake bridge (token, MCP).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { manifestApi } from "@opt2-tealbrick/bridge";
import { Harness } from "./fixtures.ts";

const api = manifestApi();
const BRG = "brg_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const WS = "ws_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const AGT = "agt_01HADQPTADQPTADQPTADQPTADQ";
const CON = "con_01HADQPTADQPTADQPTADQPTADQ";
const SECRET_FILE_VALUE = "plantedsecretfilevalue0123456789";
const SECRET_ENV_VALUE = "sk-ant-plantedsecretenvvalue0123456789";

describe("tealbrick adopt (C96 phase 1)", () => {
  const h = new Harness();
  let bridge: Server;
  let registeredKey: unknown;
  let deviceStarts = 0;
  const revokes: string[] = [];

  before(async () => {
    await h.setup();
    h.clock = Date.now();
    bridge = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/oauth/token") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "k5-access", token_type: "Bearer", expires_in: 900 }));
      if (req.url === "/agent/connection/revoke" && req.method === "POST") {
        revokes.push(JSON.parse(body).assertion);
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ con: CON, status: "revoked" }));
      }
      if (req.url === "/mcp" && req.method === "POST") {
        const m = JSON.parse(body);
        const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", instructions: "Teal Brick apps" } : { tools: [{ name: "connect__channel_inbox" }, { name: "knowledge__recall" }] };
        return res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      }
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    const bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
    h.portal.on("POST", "/device/authorize", (req) => {
      deviceStarts += 1;
      registeredKey = req.body.agents[0].public_key;
      return { body: { device_code: "tbdv_x", user_code: "BCDF-GHJK", verification_uri: `${h.portal.origin}/device`, verification_uri_complete: `${h.portal.origin}/device?code=BCDFGHJK`, expires_in: 600, interval: 5 } };
    });
    h.portal.on("POST", "/device/token", () => ({
      body: { scope: "agent", workspace_id: WS, bridge_id: BRG, mcp_url: `${bridgeUrl}/mcp`, token_endpoint: `${bridgeUrl}/oauth/token`, connections: [{ connection_id: CON, agent_id: AGT, public_key_thumbprint: api.thumbprint(registeredKey as never) }] },
    }));
    // no harness binaries on PATH: detection must come from files only
    h.env.PATH = join(h.dir, "empty-bin");
    h.env.ANTHROPIC_API_KEY = SECRET_ENV_VALUE;
    // a v1 agent dir: serve config, persona elsewhere, a credential file and a grants file
    const v1 = join(h.home, "v1agent");
    await mkdir(join(v1, ".tealbrick"), { recursive: true });
    await mkdir(join(h.home, "personas"), { recursive: true });
    await writeFile(join(h.home, "personas", "persona.md"), "# Research agent\nYou read papers.\nUse mcp__mail__send to send summaries.\nStore notes with `create_document`; search the web normally.\nNever call `delete_document`.\n");
    await writeFile(join(v1, ".tealbrick", "agent.key"), SECRET_FILE_VALUE);
    await writeFile(join(v1, "portal-grants.json"), JSON.stringify({ token: SECRET_FILE_VALUE }));
    await writeFile(
      join(v1, ".tealbrick", "native-serve.json"),
      JSON.stringify({
        version: 1,
        agent: { id: "v1-agent", name: "Research agent", ownerId: "owner" },
        claude: {
          cwd: v1,
          instructionsFile: join(h.home, "personas", "persona.md"),
          model: "claude-opus-4-1",
          effort: "high",
          maxTurns: 30,
          maxBudgetUsd: 5,
          timeoutSeconds: 900,
          defaultTools: ["WebSearch", "Bash", "Read"],
          // the REAL v1 recipe shape (F28): tools keyed by name, effects a string
          mcpServers: { mail: { command: "mail-mcp", tools: { mail_send: { effects: "outward" }, mail_read: { effects: "read-only" } } }, craft: { command: "craft-mcp", tools: { doc_write: { effects: "writes" } } }, notes: { command: "notes-mcp" } },
          requireSubscription: true,
        },
      }),
    );
  });
  after(async () => {
    bridge.closeAllConnections();
    await new Promise((r) => bridge.close(r));
    await h.teardown();
  });

  const adoptDir = () => join(h.home, ".config", "tealbrick", "adopt");
  const v1 = () => join(h.home, "v1agent");

  test("--dry-run on a v1 dir: plan only — nothing written, no network, no secret value anywhere", async () => {
    const before = h.portal.requests.length;
    const r = await h.run(["adopt", "--from-v1", v1(), "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.err);
    const p = r.json.plan;
    assert.equal(p.harness, "claude-sdk");
    assert.equal(p.name, "Research agent");
    assert.equal(p.detection.modelAuth.anthropicKeyEnv, true, "presence only");
    assert.deepEqual(p.detection.builtinTools, { proposed: ["WebSearch", "Read"], dropped: ["Bash"] });
    assert.ok(p.detection.mcpServers.some((m: { name: string; reason: string }) => m.name === "mail" && /outward/.test(m.reason)), "F28: tools object + effects string");
    assert.ok(p.detection.mcpServers.some((m: { name: string; reason: string }) => m.name === "craft" && /writes/.test(m.reason)));
    assert.ok(p.detection.notCopied.some((x: { path: string }) => x.path.endsWith("agent.key") || x.path.endsWith(".tealbrick")));
    assert.ok(p.detection.notCopied.some((x: { path: string }) => x.path.endsWith("portal-grants.json")));
    const all = r.out + r.err;
    assert.ok(!all.includes(SECRET_FILE_VALUE) && !all.includes(SECRET_ENV_VALUE), "no secret value in any output");
    assert.equal(h.portal.requests.length, before, "no network call");
    assert.equal(existsSync(adoptDir()), false, "nothing written");
    // F43: the persona is built in memory — rewrites and review lines show in the dry-run
    assert.ok(r.json.personaReview.some((l: string) => /rewrote create_document → knowledge__document_create/.test(l)));
    assert.ok(r.json.personaReview.some((l: string) => /mcp__mail__send/.test(l)));
    // F46: no phantom product "mcp" from the v1 mcp__mail__send name
    assert.ok(!r.json.suggestion.grants.some((g: { product: string }) => g.product === "mcp"));
  });

  test("real run, then a re-run: one device flow, persona + serve config written once, the re-run changes nothing", async () => {
    const r = await h.run(["adopt", "--from-v1", v1(), "--yes", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.agent, AGT);
    assert.equal(r.json.reused, false);
    const start = h.portal.requests.filter((q) => q.path.endsWith("/device/authorize")).at(-1)?.body as { agents: { adopt?: { grants: { product: string; crud?: string[]; operations?: string[] }[]; channel?: { kind: string }; wake?: string } }[] };
    const sugg = start.agents[0]?.adopt;
    assert.ok(sugg, "C106a: the device request carries the adopt suggestion");
    assert.equal(sugg?.wake, "serve");
    assert.deepEqual(sugg?.channel, { kind: "buzz_channel" }, "F35: the owner picks the Buzz channel at approval");
    assert.deepEqual(sugg?.grants.find((g) => g.product === "knowledge"), { product: "knowledge", crud: ["read"] }, "F46: read only; the owner ticks writes in Portal");
    assert.ok(!sugg?.grants.some((g) => g.operations), "F46: no invented write ops");
    assert.ok(sugg?.grants.some((g) => g.product === "connect"));
    assert.equal(r.json.toolsReady, true);
    assert.equal(r.json.probe.tools, 2);
    assert.ok(r.json.personaReview.some((l: string) => /mcp__mail__send/.test(l)), "risky persona lines listed for review");
    const dir = join(adoptDir(), AGT);
    const serve = JSON.parse(await readFile(join(dir, "serve.json"), "utf8"));
    assert.equal(serve.harness.appendSystemPromptFile, "persona/persona.md");
    assert.deepEqual(serve.harness.builtinTools, ["WebSearch", "Read"]);
    assert.equal(serve.harness.effort, "high");
    assert.equal(serve.harness.maxBudgetUsd, 5);
    assert.equal(serve.harness.turnTimeoutSeconds, 900);
    assert.equal(serve.inboxes[0].wake, "mentions");
    assert.equal(serve.inboxes[0].auto, "connect", "F35: the default inbox is chosen at serve time");
    // F45: the harness works in <adopt dir>/work (0700), not in the shell's cwd
    assert.equal(serve.harness.cwd, "work");
    const { statSync: st } = await import("node:fs");
    assert.equal(st(join(dir, "work")).mode & 0o777, 0o700);
    const persona = await readFile(join(dir, "persona", "persona.md"), "utf8");
    assert.match(persona, /adopted by tealbrick adopt/);
    assert.match(persona, /You read papers/);
    assert.match(persona, /`knowledge__document_create`/, "code-span rewrite");
    assert.match(persona, /search the web normally/, "prose is never rewritten");
    assert.ok(r.json.personaReview.some((l: string) => /rewrote create_document → knowledge__document_create/.test(l)), "every rewrite is listed");
    assert.ok(r.json.personaReview.some((l: string) => /delete_document \(no opt2 agent tool\)/.test(l)), "review-only names listed");
    assert.ok(!readdirSync(dir, { recursive: true }).some((f) => String(f).includes("agent.key")), "credentials are never copied");
    assert.ok(!(r.out + r.err).includes(SECRET_ENV_VALUE));
    const starts = deviceStarts;
    const { statSync } = await import("node:fs");
    const statePath = join(dir, "adopt.json");
    const stateBefore = await readFile(statePath, "utf8");
    const mtimeBefore = statSync(statePath).mtimeMs;
    h.clock += 60_000;
    const again = await h.run(["adopt", "--from-v1", v1(), "--yes", "--json"]);
    assert.equal(again.code, 0, again.err);
    assert.equal(again.json.reused, true);
    assert.deepEqual(again.json.changed, [], "idempotent: nothing rewritten");
    assert.equal(await readFile(statePath, "utf8"), stateBefore, "adopt.json unchanged (no new timestamp)");
    assert.equal(statSync(statePath).mtimeMs, mtimeBefore, "adopt.json not even rewritten");
    assert.equal(deviceStarts, starts, "no second device flow while the connection is valid");
  });

  test("claude-desktop wiring backs up the config; --undo restores it byte for byte and deletes the local key", async () => {
    // the CLI's own desktop config location for this platform (connect.ts desktopConfigPath)
    const cfgDir = h.platform === "darwin" ? join(h.home, "Library", "Application Support", "Claude") : join(h.home, ".config", "Claude");
    const cfgPath = join(cfgDir, "claude_desktop_config.json");
    await mkdir(cfgDir, { recursive: true });
    const original = `${JSON.stringify({ mcpServers: { mine: { command: "my-server" } }, theme: "dark" }, null, 2)}\n`;
    await writeFile(cfgPath, original);
    const r = await h.run(["adopt", "--harness", "claude-desktop", "--name", "Desk agent", "--yes", "--json"]);
    assert.equal(r.code, 0, r.err);
    const wired = JSON.parse(await readFile(cfgPath, "utf8"));
    assert.ok(wired.mcpServers.tealbrick, "one tealbrick entry added");
    assert.ok(wired.mcpServers.mine, "the user's own server is kept");
    assert.equal(r.json.backups.length, 1);
    assert.equal(await readFile(r.json.backups[0], "utf8"), original);
    // F32: an existing Teal Brick entry is REUSED (same entry, same card), never a second entry or card
    const dry = await h.run(["adopt", "--harness", "claude-desktop", "--name", "Another agent", "--dry-run", "--json"]);
    assert.deepEqual(dry.json.existingEntries, [{ name: "tealbrick", agt: AGT, remote: false }]);
    assert.equal(dry.json.entry, "tealbrick");
    assert.equal(dry.json.card, AGT, "the card named in the entry is reused");
    assert.equal(dry.json.target, cfgPath, "the plan names the config path");
    const u = await h.run(["adopt", "--undo", "--name", "Desk agent", "--json"]);
    assert.equal(u.code, 0, u.err);
    assert.equal(await readFile(cfgPath, "utf8"), original, "restored byte for byte");
    assert.equal(await h.store.get(`tealbrick.agent.${CON}`), null, "local key deleted");
    assert.equal(u.json.connection, CON, "F39: the exact connection id is named");
    // F39: --undo revokes the own connection at the bridge with an assertion of THAT connection; no owner step
    assert.equal(revokes.length, 1);
    assert.equal(JSON.parse(Buffer.from(revokes[0]?.split(".")[1] ?? "", "base64url").toString("utf8")).con, CON);
    assert.equal(u.json.revoked, true);
    assert.equal(u.json.revokeNeeded, false);
    // F40: re-adopt after undo = SAME card, NEW connection (not "reused")
    const again = await h.run(["adopt", "--harness", "claude-desktop", "--name", "Desk agent", "--yes", "--json"]);
    assert.equal(again.code, 0, again.err);
    assert.equal(again.json.reused, false);
    assert.equal(again.json.sameCard, true);
  });

  test("F30: --inbox buzz:<channel> adds a Buzz inbox to the serve config; a bad value is refused", async () => {
    const r = await h.run(["adopt", "--from-v1", v1(), "--inbox", "buzz:ch_research,buzz:ch_team", "--yes", "--json"]);
    assert.equal(r.code, 0, r.err);
    const serve = JSON.parse(await readFile(join(adoptDir(), AGT, "serve.json"), "utf8"));
    const buzz = serve.inboxes.filter((i: { tool: string }) => i.tool === "connect__buzz_read");
    assert.deepEqual(
      buzz.map((i: { args: { channel: string } }) => i.args.channel),
      ["ch_research", "ch_team"],
    );
    // F35: with Buzz channels the agent listens there only (no bot channel inbox under a read-only grant)
    assert.ok(!serve.inboxes.some((i: { tool: string }) => i.tool === "connect__channel_inbox"));
    const bad = await h.run(["adopt", "--from-v1", v1(), "--inbox", "slack:x", "--dry-run", "--json"]);
    assert.equal(bad.code, 2);
  });

  test("F28: an unknown recipe shape never crashes; the field is reported and adopt continues", async () => {
    const odd = join(h.home, "v1odd");
    await mkdir(join(odd, ".tealbrick"), { recursive: true });
    await writeFile(join(odd, ".tealbrick", "native-serve.json"), JSON.stringify({ agent: { name: "Odd agent" }, claude: { model: 7, defaultTools: "WebSearch", mcpServers: [1, 2], maxTurns: "lots" } }));
    const r = await h.run(["adopt", "--from-v1", odd, "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.json.plan.detection.settings.unknown.includes("could not read recipe: mcpServers"));
    assert.equal(r.json.plan.detection.settings.model, undefined);
    assert.equal(r.json.plan.detection.settings.maxTurns, undefined);
  });

  test("F41/F42: top-level recipe defaults under the agent block; older .tealbrick* folders are one unread entry", async () => {
    const base = join(h.home, "v1recipe");
    await mkdir(join(base, ".tealbrick"), { recursive: true });
    await mkdir(join(base, ".tealbrick.pre-reenroll-2026-09-01", "sessions"), { recursive: true });
    await writeFile(join(base, ".tealbrick.pre-reenroll-2026-09-01", "kit.credentials.json"), "{}");
    await writeFile(join(base, "recipe.json"), JSON.stringify({ model: "claude-opus-4-1", effort: "high", maxTurns: 40, maxBudgetUsd: 3, timeoutSeconds: 600, agents: { scout: { maxTurns: 12 } } }));
    await writeFile(join(base, ".tealbrick", "native-serve.json"), JSON.stringify({ agent: { name: "Scout" }, claude: { recipe: { path: "../recipe.json", agent: "scout" } } }));
    const r = await h.run(["adopt", "--from-v1", base, "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.err);
    const st = r.json.plan.detection.settings;
    assert.equal(st.model, "claude-opus-4-1", "top-level default kept");
    assert.equal(st.effort, "high");
    assert.equal(st.maxTurns, 12, "the agent block overrides the top level");
    assert.equal(st.maxBudgetUsd, 3);
    assert.equal(st.timeoutSeconds, 600);
    const nc = r.json.plan.detection.notCopied.map((x: { path: string }) => x.path);
    assert.ok(nc.includes(join(base, ".tealbrick.pre-reenroll-2026-09-01")), "the old identity folder is one entry");
    assert.ok(!nc.some((x: string) => x.includes("kit.credentials.json")), "its files are not listed piecemeal");
  });

  test("F46: products from any identifier form or the product name in prose; no owner session; never a phantom", async () => {
    const persona = join(h.home, "personas", "heinz.md");
    await writeFile(persona, "Plan work on the Kanban board.\nUse mcp__tealbrick__evolution__routines_due and `knowledge__recall`.\nSend with mcp__mail__send.\n");
    const r = await h.run(["adopt", "--harness", "claude-sdk", "--name", "Heinz", "--persona", persona, "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(
      r.json.suggestion.grants.map((g: { product: string }) => g.product),
      ["connect", "evolution", "kanban", "knowledge"],
    );
    assert.ok(r.json.suggestion.grants.every((g: { crud: string[]; operations?: string[] }) => g.crud.join() === "read" && !g.operations));
  });

  test("F47: REUSE keeps a remote (OAuth) Codex entry unchanged; --switch-to-stdio is explicit and shown in the plan", async () => {
    const cfg = join(h.home, ".codex", "config.toml");
    await mkdir(join(h.home, ".codex"), { recursive: true });
    const original = '[mcp_servers.tealbrick-dev]\nurl = "https://bridge.example/mcp"\n';
    await writeFile(cfg, original);
    const dry = await h.run(["adopt", "--harness", "codex", "--name", "Codex agent", "--agent", AGT, "--dry-run", "--json"]);
    assert.equal(dry.code, 0, dry.err);
    assert.equal(dry.json.transport, "remote");
    const text = await h.run(["adopt", "--harness", "codex", "--name", "Codex agent", "--agent", AGT, "--dry-run"]);
    assert.match(text.out + text.err, /kept: remote OAuth/);
    const sw = await h.run(["adopt", "--harness", "codex", "--name", "Codex agent", "--agent", AGT, "--switch-to-stdio", "--dry-run", "--json"]);
    assert.equal(sw.json.transport, "stdio");
    const real = await h.run(["adopt", "--harness", "codex", "--name", "Codex agent", "--agent", AGT, "--yes", "--json"]);
    assert.equal(real.code, 0, real.err);
    assert.equal(await readFile(cfg, "utf8"), original, "the remote entry is not rewritten");
  });
});
