/**
 * F77 / F79 (Goobo plug-in recipe): a Claude Code project folder woken by `agent serve` with NO hand-written files.
 * F77: `tealbrick connect claude-code` writes a relay command (absolute node + this install's main.ts/js + store args)
 * that a harness can start with its filtered env and NO `tealbrick` on PATH; it answers MCP for the agent against a
 * REAL bridge (test world). F79: the built-in `claude-code` serve harness runs a fake `claude` on PATH: exact argv
 * (MCP-only default, config adds tools only), the per-turn MCP config (0600, only the relay, onBehalfOf narrowing)
 * removed after the turn, the result fields logged without payload, and a timeout that kills ONLY its own child.
 * Proof boundary: `claude` is a test double; the relay and the bridge are real.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sessionEnv } from "@opt2-tealbrick/harness-claude";
import { channelSenderId } from "@opt2-tealbrick/manifest";
import { AGT, BRG, CON, makeWorld, type World, WS } from "../../bridge/test/support/world.ts";
import { run } from "../src/cli.ts";
import { relayCommand } from "../src/connect.ts";
import { decodeOnBehalfOf } from "../src/relay-main.ts";
import { CLAUDE_CODE_DISALLOWED, claudeCodeArgs, claudeCodeRunner, validateServeConfig } from "../src/serve.ts";
import { AGENT_ITEM_PREFIX, createFileStore } from "../src/store.ts";

const FAKE = fileURLToPath(new URL("./support/fake-claude-cli.ts", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../assets/agent-serve.claude-code.example.json", import.meta.url));

/** An Io for `run` that collects stdout/stderr. */
function captureIo(env: Record<string, string>): { io: never; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  const io = { stdout: { write: (s: string) => o.push(s) > 0 }, stderr: { write: (s: string) => e.push(s) > 0 }, stdin: process.stdin, env, fetch: globalThis.fetch } as never;
  return { io, out: () => o.join(""), err: () => e.join("") };
}

