/**
 * C96 onboarding friction: headless agents use TB_CREDENTIAL_STORE=file. `agent serve` hands the relay command to
 * harness-claude, which starts it with `sessionEnv` — every TB_* name and XDG_CONFIG_HOME dropped — so the relay fell
 * back to the keychain and found no agent. The store choice now travels as argv (`--store file --config-dir <d>`).
 * Real path, no keychain: the actual CLI relay process, started with harness-claude's REAL sessionEnv, against a REAL
 * bridge (test world), answers MCP for the agent whose item lives only in the file store.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sessionEnv } from "@opt2-tealbrick/harness-claude";
import { AGT, BRG, CON, makeWorld, type World, WS } from "../../bridge/test/support/world.ts";
import { stdioArgs } from "../src/connect.ts";
import { AGENT_ITEM_PREFIX, createFileStore, relayStoreArgs } from "../src/store.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** Starts `tealbrick bridge serve` exactly like a harness would and returns the first answer to `initialize`. */
function relay(args: string[], env: Record<string, string>): Promise<{ answer?: { result?: unknown; error?: unknown }; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let done = false;
    const finish = (answer?: { result?: unknown; error?: unknown }) => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      resolve({ ...(answer ? { answer } : {}), stderr: err, code: child.exitCode });
    };
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      for (const line of out.split("\n").filter(Boolean)) {
        try {
          const m = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (m.id === 1) finish(m);
        } catch {
          /* partial line */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("exit", () => setTimeout(() => finish(), 50));
    setTimeout(() => finish(), 20_000);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "headless-test" } } })}\n`);
  });
}

describe("headless file store: the relay a harness starts finds the agent (C96)", () => {
  let w: World;
  let home: string;
  let cfgDir: string;
  before(async () => {
    w = await makeWorld({ real: true });
    home = mkdtempSync(join(tmpdir(), "tb-headless-"));
    cfgDir = join(home, "cfg", "tealbrick");
    // the agent item lives ONLY in the file store (no keychain on this "machine")
    const pkcs8 = await w.api.exportPrivateKey(w.agentKey);
    await createFileStore(cfgDir).put(
      `${AGENT_ITEM_PREFIX}${CON}`,
      JSON.stringify({ v: 1, kind: "agent", con: CON, agt: AGT, ws: WS, bridgeId: BRG, bridgeUrl: w.publicUrl, tokenEndpoint: `${w.publicUrl}/oauth/token`, harness: "claude", label: "headless", publicJwk: w.agentKey.publicJwk, privateKey: Buffer.from(pkcs8).toString("base64url"), createdAt: new Date().toISOString() }),
    );
  });
  after(async () => {
    await w.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("relayStoreArgs carries the file-store choice; keychain needs none", () => {
    assert.deepEqual(relayStoreArgs({ TB_CREDENTIAL_STORE: "file", XDG_CONFIG_HOME: join(home, "cfg") }), ["--store", "file", "--config-dir", cfgDir]);
    assert.deepEqual(relayStoreArgs({}), []);
    assert.deepEqual(relayStoreArgs({ TB_CREDENTIAL_STORE: "keychain" }), []);
    assert.deepEqual(stdioArgs("agt_x", { TB_CREDENTIAL_STORE: "file", XDG_CONFIG_HOME: join(home, "cfg") }).slice(-4), ["--store", "file", "--config-dir", cfgDir], "tealbrick connect writes it into harness configs too");
  });

  test("with the store args, the relay started under harness-claude's sessionEnv answers initialize", async () => {
    const hostEnv = { ...process.env, HOME: home, TB_CREDENTIAL_STORE: "file", XDG_CONFIG_HOME: join(home, "cfg") };
    const env = sessionEnv(hostEnv);
    assert.equal(env.TB_CREDENTIAL_STORE, undefined, "the harness really drops the store choice from the env");
    assert.equal(env.XDG_CONFIG_HOME, undefined);
    const r = await relay(["bridge", "serve", "--stdio", "--agent", AGT, ...relayStoreArgs(hostEnv)], env);
    assert.ok(r.answer?.result, `relay answered initialize (stderr: ${r.stderr.slice(0, 400)})`);
  });

  // never let a test query a developer's real macOS keychain (LEARNINGS L15): the bug path runs on Linux (CI) only
  test("without them (the reported bug) the relay finds no agent", { skip: process.platform === "darwin" ? "would query the real macOS keychain; runs in CI (Linux)" : false }, async () => {
    const hostEnv = { ...process.env, HOME: home, TB_CREDENTIAL_STORE: "file", XDG_CONFIG_HOME: join(home, "cfg") };
    const r = await relay(["bridge", "serve", "--stdio", "--agent", AGT], sessionEnv(hostEnv));
    assert.equal(r.answer?.result, undefined);
    assert.match(r.stderr, /no agent item|keychain|no OS keychain/i);
  });
});
