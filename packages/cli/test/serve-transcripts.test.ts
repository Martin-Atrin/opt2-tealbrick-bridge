/**
 * F48: a serve turn writes nothing outside the agent's own folder — no SDK session under ~/.claude/projects/
 * (persistSession false), and the turn is logged to <config dir>/transcripts/ (0700 / 0600). The login is untouched
 * (no CLAUDE_CONFIG_DIR, the env is the harness's normal session env). Proof boundary: the SDK is a test double that
 * follows the documented persistSession behaviour; the option itself reaches the real SDK unchanged (buildOptions).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeRunner } from "../src/serve.ts";

const FAKE = fileURLToPath(new URL("./support/fake-claude-sdk.ts", import.meta.url));

describe("F48: serve transcripts stay inside the agent folder", () => {
  const root = mkdtempSync(join(tmpdir(), "tb-f48-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  const listAll = (d: string): string[] => readdirSync(d, { recursive: true }).map((f) => join(d, String(f)));

  it("persistSession false + transcripts dir: the only new files are under the adopt dir", async () => {
    const home = join(root, "home");
    const adopt = join(root, "home", ".config", "tealbrick", "adopt", "agt_x");
    mkdirSync(join(adopt, "work"), { recursive: true });
    process.env.FAKE_SDK_HOME = home;
    const before = new Set(listAll(home));
    const logs: { event: string; fields?: Record<string, unknown> }[] = [];
    const run = await claudeRunner({ kind: "claude", cwd: "work", transcripts: "transcripts", sdkModule: FAKE }, "agt_x", { command: "tealbrick", args: ["bridge", "serve"] }, adopt, { log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }) });
    const r = await run("hello agent", { onHeld: () => undefined });
    assert.equal(r.ok, true);
    const opts = JSON.parse(readFileSync(join(home, "options.json"), "utf8")) as Record<string, unknown>;
    assert.equal(opts.persistSession, false);
    assert.deepEqual(opts.settings, { autoMemoryEnabled: false }, "F54: auto-memory off by default");
    assert.equal(opts.cwd, join(adopt, "work"), "F45: the harness works in <adopt>/work");
    assert.equal(existsSync(join(home, ".claude")), false, "no ~/.claude/projects transcript");
    const added = listAll(home).filter((f) => !before.has(f) && f !== join(home, "options.json"));
    assert.ok(added.length > 0);
    for (const f of added) assert.ok(f.startsWith(`${adopt}/`), `written outside the adopt dir: ${f}`);
    const tdir = join(adopt, "transcripts");
    assert.equal(statSync(tdir).mode & 0o777, 0o700);
    const file = join(tdir, readdirSync(tdir)[0] as string);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].type, "prompt");
    assert.ok(lines.some((l) => l.type === "result" && l.ok === true));
    // F57: each tool call's outcome is recorded (isError + the error code), never the payload
    assert.ok(lines.some((l) => l.type === "tool_result" && l.name === "mcp__tealbrick__connect__buzz_post" && l.isError === true && l.code === "hook_failed"));
    assert.ok(lines.some((l) => l.type === "tool_result" && l.name === "mcp__tealbrick__knowledge__recall" && l.isError === false && l.code === undefined));
    assert.ok(!readFileSync(file, "utf8").includes("items"), "no tool payload in the transcript");
    // usage per turn (coordinator 2026-10-13): modelUsage summed over models (main + helper), cost, turns, main model
    const usage = { inputTokens: 5, cacheCreationInputTokens: 40, cacheReadInputTokens: 400, outputTokens: 9, costUsd: 0.05, numTurns: 2, model: "claude-test-model" };
    assert.deepEqual(lines.find((l) => l.type === "result")?.usage, usage, "the transcript result line carries the usage");
    assert.deepEqual(logs, [{ event: "serve.turn.result", fields: { harness: "claude", ok: true, ...usage } }], "one serve log line per turn, no payload");
  });

  it("F54: harness.memory keeps auto-memory inside the agent folder", async () => {
    const home = join(root, "home3");
    const adopt = join(home, "adopt");
    mkdirSync(adopt, { recursive: true });
    process.env.FAKE_SDK_HOME = home;
    const run = await claudeRunner({ kind: "claude", cwd: ".", memory: "memory", sdkModule: FAKE }, "agt_x", { command: "tealbrick", args: [] }, adopt);
    await run("x", { onHeld: () => undefined });
    assert.equal(existsSync(join(home, ".claude")), false);
    assert.equal(existsSync(join(adopt, "memory")), true);
  });

  it("persistSession true is an explicit opt-in (the SDK then writes its own transcript)", async () => {
    const home = join(root, "home2");
    mkdirSync(home, { recursive: true });
    process.env.FAKE_SDK_HOME = home;
    const run = await claudeRunner({ kind: "claude", cwd: home, persistSession: true, sdkModule: FAKE }, "agt_x", { command: "tealbrick", args: [] }, home);
    await run("x", { onHeld: () => undefined });
    assert.equal(existsSync(join(home, ".claude", "projects")), true);
  });
});
