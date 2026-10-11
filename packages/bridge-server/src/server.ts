#!/usr/bin/env node
/**
 * Deployed bridge entry (Docker image on the workspace private network). Process wiring only:
 * env, signals, graceful shutdown. All behaviour lives in @opt2-tealbrick/bridge.
 *
 * Env (BRIDGE §4.1, §3): TB_PORTAL_URL, TB_ENROL_CODE, TB_KEK, TB_PUBLIC_URL, TB_DATA_DIR,
 * PORT (public listener), TB_INTERNAL_PORT (private listener, default 8788).
 */
import { jsonLogger, loadManifestApi, startBridge } from "@opt2-tealbrick/bridge";

export async function main(): Promise<void> {
  const logger = jsonLogger();
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
