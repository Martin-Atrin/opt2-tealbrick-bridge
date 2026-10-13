/**
 * CLI 0.1.19. F66: `agent serve --detach` starts the supervised loop in the background (pidfile, log) and
 * `agent stop` ends it via its own pidfile (L20) and reports only when the process is gone (L28). F68: the shipped
 * serve example is valid and current. F60/F71: the install brings the Claude Agent SDK, and one bridge copy only.
 * F72: the relay accepts --log-file (agent serve passes its log so drain re-sends are visible there).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { manifestApi } from "@opt2-tealbrick/bridge";
import { relayMain } from "../src/relay-main.ts";
import { validateServeConfig } from "../src/serve.ts";
import { configDir, createFileStore } from "../src/store.ts";
import { heartbeatPath, isAlive, pidPath, readPid } from "../src/supervise.ts";
import { Harness } from "./fixtures.ts";

const api = manifestApi();
const BRG = "brg_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const WS = "ws_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const AGT = "agt_01HAAAAAAAAAAAAAAAAAAAAAAA";
const CON = "con_01HAAAAAAAAAAAAAAAAAAAAAAA";
const pkg = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

describe("F66: agent serve --detach and agent stop (own pidfile only)", () => {
  const h = new Harness();
  let bridge: Server;
  let started: number | undefined;

  before(async () => {
    await h.setup();
    h.injectStore = false;
    h.env.TB_CREDENTIAL_STORE = "file";
    bridge = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/oauth/token") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "k5-access", token_type: "Bearer", expires_in: 900 }));
      if (req.url === "/mcp" && req.method === "POST") {
        const m = JSON.parse(body);
        if (m.id === undefined) return res.writeHead(202).end();
        const result = m.method === "initialize" ? { protocolVersion: "2025-06-18" } : m.method === "tools/list" ? { tools: [{ name: "notes__notes_list", annotations: { readOnlyHint: true } }] } : { content: [], structuredContent: { messages: [] } };
        return res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      }
      res.writeHead(405).end();
    });
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
    const key = await api.generateKeyPair();
    const item = { v: 1, kind: "agent", con: CON, agt: AGT, ws: WS, bridgeId: BRG, bridgeUrl: url, tokenEndpoint: `${url}/oauth/token`, harness: "tealbrick-cli", label: "test", publicJwk: key.publicJwk, privateKey: Buffer.from(await api.exportPrivateKey(key)).toString("base64url"), createdAt: new Date().toISOString() };
    await createFileStore(configDir(h.env)).put(`tealbrick.agent.${CON}`, JSON.stringify(item));
  });
  after(async () => {
    // only the process this test started, read from its own pidfile (L20)
    const held = await readPid(pidPath(configDir(h.env), CON));
    if (held && held.pid === started && isAlive(held.pid)) process.kill(held.pid, "SIGKILL");
    bridge.closeAllConnections();
    await new Promise((r) => bridge.close(r));
    await h.teardown();
  });

  test("--detach starts the supervisor with a pidfile and log; a second --detach is refused; agent stop ends it", async () => {
    const file = join(h.cwd, "serve.json");
    await writeFile(file, JSON.stringify({ format: "tealbrick.agent-serve/1", harness: { kind: "command", command: ["true"] }, pollSeconds: 5, inboxes: [{ tool: "notes__notes_list", items: "messages", id: "id" }] }));
    const r = await h.run(["agent", "serve", "--file", file, "--agent", AGT, "--detach", "--json"]);
    assert.equal(r.code, 0, r.err);
    started = r.json.started.pid as number;
    assert.equal(r.json.started.log, join(h.cwd, "serve.log"));
    const pf = pidPath(configDir(h.env), CON);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const held = await readPid(pf);
      const hb = await readFile(heartbeatPath(configDir(h.env), CON), "utf8").catch(() => "");
      if (held?.pid === started && hb) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal((await readPid(pf))?.pid, started, "the supervisor holds the connection's pidfile");
    const again = await h.run(["agent", "serve", "--file", file, "--agent", AGT, "--detach", "--json"]);
    assert.equal(again.code, 7, "one loop per connection");
    assert.equal(again.json.error.code, "already_running");
    h.clock = Date.now();
    const stop = await h.run(["agent", "stop", "--agent", AGT, "--json"]);
    assert.equal(stop.code, 0, stop.err);
    assert.equal(stop.json.stopped, started);
    assert.equal(isAlive(started), false, "the process is gone (L28)");
    const log = await readFile(join(h.cwd, "serve.log"), "utf8");
    assert.match(log, /serve\.supervisor\.started/);
    const none = await h.run(["agent", "stop", "--agent", AGT, "--json"]);
    assert.equal(none.code, 0, none.err);
    assert.equal(none.json.stopped, null, "nothing running: nothing signalled");
  });
});

describe("F68 / F60 / F71 / F72: shipped example, dependencies, relay log file", () => {
  test("F68: assets/agent-serve.example.json is valid and current (auto inbox, persona file, transcripts, no key env)", () => {
    const raw = JSON.parse(readFileSync(new URL("../assets/agent-serve.example.json", import.meta.url), "utf8"));
    const cfg = validateServeConfig(structuredClone(raw));
    assert.deepEqual(raw.inboxes, [{ auto: "connect", wake: "mentions" }]);
    assert.equal(cfg.harness.kind, "claude");
    assert.equal(raw.harness.appendSystemPromptFile, "persona.md");
    assert.equal(raw.harness.transcripts, "transcripts");
    assert.equal(raw.harness.modelKeyEnv, undefined, "a signed-in Claude needs no API key name");
    assert.ok(!JSON.stringify(raw).includes("channel_inbox"), "no manual Connect inbox");
  });

  test("F60: the CLI install brings the Claude Agent SDK (exact pin); F71: harness-claude has no runtime bridge copy", () => {
    const cli = pkg("../package.json");
    assert.match(cli.dependencies?.["@anthropic-ai/claude-agent-sdk"] ?? "", /^\d+\.\d+\.\d+$/, "pinned exactly");
    const harness = pkg("../../harness-claude/package.json");
    assert.equal(harness.dependencies?.["@opt2-tealbrick/bridge"], undefined, "only the CLI's bridge is installed");
    assert.ok(harness.devDependencies?.["@opt2-tealbrick/bridge"], "types only, at build time");
  });

  test("F72: bridge serve --stdio accepts --log-file (a usage error would mean agent serve's relay never starts)", async () => {
    const saved = process.env.TB_CREDENTIAL_STORE;
    const savedDir = process.env.XDG_CONFIG_HOME;
    process.env.TB_CREDENTIAL_STORE = "file";
    process.env.XDG_CONFIG_HOME = join(process.cwd(), "does-not-exist-tb-test");
    const errWrite = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((c: string) => {
      err += c;
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await relayMain(["node", "tealbrick", "--stdio", "--log-file", "/tmp/unused.log", "--agent", AGT]);
      assert.notEqual(code, 2, err);
      assert.doesNotMatch(err, /unknown option/);
    } finally {
      process.stderr.write = errWrite;
      if (saved === undefined) delete process.env.TB_CREDENTIAL_STORE;
      else process.env.TB_CREDENTIAL_STORE = saved;
      if (savedDir === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedDir;
    }
  });
});
