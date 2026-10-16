// spec 0.1.39 (C213 US-2): AppStatus members the bridge forwards to Portal besides attention (miniapp-sdk 0.1.25 upgrade safety).
import { isRecord } from "./util.ts";

const BOOT_PHASES = new Set(["restore", "open", "schema", "lock", "snapshot", "sdk_migrations", "app_migrations"]);
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SEMVER_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
const MIGRATION_FILE_RE = /^\d{4}_[a-z0-9][a-z0-9_-]{0,80}\.(sql|ts)$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * spec 0.1.39 (US-2): the upgrade-safety members of an AppStatus that may reach Portal. Only well-formed values pass
 * (an app is not trusted to shape Portal's report): `schemaVersion {app, sdk}` (non-negative integers),
 * `minCompatibleCode` (SemVer or null), `failure {phase, code, reason?, file?, at}` (closed phase list, code-shaped strings,
 * a migration file name). Anything else is dropped, never forwarded.
 */
export function upgradeFields(status: unknown): Record<string, unknown> {
  if (!isRecord(status)) return {};
  const out: Record<string, unknown> = {};
  const sv = status.schemaVersion;
  if (isRecord(sv) && count(sv.app) && count(sv.sdk)) out.schemaVersion = { app: sv.app, sdk: sv.sdk };
  const mc = status.minCompatibleCode;
  if (mc === null || (typeof mc === "string" && SEMVER_RE.test(mc))) out.minCompatibleCode = mc;
  const f = status.failure;
  if (isRecord(f) && typeof f.phase === "string" && BOOT_PHASES.has(f.phase) && typeof f.code === "string" && CODE_RE.test(f.code) && typeof f.at === "string" && ISO_RE.test(f.at)) {
    out.failure = {
      phase: f.phase,
      code: f.code,
      ...(typeof f.reason === "string" && CODE_RE.test(f.reason) ? { reason: f.reason } : {}),
      ...(typeof f.file === "string" && MIGRATION_FILE_RE.test(f.file) ? { file: f.file } : {}),
      at: f.at,
    };
  }
  return out;
}
