#!/usr/bin/env node
/**
 * Deployed bridge entry (Docker image on the workspace private network). Process wiring only:
 * env, signals, graceful shutdown. All behaviour lives in @opt2-tealbrick/bridge.
 *
 * Env (BRIDGE §4.1, §3): TB_PORTAL_URL, TB_ENROL_CODE, TB_KEK, TB_PUBLIC_URL, TB_DATA_DIR,
 * PORT (public listener), TB_INTERNAL_PORT (private listener, default 8788).
 */
import { lchownSync } from "node:fs";
import { dropPrivileges, jsonLogger, loadManifestApi, RUN_UID, startBridge } from "@opt2-tealbrick/bridge";

/** Process calls the drop needs (tests pass fakes). */
export interface PrivilegeProcess {
  getuid?: () => number;
  getgid?: () => number;
  setuid?: (id: number) => void;
  setgid?: (id: number) => void;
  setgroups?: (groups: number[]) => void;
  chown?: (path: string, uid: number, gid: number) => void;
}

/**
 * BSD-04: Railway runs volume services as root (RAILWAY_RUN_UID=0). Before any state load or listen: chown the
 * data dir to 1000:1000 and drop to uid/gid 1000 via the SDK helper; never keep running as root.
 */
export function dropRoot(env: NodeJS.ProcessEnv, proc: PrivilegeProcess = { getuid: process.getuid, getgid: process.getgid, setuid: process.setuid, setgid: process.setgid, setgroups: process.setgroups, chown: lchownSync }): boolean {
  const dataDir = env.TB_DATA_DIR;
  if (!dataDir) throw new Error("TB_DATA_DIR is required");
  const dropped = dropPrivileges({ dataDir, backupDir: dataDir }, proc);
  const uid = proc.getuid?.();
  if (uid === 0) throw new Error("refusing to run as root");
  if (dropped && uid !== RUN_UID) throw new Error("privilege drop did not reach uid 1000");
  return dropped;
}

export async function main(): Promise<void> {
  const logger = jsonLogger();
  if (dropRoot(process.env)) logger.info("bridge.privileges_dropped", { uid: process.getuid?.() ?? null });
  const api = await loadManifestApi();
  const running = await startBridge({ api, logger });
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("bridge.stopping", { signal });
    await running.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/server.js")) {
  main().catch((e: unknown) => {
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "bridge.boot_failed", code: e instanceof Error ? e.message.slice(0, 200) : "error" })}\n`);
    process.exit(1);
  });
}
