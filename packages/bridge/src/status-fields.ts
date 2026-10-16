// spec 0.1.39 (C213 US-2, C219): AppStatus members the bridge forwards to Portal besides attention (miniapp-sdk 0.1.25 upgrade safety).
// L1: spec 0.1.39 exports only TYPES for these members (no runtime phase list, no validators, no JSON Schema), so the
// shape checks stay local but are typed against the spec: BOOT_PHASES must name every BootFailure["phase"] exactly once
// (tsc fails on a missing or an extra phase) and the output type is the StatusReport app entry's own members.
import type { BootFailure, PreUpdateSnapshotRef, StatusReport } from "@opt2-tealbrick/spec/bridge";
import { isRecord } from "./util.ts";

export type BootPhase = BootFailure["phase"];
// C219: spec 0.1.39 types preUpdateSnapshot on AppStatus (and Health) but NOT on StatusReport.apps[]; the member is typed here against
// the spec's own PreUpdateSnapshotRef until a later spec adds it to the report entry. Core reads report members tolerantly.
export type UpgradeFields = Pick<StatusReport["apps"][number], "schemaVersion" | "minCompatibleCode" | "failure"> & { preUpdateSnapshot?: PreUpdateSnapshotRef | null };

/** Compile-time exhaustive against the spec union: `satisfies` refuses a missing key and an excess key. */
const PHASES = {
  restore: true,
  open: true,
  schema: true,
  lock: true,
  snapshot: true,
  sdk_migrations: true,
  app_migrations: true,
} as const satisfies Record<BootPhase, true>;
export const BOOT_PHASES: ReadonlySet<string> = new Set<BootPhase>(Object.keys(PHASES) as BootPhase[]);
const isPhase = (v: unknown): v is BootPhase => typeof v === "string" && BOOT_PHASES.has(v);

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SEMVER_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
const MIGRATION_FILE_RE = /^\d{4}_[a-z0-9][a-z0-9_-]{0,80}\.(sql|ts)$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// C219: miniapp-sdk 0.1.25 writes `TB_BACKUP_DIR/tb-preupdate-to-<version>.tar.gz` and a lower-case hex sha256 (no "sha256:" prefix).
const SNAPSHOT_FILE_RE = /^[A-Za-z0-9._-]{1,200}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * spec 0.1.39 (US-2): the upgrade-safety members of an AppStatus that may reach Portal. Only well-formed values pass
 * (an app is not trusted to shape Portal's report): `schemaVersion {app, sdk}` (non-negative integers),
 * `minCompatibleCode` (SemVer or null), `failure {phase, code, reason?, file?, at}` (closed phase list, code-shaped strings,
 * a migration file name), and (C219) `preUpdateSnapshot` (null, or {file, sha256, createdAt, from, to} with every member well-formed;
 * one bad member drops the whole snapshot, members beyond the five are never copied). Anything else is dropped, never forwarded.
 */
export function upgradeFields(status: unknown): UpgradeFields {
  if (!isRecord(status)) return {};
  const out: UpgradeFields = {};
  const sv = status.schemaVersion;
  if (isRecord(sv) && count(sv.app) && count(sv.sdk)) out.schemaVersion = { app: sv.app, sdk: sv.sdk };
  const mc = status.minCompatibleCode;
  if (mc === null || (typeof mc === "string" && SEMVER_RE.test(mc))) out.minCompatibleCode = mc;
  const f = status.failure;
  if (isRecord(f) && isPhase(f.phase) && typeof f.code === "string" && CODE_RE.test(f.code) && typeof f.at === "string" && ISO_RE.test(f.at)) {
    out.failure = {
      phase: f.phase,
      code: f.code,
      ...(typeof f.reason === "string" && CODE_RE.test(f.reason) ? { reason: f.reason } : {}),
      ...(typeof f.file === "string" && MIGRATION_FILE_RE.test(f.file) ? { file: f.file } : {}),
      at: f.at,
    };
  }
  const snap = status.preUpdateSnapshot;
  if (snap === null) out.preUpdateSnapshot = null;
  else {
    const ref = snapshotRef(snap);
    if (ref) out.preUpdateSnapshot = ref;
  }
  return out;
}

/** The spec's `PreUpdateSnapshotRef`, or undefined when any of its five members is missing or malformed. */
function snapshotRef(v: unknown): PreUpdateSnapshotRef | undefined {
  if (!isRecord(v)) return undefined;
  const { file, sha256, createdAt, from, to } = v;
  if (typeof file !== "string" || !SNAPSHOT_FILE_RE.test(file) || file.includes("..")) return undefined;
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return undefined;
  if (typeof createdAt !== "string" || !ISO_RE.test(createdAt)) return undefined;
  if (from !== null && !(typeof from === "string" && SEMVER_RE.test(from))) return undefined;
  if (typeof to !== "string" || !SEMVER_RE.test(to)) return undefined;
  return { file, sha256, createdAt, from, to };
}
