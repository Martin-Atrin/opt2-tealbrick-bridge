#!/usr/bin/env node
/**
 * Conformance harness process entry ONLY (CONFORMANCE §7): `tb-conformance bridge --cmd "node <this>" --test-roots`.
 * Starts the BUILT bridge (`@opt2-tealbrick/bridge` → dist) the way bridge-server does and passes the suite's test
 * roots (`TBCONF_PORTAL_ROOT_KEYS`, a harness-only env name) to the programmatic `portalRootKeys` start option, so the
 * B20 key-set checks run under the build's strict rule (KEYSET_REQUIRED, spec 0.1.12). A process (`--cmd`) instead of
 * a `--start` module, so the suite captures stdout/stderr and B11.no_log runs in the same single pass.
 * The production entry (bridge-server src/server.ts) never reads that name and never passes the option. Not shipped:
 * the image and the package contain dist/ only.
 */
import { jsonLogger, loadManifestApi, startBridge } from "@opt2-tealbrick/bridge";
import type { Ed25519PublicJwk } from "@opt2-tealbrick/spec/credentials";

const raw = process.env.TBCONF_PORTAL_ROOT_KEYS;
const roots = raw ? (JSON.parse(raw) as Ed25519PublicJwk[]) : undefined;
const logger = jsonLogger();
const running = await startBridge({ api: await loadManifestApi(), env: process.env, logger, ...(roots ? { portalRootKeys: roots } : {}) });
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
