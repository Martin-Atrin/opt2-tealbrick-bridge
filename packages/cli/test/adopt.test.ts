/**
 * `tealbrick adopt` (C96/C106): dry-run of a Claude Agent SDK agent with a persona (nothing written, no network, no
 * secret value in any output), a real run + idempotent re-run (no second device flow, nothing rewritten), and harness
 * wiring + --undo (backups restored byte for byte, local key deleted). C132: there is no v1 import path any more. Fake Portal (device flow) + fake bridge (token, MCP).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { manifestApi } from "@opt2-tealbrick/bridge";
import { isHarnessOptionId } from "@opt2-tealbrick/spec/routes";
import { validateServeConfig } from "../src/serve.ts";
import { apiError, Harness } from "./fixtures.ts";

const api = manifestApi();
const BRG = "brg_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const WS = "ws_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const AGT = "agt_01HADQPTADQPTADQPTADQPTADQ";
const CON = "con_01HADQPTADQPTADQPTADQPTADQ";
const SECRET_ENV_VALUE = "sk-ant-plantedsecretenvvalue0123456789";

describe("tealbrick adopt (C96 phase 1)", () => {
  const h = new Harness();
  let bridge: Server;
  let registeredKey: unknown;
  let deviceStarts = 0;
  const harnessIds: unknown[] = [];
  const revokes: string[] = [];
  /** F115: the next N token requests are refused like a revoked connection (or a deleted card) */
  let refuseTokens = 0;
  const lastStart = () => h.portal.requests.filter((q) => q.path.endsWith("/device/authorize")).at(-1)?.body as { agents: { agt?: string; name?: string; adopt?: { grants: { product: string; crud?: string[] }[] } }[] };

  before(async () => {
    await h.setup();
    h.clock = Date.now();
    bridge = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/oauth/token" && refuseTokens > 0) {
        refuseTokens -= 1;
        return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant", error_description: "connection_revoked" }));
      }
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
      // BRG-01 (L1/L27): like Core, the fake judges device.start.harness by the spec list and records it
      harnessIds.push(req.body.harness);
      if (!isHarnessOptionId(req.body.harness)) return apiError(400, "input_invalid", `unknown harness ${String(req.body.harness)}`);
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
    // a persona file under $HOME (tool references and an outward verb, listed for review)
    await mkdir(join(h.home, "personas"), { recursive: true });
    await writeFile(join(h.home, "personas", "persona.md"), "# Research agent\nYou read papers.\nUse mcp__mail__send to send summaries.\nStore notes with `knowledge__document_create`; search the web normally.\n");
  });
  after(async () => {
    bridge.closeAllConnections();
    await new Promise((r) => bridge.close(r));
    await h.teardown();
  });

  const adoptDir = () => join(h.home, ".config", "tealbrick", "adopt");
  const persona = () => join(h.home, "personas", "persona.md");
  const sdk = () => ["adopt", "--harness", "claude-sdk", "--name", "Research agent", "--persona", persona()];

  test("--dry-run: plan only — nothing written, no network, no secret value anywhere", async () => {
    const before = h.portal.requests.length;
    const r = await h.run([...sdk(), "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.err);
    const p = r.json.plan;
    assert.equal(p.harness, "claude-sdk");
    assert.equal(p.name, "Research agent");
    assert.equal(p.detection.modelAuth.anthropicKeyEnv, true, "presence only");
    assert.deepEqual(p.detection.persona.files, [persona()]);
    assert.ok(r.json.personaReview.some((l: string) => /mcp__mail__send/.test(l)), "tool references listed for review");
    const all = r.out + r.err;
    assert.ok(!all.includes(SECRET_ENV_VALUE), "no secret value in any output");
    assert.equal(h.portal.requests.length, before, "no network call");
    assert.equal(existsSync(adoptDir()), false, "nothing written");
    // F46: no phantom product "mcp" from mcp__mail__send
    assert.ok(!r.json.suggestion.grants.some((g: { product: string }) => g.product === "mcp"));
  });

  test("C132: the v1 import flag is gone (opt2 is version 0)", async () => {
    const r = await h.run(["adopt", ["--from", "v1"].join("-"), h.home, "--dry-run", "--json"]);
    assert.equal(r.code, 2, "unknown option");
  });

  test("real run, then a re-run: one device flow, persona + serve config written once, the re-run changes nothing", async () => {
    const n0 = harnessIds.length;
    const r = await h.run([...sdk(), "--yes", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.agent, AGT);
    assert.equal(r.json.reused, false);
    assert.deepEqual(harnessIds.slice(n0), ["tealbrick-cli"], "BRG-01: a claude-sdk runner is a tealbrick-cli agent, never 'claude-sdk'");
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
    assert.equal(serve.harness.builtinTools, undefined, "no built-in tools unless the owner adds them");
    assert.equal(serve.inboxes[0].wake, "mentions");
    assert.equal(serve.inboxes[0].auto, "connect", "F35: the default inbox is chosen at serve time");
    // F45: the harness works in <adopt dir>/work (0700), not in the shell's cwd
    assert.equal(serve.harness.cwd, "work");
    const { statSync: st } = await import("node:fs");
    assert.equal(st(join(dir, "work")).mode & 0o777, 0o700);
    const persona = await readFile(join(dir, "persona", "persona.md"), "utf8");
    assert.match(persona, /adopted by tealbrick adopt/);
    assert.match(persona, /You read papers/);
    assert.match(persona, /`knowledge__document_create`; search the web normally/, "the persona text is kept as written");
    assert.ok(!(r.out + r.err).includes(SECRET_ENV_VALUE));
    const starts = deviceStarts;
    const { statSync } = await import("node:fs");
    const statePath = join(dir, "adopt.json");
    const stateBefore = await readFile(statePath, "utf8");
    const mtimeBefore = statSync(statePath).mtimeMs;
    h.clock += 60_000;
    const again = await h.run([...sdk(), "--yes", "--json"]);
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
    const n0 = harnessIds.length;
    const r = await h.run(["adopt", "--harness", "claude-desktop", "--name", "Desk agent", "--yes", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(harnessIds.slice(n0), ["claude-desktop"], "BRG-01");
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
    // F115: undo removes the local adopt state of the card, so a re-adopt never re-uses that card id by itself
    assert.equal(existsSync(join(adoptDir(), AGT, "adopt.json")), false, "adopt state removed");
    assert.ok(u.json.done.some((l: string) => /removed the adopt state/.test(l)));
    const again = await h.run(["adopt", "--harness", "claude-desktop", "--name", "Desk agent", "--yes", "--json"]);
    assert.equal(again.code, 0, again.err);
    assert.equal(again.json.reused, false);
    assert.equal(again.json.sameCard, false);
    assert.equal(lastStart().agents[0]?.agt, undefined, "a NEW card is requested (no dead id)");
    assert.equal(lastStart().agents[0]?.name, "Desk agent", "the owner approves a named new card");
    // F114: claude-desktop has no persona, yet the approval form gets the reads of every app ticked (Core pre-ticks
    // the read ops of the suggested, deployed apps); never a write
    const grants = lastStart().agents[0]?.adopt?.grants ?? [];
    assert.deepEqual(
      grants.map((g) => g.product),
      ["connect", "evolution", "fleet", "inbox", "kanban", "knowledge", "rules"],
    );
    assert.ok(grants.every((g) => g.crud?.join() === "read"), "read only");
    const u2 = await h.run(["adopt", "--undo", "--name", "Desk agent", "--json"]);
    assert.equal(u2.code, 0, u2.err);
  });

  test("F115: a re-run whose stored connection the bridge refuses (card deleted in Portal) asks for a NEW card, never the dead id", async () => {
    const r = await h.run([...sdk(), "--yes", "--json"]);
    assert.equal(r.code, 0, r.err);
    const starts = deviceStarts;
    // quiet case (L34): a valid stored connection is reused, no device flow, the card id stays
    const ok = await h.run([...sdk(), "--yes", "--json"]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.json.reused, true);
    assert.equal(deviceStarts, starts);
    // the owner deleted the card: the bridge refuses the stored connection
    refuseTokens = 1;
    const again = await h.run([...sdk(), "--yes", "--json"]);
    assert.equal(again.code, 0, again.err);
    assert.equal(deviceStarts, starts + 1, "one new device flow");
    assert.equal(lastStart().agents[0]?.agt, undefined, "the dead card id is not sent");
    assert.equal(lastStart().agents[0]?.name, "Research agent");
    assert.match(again.err, /card agt_\w+: its stored connection is refused by the bridge .* offers a NEW card/);
    assert.equal(again.json.reused, false);
    assert.equal(refuseTokens, 0);
  });

  test("F30: --inbox buzz:<channel> adds a Buzz inbox to the serve config; a bad value is refused", async () => {
    const r = await h.run([...sdk(), "--inbox", "buzz:ch_research,buzz:ch_team", "--yes", "--json"]);
    assert.equal(r.code, 0, r.err);
    const serve = JSON.parse(await readFile(join(adoptDir(), AGT, "serve.json"), "utf8"));
    const buzz = serve.inboxes.filter((i: { tool: string }) => i.tool === "connect__buzz_read");
    assert.deepEqual(
      buzz.map((i: { args: { channel: string } }) => i.args.channel),
      ["ch_research", "ch_team"],
    );
    // F35: with Buzz channels the agent listens there only (no bot channel inbox under a read-only grant)
    assert.ok(!serve.inboxes.some((i: { tool: string }) => i.tool === "connect__channel_inbox"));
    const bad = await h.run([...sdk(), "--inbox", "slack:x", "--dry-run", "--json"]);
    assert.equal(bad.code, 2);
  });

  test("F46: products from any identifier form or the product name in prose; no owner session; never a phantom", async () => {
    const persona = join(h.home, "personas", "heinz.md");
    await writeFile(persona, "Plan work on the Kanban board.\nUse mcp__tealbrick__evolution__routines_due and `knowledge__recall`.\nSend with mcp__mail__send.\n");
    const r = await h.run(["adopt", "--harness", "claude-sdk", "--name", "Heinz", "--persona", persona, "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.err);
    // F114: every Teal Brick app is asked read (the persona's references are a subset of them)
    assert.deepEqual(
      r.json.suggestion.grants.map((g: { product: string }) => g.product),
      ["connect", "evolution", "fleet", "inbox", "kanban", "knowledge", "rules"],
    );
    assert.ok(r.json.suggestion.grants.every((g: { crud: string[]; operations?: string[] }) => g.crud.join() === "read" && !g.operations));
  });

  test("F61: --persona replaces the detected instructions; --persona-append keeps both", async () => {
    const mine = join(h.home, "personas", "clean.md");
    await writeFile(mine, "You are the desk agent. You answer short.\n");
    const detected = join(h.cwd, "CLAUDE.md");
    await writeFile(detected, "Project notes for a coding agent.\n");
    try {
      const base = ["adopt", "--harness", "claude-sdk", "--name", "Desk agent", "--dry-run", "--json"];
      const r = await h.run([...base, "--persona", mine]);
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(r.json.plan.detection.persona.files, [mine], "only the given persona");
      assert.ok(r.json.plan.detection.persona.skipped.some((x: { path: string; reason: string }) => x.path === detected && /replaced by --persona/.test(x.reason)), "the replaced file is listed");
      const both = await h.run([...base, "--persona", mine, "--persona-append"]);
      assert.equal(both.code, 0, both.err);
      assert.deepEqual(both.json.plan.detection.persona.files, [detected, mine]);
      assert.equal((await h.run([...base, "--persona-append"])).code, 2, "--persona-append alone is a usage error");
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(detected, { force: true });
    }
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
    const n0 = harnessIds.length;
    const real = await h.run(["adopt", "--harness", "codex", "--name", "Codex agent", "--agent", AGT, "--yes", "--json"]);
    assert.equal(real.code, 0, real.err);
    assert.deepEqual(harnessIds.slice(n0), ["codex-desktop"], "BRG-01: codex is the codex-desktop harness option");
    assert.equal(await readFile(cfg, "utf8"), original, "the remote entry is not rewritten");
  });
  test("F78/F79: claude-code — project scope by default (the plan says which), --serve writes a claude-code serve config; --scope user writes no file", async () => {
    const proj = join(h.home, "agents", "goobo");
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, "CLAUDE.md"), "You are Goobo. You answer in the Buzz channel.\n");
    const base = ["adopt", "--harness", "claude-code", "--name", "Goobo", "--project", proj];
    const dry = await h.run([...base, "--serve", "--dry-run"]);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out + dry.err, /MCP scope\s+project: .*agents\/goobo\/\.mcp\.json \(only Claude Code sessions in /);
    const dryJ = await h.run([...base, "--serve", "--dry-run", "--json"]);
    assert.equal(dryJ.json.scope, "project");
    assert.equal(dryJ.json.target, join(proj, ".mcp.json"));
    assert.deepEqual(dryJ.json.plan.detection.persona.files, [join(proj, "CLAUDE.md")], "--project is where the agent's CLAUDE.md is");
    assert.equal(existsSync(join(proj, ".mcp.json")), false, "dry-run writes nothing");
    const n0 = harnessIds.length;
    const r = await h.run([...base, "--serve", "--yes", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(harnessIds.slice(n0), ["claude-code"], "BRG-01");
    const entry = JSON.parse(await readFile(join(proj, ".mcp.json"), "utf8")).mcpServers.tealbrick;
    assert.equal(entry.command, process.execPath, "F77: absolute node, no bare tealbrick");
    assert.deepEqual(entry.args.slice(1, 6), ["bridge", "serve", "--stdio", "--agent", AGT]);
    const serve = JSON.parse(await readFile(join(adoptDir(), AGT, "serve.json"), "utf8"));
    assert.deepEqual(serve.harness, { kind: "claude-code", cwd: proj });
    assert.equal(validateServeConfig(serve).harness.kind, "claude-code");
    assert.match(r.json.serve, /agent serve --file .*serve\.json --agent agt_\w+ --detach$/);
    assert.equal(r.json.scope, "project");
    const u = await h.run(["adopt", "--undo", "--name", "Goobo", "--json"]);
    assert.equal(u.code, 0, u.err);
    assert.equal(existsSync(join(proj, ".mcp.json")), false, "undo removes the .mcp.json adopt created");
    // explicit user scope: printed only (Claude Code's own ~/.claude.json is never edited)
    const usr = await h.run(["adopt", "--harness", "claude-code", "--name", "Goobo user", "--scope", "user", "--yes", "--json"]);
    assert.equal(usr.code, 0, usr.err);
    assert.equal(usr.json.scope, "user");
    assert.match(usr.json.mcpAdd, /^claude mcp add --scope user tealbrick -- \S+ \S+main\.ts bridge serve --stdio --agent agt_/);
    assert.equal(existsSync(join(h.cwd, ".mcp.json")), false);
    assert.equal(existsSync(join(h.home, ".claude.json")), false);
    assert.equal((await h.run(["adopt", "--harness", "codex", "--name", "x", "--scope", "user", "--dry-run"])).code, 2, "--scope is for claude-code");
  });
});
