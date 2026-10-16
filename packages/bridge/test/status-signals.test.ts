/**
 * Spec 0.1.28 (F89): AppStatus.attention reaches StatusReport.apps[].attention unchanged; absence stays absent.
 * BRG-08 (L3): a config that arrives but cannot be APPLIED is a status signal (rejected config/apply_failed) and an
 * error line, never `pull_failed {code:"network"}`; the running table keeps serving and the next pull recovers.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { buildStatusReport } from "../src/portal.ts";
import type { Logger } from "../src/util.ts";
import { APP_CODE, BRG, INS, makeWorld, type World, waitFor } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);

describe("F89: app attention in the status report", () => {
  let w: World;
  before(async () => {
    w = await makeWorld({ real: true });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
  });
  after(async () => {
    await w.close();
  });

  test("attention passes through unchanged; a later status without it removes it; absent stays absent", async () => {
    const api = w.api;
    const appKey = await api.generateKeyPair();
    const claim = await fetch(`${w.internalUrl}/tb/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: APP_CODE, instancePublicKey: appKey.publicJwk, manifestDigest: w.bridge.ctx.table?.config.apps[0]?.manifestDigest, version: "1.0.0", sdkVersion: "0.1.20" }),
    });
    assert.equal(claim.status, 200);
    const status = async (extra: Record<string, unknown>) => {
      const pathAndQuery = "/tb/v1/status?wait=0";
      const body = Buffer.from(JSON.stringify({ readiness: "degraded", version: "1.0.0", sdkVersion: "0.1.20", scopesRev: 0, sliceRevision: -1, keysRev: -1, pendingHolds: 0, ...extra }));
      const assertion = await api.signAssertion("tb-instance-assert+jwt", { iss: `tb:ins:${INS}`, sub: `tb:ins:${INS}`, aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 60, jti: api.ulid() }, appKey, { method: "POST", pathAndQuery, body });
      const r = await fetch(`${w.internalUrl}${pathAndQuery}`, { method: "POST", headers: { "content-type": "application/json", "TB-Assert": assertion }, body });
      await r.body?.cancel();
      assert.ok(r.status === 200 || r.status === 204, `status accepted (${r.status})`);
    };
    const appOf = (r: { apps: { ins: string }[] }) => r.apps.find((a) => a.ins === INS) as Record<string, unknown> | undefined;

    const attention = { code: "backup_failing", reason: "The last 3 backups failed. Check the volume." };
    const acksBefore = w.acks.length;
    await status({ attention });
    assert.deepEqual(appOf(buildStatusReport(w.bridge.ctx))?.attention, attention, "copied unchanged");
    // the change pokes the status loop: Portal receives it without waiting for the 5 min period
    await waitFor(() => w.acks.slice(acksBefore).some((r) => JSON.stringify(appOf(r)?.attention) === JSON.stringify(attention)), 15000);

    await status({});
    const cleared = appOf(buildStatusReport(w.bridge.ctx));
    assert.ok(cleared, "the app is listed");
    assert.ok(!("attention" in cleared), "no attention in the app status -> no attention key in the report");
    for (const a of buildStatusReport(w.bridge.ctx).apps) if (a.ins !== INS) assert.ok(!("attention" in a), "apps that never reported attention carry no key");

    // spec 0.1.39 (C213 US-2): schemaVersion / minCompatibleCode / failure pass through (shape-checked); a change pokes Portal
    const failure = { phase: "app_migrations", code: "migration_failed", file: "0003_bad.sql", at: "2026-10-16T14:46:23.400Z" };
    const acks2 = w.acks.length;
    await status({ attention: { code: "migration_failed", reason: "x" }, schemaVersion: { app: 2, sdk: 5 }, minCompatibleCode: "1.0.0", failure, preUpdateSnapshot: { file: "tb-preupdate-to-2.0.0.tar.gz" } });
    const up = appOf(buildStatusReport(w.bridge.ctx));
    assert.deepEqual(up?.schemaVersion, { app: 2, sdk: 5 });
    assert.equal(up?.minCompatibleCode, "1.0.0");
    assert.deepEqual(up?.failure, failure);
    assert.ok(!("preUpdateSnapshot" in (up ?? {})), "only the three Portal members are forwarded");
    await waitFor(() => w.acks.slice(acks2).some((r) => JSON.stringify(appOf(r)?.failure) === JSON.stringify(failure)), 15000);
    // malformed values are dropped, never forwarded
    await status({ schemaVersion: { app: -1, sdk: 5 }, minCompatibleCode: "<script>", failure: { phase: "evil", code: "x", at: "now" } });
    const bad = appOf(buildStatusReport(w.bridge.ctx)) ?? {};
    for (const k of ["schemaVersion", "minCompatibleCode", "failure"]) assert.ok(!(k in bad), `${k} dropped`);
    await status({ failure: { ...failure, file: "../../etc/passwd", reason: "Some Text" } });
    assert.deepEqual(appOf(buildStatusReport(w.bridge.ctx))?.failure, { phase: failure.phase, code: failure.code, at: failure.at }, "bad file/reason dropped, rest kept");
  });
});

describe("BRG-08: an apply failure is a status signal, not a network blip", () => {
  let w: World;
  const lines: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info: (event, fields) => lines.push({ level: "info", event, ...(fields ? { fields } : {}) }),
    warn: (event, fields) => lines.push({ level: "warn", event, ...(fields ? { fields } : {}) }),
    error: (event, fields) => lines.push({ level: "error", event, ...(fields ? { fields } : {}) }),
  };
  before(async () => {
    w = await makeWorld({ real: true, logger });
    await waitFor(() => w.bridge.ctx.table?.rev === w.rev(), 15000);
  });
  after(async () => {
    await w.close();
  });

  test("S2 cannot be written: rejected config/apply_failed + error line; old table serves; the next pull recovers", async () => {
    const s2 = join(w.dataDir, "bridge", "config.jws");
    const running = w.bridge.ctx.table?.rev ?? 0;
    // the volume refuses the S2 write: a directory where the file goes (rename onto a non-empty directory fails)
    rmSync(s2);
    mkdirSync(join(s2, "blocker"), { recursive: true });
    writeFileSync(join(s2, "blocker", "x"), "x");
    lines.length = 0;
    const next = await w.publish((c) => {
      c.pause.workspace = true;
    });
    await waitFor(() => (w.bridge.ctx.rejected.get("config|apply_failed") ?? 0) > 0, 15000);
    assert.equal(w.bridge.ctx.table?.rev, running, "the running table keeps serving");
    assert.equal(w.bridge.ctx.table?.pausedWorkspace, false);
    const err = lines.find((l) => l.event === "bridge.config.apply_failed");
    assert.equal(err?.level, "error");
    assert.match(String(err?.fields?.code), /^E[A-Z]+$/, "an errno code, never a message");
    assert.equal(err?.fields?.rev, next);
    assert.ok(!lines.some((l) => l.event === "bridge.config.pull_failed"), "not reported as a pull (network) failure");
    const { buildStatusReport: report } = await import("../src/portal.ts");
    assert.ok(report(w.bridge.ctx).rejected.some((r) => r.kind === "config" && r.code === "apply_failed" && r.count > 0), "in the status report");
    // the volume recovers: the same revision applies on a later pull
    rmSync(s2, { recursive: true });
    await waitFor(() => w.bridge.ctx.table?.rev === next, 20000);
    assert.equal(w.bridge.ctx.table?.pausedWorkspace, true);
  });

  test("L34 quiet case: a normal apply raises no apply_failed", async () => {
    // (an accepted status report resets the counts, so the count may only stay or drop)
    const countBefore = w.bridge.ctx.rejected.get("config|apply_failed") ?? 0;
    lines.length = 0;
    const next = await w.publish();
    await waitFor(() => w.bridge.ctx.table?.rev === next, 15000);
    assert.ok((w.bridge.ctx.rejected.get("config|apply_failed") ?? 0) <= countBefore);
    assert.ok(!lines.some((l) => l.event === "bridge.config.apply_failed"));
  });
});