function initialize(command: string, args: string[], env: Record<string, string>): Promise<{ result?: unknown; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let done = false;
    const finish = (result?: unknown) => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      resolve({ ...(result ? { result } : {}), stderr: err });
    };
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      for (const line of out.split("\n").filter(Boolean)) {
        try {
          const m = JSON.parse(line) as { id?: number; result?: unknown };
          if (m.id === 1) finish(m.result);
        } catch {
          /* partial */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      err += String(e);
      finish();
    });
    child.on("exit", () => setTimeout(() => finish(), 50));
    setTimeout(() => finish(), 20_000).unref();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "f77" } } })}\n`);
  });
}

describe("Claude Code plug-in recipe (F77, F79)", () => {
  let w: World;
  let root: string;
  let hostEnv: Record<string, string>;
  let bin: string;
  let project: string;
  before(async () => {
    w = await makeWorld({ real: true });
    root = realpathSync(mkdtempSync(join(tmpdir(), "tb-cc-")));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const pkcs8 = await w.api.exportPrivateKey(w.agentKey);
    await createFileStore(join(home, "cfg", "tealbrick")).put(
      `${AGENT_ITEM_PREFIX}${CON}`,
      JSON.stringify({ v: 1, kind: "agent", con: CON, agt: AGT, ws: WS, bridgeId: BRG, bridgeUrl: w.publicUrl, tokenEndpoint: `${w.publicUrl}/oauth/token`, harness: "generic-mcp", label: "cc", publicJwk: w.agentKey.publicJwk, privateKey: Buffer.from(pkcs8).toString("base64url"), createdAt: new Date().toISOString() }),
    );
    // a fake `claude` on PATH; NO tealbrick anywhere on PATH (folder-local install)
    bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    project = join(root, "goobo", "work");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "CLAUDE.md"), "You are a test agent.\n");
    hostEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, USER: "tester", TMPDIR: join(root, "tmp"), TB_CREDENTIAL_STORE: "file", XDG_CONFIG_HOME: join(home, "cfg"), TB_PORTAL_URL: "https://portal.example.test", FAKE_CLAUDE_RECORD: join(root, "record.json"), SECRET_THING: "must-not-pass" };
    mkdirSync(hostEnv.TMPDIR as string);
  });
  after(async () => {
    await w.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("F77: connect claude-code --write puts an absolute relay command in <project>/.mcp.json that works with no tealbrick on PATH", async () => {
    const c = captureIo(hostEnv);
    const code = await run(["connect", "claude-code", "--agent", AGT, "--project", project, "--write", "--yes", "--json"], c.io);
    assert.equal(code, 0, c.err());
    assert.equal(JSON.parse(c.out()).scope, "project");
    const entry = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")).mcpServers.tealbrick as { command: string; args: string[] };
    assert.equal(entry.command, process.execPath, "absolute node");
    assert.match(entry.args[0] as string, /^\/.*\/main\.(ts|js)$/, "absolute main of THIS install");
    assert.deepEqual(entry.args.slice(1), ["bridge", "serve", "--stdio", "--agent", AGT, "--store", "file", "--config-dir", join(hostEnv.HOME as string, "cfg", "tealbrick")]);
    assert.ok(!JSON.stringify(entry).includes('"tealbrick"'), "never a bare tealbrick command");
    // started like a harness would: filtered env, no tealbrick on PATH
    const env = sessionEnv(hostEnv);
    assert.equal(env.TB_CREDENTIAL_STORE, undefined);
    const r = await initialize(entry.command, entry.args, env);
    assert.ok(r.result, `the relay answered initialize (stderr: ${r.stderr.slice(0, 300)})`);
  });

  test("F78: user scope is printed only; --write with --scope user is refused; the plan names the scope", async () => {
    const { io, out } = captureIo(hostEnv);
    assert.equal(await run(["connect", "claude-code", "--agent", AGT, "--scope", "user"], io), 0);
    assert.match(out(), /scope user: every Claude Code session/);
    assert.match(out(), new RegExp(`claude mcp add --scope user tealbrick -- ${process.execPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} /`));
    assert.equal(await run(["connect", "claude-code", "--agent", AGT, "--scope", "user", "--write", "--yes"], io), 2);
    assert.equal(await run(["connect", "claude-code", "--agent", AGT, "--scope", "team"], io), 2);
    assert.equal(await run(["connect", "codex", "--agent", AGT, "--scope", "user"], io), 2, "--scope is for claude-code");
  });

  test("F79: validation — kind claude-code needs cwd; allowedTools may only ADD; the shipped example is valid", () => {
    const base = { format: "tealbrick.agent-serve/1", inboxes: [{ auto: "connect" }] };
    assert.throws(() => validateServeConfig({ ...base, harness: { kind: "claude-code" } }), /harness\.cwd/);
    assert.throws(() => validateServeConfig({ ...base, harness: { kind: "claude-code", cwd: ".", allowedTools: ["Read", "Bash"] } }), /Bash cannot be allowed/);
    assert.throws(() => validateServeConfig({ ...base, harness: { kind: "claude-code", cwd: ".", allowedTools: ["Read,Bash"] } }), /allowedTools/);
    assert.throws(() => validateServeConfig({ ...base, harness: { kind: "claude-code", cwd: ".", maxTurns: 0 } }), /maxTurns/);
    assert.throws(() => validateServeConfig({ ...base, harness: { kind: "claude-code", cwd: ".", model: "x y" } }), /model/);
    assert.throws(() => validateServeConfig({ ...base, harness: { kind: "claude-code", cwd: ".", turnTimeoutSeconds: 5 } }), /turnTimeoutSeconds/);
    assert.throws(() => validateServeConfig({ ...base, harness: { kind: "claude-code", cwd: ".", passthroughEnv: ["A B"] } }), /passthroughEnv/);
    const ex = validateServeConfig(JSON.parse(readFileSync(EXAMPLE, "utf8")));
    assert.equal(ex.harness.kind, "claude-code");
    assert.deepEqual(claudeCodeArgs({ kind: "claude-code", cwd: "." }, "/t/mcp.json"), ["-p", "--output-format", "json", "--max-turns", "20", "--no-session-persistence", "--mcp-config", "/t/mcp.json", "--strict-mcp-config", "--allowedTools", "mcp__tealbrick", "--disallowedTools", ...CLAUDE_CODE_DISALLOWED]);
    // F104 (L29): no session transcript under ~/.claude/projects/ by default; persistSession: true is Claude Code's default
    assert.ok(!claudeCodeArgs({ kind: "claude-code", cwd: ".", persistSession: true }, "/t/mcp.json").includes("--no-session-persistence"));
    assert.throws(() => validateServeConfig({ ...base, harness: { kind: "claude-code", cwd: ".", persistSession: "yes" } }), /persistSession/);
  });

  test("F79: one turn — exact argv, MCP config 0600 with only the relay (+ onBehalfOf), env allow-list, real relay answers, temp removed, result logged without payload", async () => {
    const logs: { event: string; fields?: Record<string, unknown> }[] = [];
    const relay = relayCommand(AGT, hostEnv);
    const h = { kind: "claude-code" as const, cwd: "work", maxTurns: 7, allowedTools: ["Read"], model: "sonnet", passthroughEnv: ["FAKE_CLAUDE_RECORD", "FAKE_CLAUDE_MODE"] };
    validateServeConfig({ format: "tealbrick.agent-serve/1", harness: h, inboxes: [{ auto: "connect" }] });
    const runTurn = await claudeCodeRunner(h, relay, join(root, "goobo"), { env: { ...hostEnv, FAKE_CLAUDE_MODE: "ok" }, log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }) });
    const claim = { kind: "channel_sender" as const, id: channelSenderId("telegram", "424242"), display: "Sender" };
    const r = await runTurn("PROMPT_TEXT mention", { onHeld: () => undefined }, { onBehalfOf: claim });
    const rec = JSON.parse(readFileSync(hostEnv.FAKE_CLAUDE_RECORD as string, "utf8"));
    assert.equal(r.ok, true);
    assert.deepEqual(rec.argv, ["-p", "--output-format", "json", "--max-turns", "7", "--model", "sonnet", "--no-session-persistence", "--mcp-config", rec.mcpConfigPath, "--strict-mcp-config", "--allowedTools", "mcp__tealbrick", "Read", "--disallowedTools", "Bash", "WebFetch", "WebSearch", "Write", "Edit"]);
    assert.equal(rec.cwd, project, "runs in the project folder (relative to the config)");
    assert.equal(rec.prompt, "PROMPT_TEXT mention", "prompt on stdin");
    assert.equal(rec.mcpConfigMode, 0o600);
    assert.ok((rec.mcpConfigPath as string).startsWith(join(hostEnv.TMPDIR as string, "tealbrick-cc-")));
    assert.deepEqual(Object.keys(rec.mcpConfig.mcpServers), ["tealbrick"], "the ONLY server is this turn's relay");
    const srv = rec.mcpConfig.mcpServers.tealbrick as { command: string; args: string[] };
    assert.equal(srv.command, process.execPath);
    assert.deepEqual(srv.args.slice(0, -2), relay.args);
    assert.equal(srv.args.at(-2), "--on-behalf-of");
    assert.deepEqual(decodeOnBehalfOf(srv.args.at(-1) as string), claim, "L13: the sender claim travels to the relay of THIS turn");
    assert.ok(rec.initialize?.result, `the real relay answered (stderr: ${String(rec.relayStderr).slice(0, 300)})`);
    for (const n of ["HOME", "USER", "PATH", "FAKE_CLAUDE_RECORD"]) assert.ok(rec.envNames.includes(n), `${n} passed`);
    for (const n of ["TB_CREDENTIAL_STORE", "TB_PORTAL_URL", "XDG_CONFIG_HOME", "SECRET_THING"]) assert.ok(!rec.envNames.includes(n), `${n} dropped`);
    assert.equal(existsSync(rec.mcpConfigPath), false, "temp MCP config removed after the turn");
    assert.equal(existsSync(join(rec.mcpConfigPath, "..")), false, "temp dir removed");
    const res = logs.find((l) => l.event === "serve.turn.result")?.fields;
    assert.deepEqual({ ...res, wallMs: 0, stderrBytes: 0 }, { harness: "claude-code", ok: true, exitCode: 0, isError: false, subtype: "success", numTurns: 3, durationMs: 1234, costUsd: 0.12, permissionDenials: 2, inputTokens: 10, cacheCreationInputTokens: 1000, cacheReadInputTokens: 25000, outputTokens: 100, model: "claude-sonnet-x", wallMs: 0, stderrBytes: 0 });
    assert.ok(!JSON.stringify(logs).includes("PRIVATE_RESULT_TEXT") && !JSON.stringify(logs).includes("PROMPT_TEXT"), "no payload in the log");
    // without a sender: no claim argument
    await runTurn("p2", { onHeld: () => undefined });
    const rec2 = JSON.parse(readFileSync(hostEnv.FAKE_CLAUDE_RECORD as string, "utf8"));
    assert.deepEqual(rec2.mcpConfig.mcpServers.tealbrick.args, relay.args);
  });

  test("F79: an is_error result is a failed turn; a missing project folder is refused at start", async () => {
    const logs: { event: string; fields?: Record<string, unknown> }[] = [];
    const runTurn = await claudeCodeRunner({ kind: "claude-code", cwd: project, passthroughEnv: ["FAKE_CLAUDE_RECORD", "FAKE_CLAUDE_MODE"] }, relayCommand(AGT, hostEnv), root, { env: { ...hostEnv, FAKE_CLAUDE_MODE: "error" }, log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }) });
    const r = await runTurn("x", { onHeld: () => undefined });
    assert.equal(r.ok, false);
    assert.equal(logs[0]?.fields?.isError, true);
    assert.equal(logs[0]?.fields?.exitCode, 1);
    assert.equal(logs[0]?.fields?.subtype, "error_max_turns");
    await assert.rejects(claudeCodeRunner({ kind: "claude-code", cwd: "nope" }, relayCommand(AGT, hostEnv), root), /is not a folder/);
  });

  test("F79: a turn past its timeout gets SIGTERM then SIGKILL — only the runner's own child; a bystander process lives on", async () => {
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const logs: { event: string; fields?: Record<string, unknown> }[] = [];
      const runTurn = await claudeCodeRunner({ kind: "claude-code", cwd: project, passthroughEnv: ["FAKE_CLAUDE_RECORD", "FAKE_CLAUDE_MODE"] }, relayCommand(AGT, hostEnv), root, { env: { ...hostEnv, FAKE_CLAUDE_MODE: "hang" }, turnTimeoutMs: 1_500, killGraceMs: 500, log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }) });
      const r = await runTurn("x", { onHeld: () => undefined });
      assert.equal(r.ok, false);
      assert.equal(r.summary, "turn timed out");
      const rec = JSON.parse(readFileSync(hostEnv.FAKE_CLAUDE_RECORD as string, "utf8"));
      assert.equal(rec.sawSigterm, true, "SIGTERM first");
      assert.equal(logs[0]?.fields?.timedOut, true);
      assert.equal(logs[0]?.fields?.signal, "SIGKILL", "escalated after the grace");
      assert.throws(() => process.kill(rec.pid, 0), "the own child is gone");
      assert.equal(bystander.exitCode, null);
      assert.doesNotThrow(() => process.kill(bystander.pid as number, 0), "a process the runner did not start is untouched");
      assert.equal(existsSync(rec.mcpConfigPath), false, "temp removed after a timeout too");
    } finally {
      bystander.kill("SIGTERM");
    }
  });
});
