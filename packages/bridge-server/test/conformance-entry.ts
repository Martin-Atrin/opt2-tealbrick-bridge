#!/usr/bin/env node
/**
 * Test harness process entry ONLY (conformance CONFORMANCE §7; the c023 real-process drain test): `tb-conformance bridge --cmd "node <this>" --test-roots`.
 * Starts the BUILT bridge (`@opt2-tealbrick/bridge` → dist) the way bridge-server does and passes the suite's test
 * roots (`TBCONF_PORTAL_ROOT_KEYS`, a harness-only env name) to the programmatic `portalRootKeys` start option, so the
 * B20 key-set checks run under the one key-set rule (manifest trustedPortalKeys, no transition path, C133). A process (`--cmd`) instead of
 * a `--start` module, so the suite captures stdout/stderr and B11.no_log runs in the same single pass.
 * The production entry (bridge-server src/server.ts) never reads that name and never passes the option. Not shipped:
 * the image and the package contain dist/ only.
 */
import { jsonLogger, loadManifestApi, onStopSignals, startBridge } from "@opt2-tealbrick/bridge";
import type { Ed25519PublicJwk } from "@opt2-tealbrick/spec/credentials";

const raw = process.env.TBCONF_PORTAL_ROOT_KEYS;
const roots = raw ? (JSON.parse(raw) as Ed25519PublicJwk[]) : undefined;
const logger = jsonLogger();
// the same signal wiring as the deployed entry (SIGTERM drains, F57a); c023 runs this entry as a real process
onStopSignals(await startBridge({ api: await loadManifestApi(), env: process.env, logger, ...(roots ? { portalRootKeys: roots } : {}) }), logger);
