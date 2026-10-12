/**
 * Persistent bridge state on ONE volume (BRIDGE §1.2): S1 identity, S2 last good config, S3 sealed key
 * store, S4 pairing connections, S5 pending claims, S6 used one-time jtis, S9 standalone overlay.
 *
 * Integrity (C62 BSD-03): every record except S2 is sealed with TB_KEK (AES-256-GCM, AAD = purpose + file),
 * so a planted or edited file is refused instead of trusted; S2 is a Portal-signed JWS and is verified on
 * boot. Files written by bridges before 0.1.12 (plaintext) are accepted ONCE and resealed; after that a
 * `format` marker makes plaintext files invalid (no downgrade).
 * Writes are crash-safe (BSD-13): unique temp name, file fsync, rename, directory fsync, temp removed on error.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ClaimRecord, PairingConnectionRecord } from "@opt2-tealbrick/spec/bridge";
import type { AgentId, BridgeId, ConnectionId, Ed25519PublicJwk, PortalKeyEntry, SealedBlob, Sha256Digest, WorkspaceId } from "@opt2-tealbrick/spec/credentials";
import type { Ed25519KeyPair, Kek, ManifestApi, PinnedKeySet } from "./api.ts";

const isPinned = (v: unknown): v is PinnedKeySet =>
  !!v && typeof v === "object" && Number.isInteger((v as PinnedKeySet).seq) && typeof (v as PinnedKeySet).kss === "string";

import { BridgeError, nowS } from "./util.ts";

export interface Identity {
  bridgeId: BridgeId;
  workspaceId: WorkspaceId;
  key: Ed25519KeyPair;
  portalKeys: PortalKeyEntry[];
  /** v0.1.11 (BSD-08): the pinned key-set statement; once set, the ONLY source of `portalKeys` */
  pinnedKeySet?: PinnedKeySet;
  enrolCodeDigest: Sha256Digest;
  configPath: string;
  ackPath: string;
}

interface IdentityFile {
  bridgeId: BridgeId;
  workspaceId: WorkspaceId;
  kid: string;
  publicKey: Ed25519PublicJwk;
  /** pre-0.1.12 files only (the whole record is sealed now) */
  sealedPrivateKey?: SealedBlob;
  privateKey?: string;
  portalKeys: PortalKeyEntry[];
  pinnedKeySet?: PinnedKeySet;
  enrolCodeDigest: Sha256Digest;
  configPath: string;
  ackPath: string;
}

export interface PendingClaim extends ClaimRecord {
  reported: boolean;
}

export interface StandaloneOverlay {
  pausedWorkspace: boolean;
  pausedAgents: AgentId[];
  revokedConnections: ConnectionId[];
  /** monotonic rev for re-minted documents */
  rev: number;
}

export interface KeyStore {
  keysRev: number;
  values: Record<string, string>;
}

/** Facts the status report must carry until Portal confirmed them (BSD-11): survive restarts. */
export interface PendingReports {
  revoked: { con: ConnectionId; reason: "refresh_reuse" | "client_revoke" }[];
  /** pairing code jti per locally created connection, until a config lists the connection */
  pairingJtis: Record<string, string>;
}

const FORMAT = 2;

function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* some platforms cannot fsync a directory; the file itself is synced */
  }
}

export function atomicWrite(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
  syncDir(join(path, ".."));
}

const isSealed = (v: unknown): v is SealedBlob => !!v && typeof v === "object" && (v as SealedBlob).alg === "A256GCM" && typeof (v as SealedBlob).ct === "string";

export class BridgeState {
  private readonly dir: string;
  private readonly api: ManifestApi;
  private readonly keks: { current: Kek; previous?: Kek };
  connections: Map<ConnectionId, PairingConnectionRecord> = new Map();
  claims: PendingClaim[] = [];
  /** S6: one-time jtis (pairing codes, keys tickets) until exp + leeway */
  usedJtis: Map<string, number> = new Map();
  keyStore: KeyStore = { keysRev: 0, values: {} };
  standalone: StandaloneOverlay | undefined;
  reports: PendingReports = { revoked: [], pairingJtis: {} };
  /** true when plaintext files of an older bridge were read (they are resealed on the next save) */
  private migrating = false;

  constructor(dataDir: string, api: ManifestApi, keks: { current: Kek; previous?: Kek }) {
    this.dir = join(dataDir, "bridge");
    this.api = api;
    this.keks = keks;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private aad(name: string): string {
    return `tb:seal:bridge-state:${name}`;
  }

  private formatMarked(): boolean {
    const p = this.path("format.sealed.json");
    if (!existsSync(p)) return false;
    const v = JSON.parse(Buffer.from(this.api.unseal(JSON.parse(readFileSync(p, "utf8")) as SealedBlob, this.keks, this.aad("format"))).toString("utf8")) as { v?: number };
    return (v.v ?? 0) >= FORMAT;
  }

  /** Reads a sealed record; plaintext only before the format marker exists (one-time migration). */
  private readRecord<T>(name: string, legacyName: string): T | undefined {
    const sealedPath = this.path(`${name}.sealed.json`);
    if (existsSync(sealedPath)) {
      const blob = JSON.parse(readFileSync(sealedPath, "utf8")) as SealedBlob;
      if (!isSealed(blob)) throw new BridgeError("state_corrupt", 500, `${name} is not a sealed record`);
      return JSON.parse(Buffer.from(this.api.unseal(blob, this.keks, this.aad(name))).toString("utf8")) as T;
    }
    const legacy = this.path(legacyName);
    if (!existsSync(legacy)) return undefined;
    if (this.formatMarked()) throw new BridgeError("state_corrupt", 500, `${legacyName}: plaintext state is not accepted any more`);
    this.migrating = true;
    return JSON.parse(readFileSync(legacy, "utf8")) as T;
  }

  private writeRecord(name: string, value: unknown, legacyName?: string): void {
    const blob = this.api.seal(Buffer.from(JSON.stringify(value), "utf8"), this.keks.current, this.aad(name));
    atomicWrite(this.path(`${name}.sealed.json`), JSON.stringify(blob));
    if (legacyName && existsSync(this.path(legacyName))) {
      unlinkSync(this.path(legacyName));
      syncDir(this.dir);
    }
  }

  private markFormat(): void {
    const blob = this.api.seal(Buffer.from(JSON.stringify({ v: FORMAT }), "utf8"), this.keks.current, this.aad("format"));
    atomicWrite(this.path("format.sealed.json"), JSON.stringify(blob));
  }

  /** Loads S3–S6, S9 and pending reports; S1 and S2 are read on demand. Reseals with the current KEK / migrates. */
  load(): void {
    for (const r of this.readRecord<PairingConnectionRecord[]>("connections", "connections.json") ?? []) this.connections.set(r.con, r);
    this.claims = this.readRecord<PendingClaim[]>("claims", "claims.json") ?? [];
    const now = nowS();
    for (const [jti, exp] of Object.entries(this.readRecord<Record<string, number>>("jtis", "jtis.json") ?? {})) if (exp > now) this.usedJtis.set(jti, exp);
    const sealed = existsSync(this.path("keys.sealed.json")) ? (JSON.parse(readFileSync(this.path("keys.sealed.json"), "utf8")) as SealedBlob) : undefined;
    if (sealed) this.keyStore = JSON.parse(Buffer.from(this.api.unseal(sealed, this.keks, "tb:seal:bridge-keys:store")).toString("utf8")) as KeyStore;
    this.standalone = this.readRecord<StandaloneOverlay>("standalone", "standalone.json");
    this.reports = this.readRecord<PendingReports>("reports", "reports.json") ?? { revoked: [], pairingJtis: {} };
    if (this.keks.previous || this.migrating) {
      this.saveConnections();
      this.saveClaims();
      this.saveJtis();
      this.saveKeyStore();
      this.saveStandalone();
      this.saveReports();
    }
  }

  async loadIdentity(): Promise<Identity | undefined> {
    const f = this.readRecord<IdentityFile>("identity", "identity.json");
    if (!f) return undefined;
    let pkcs8: Uint8Array;
    if (typeof f.privateKey === "string") pkcs8 = new Uint8Array(Buffer.from(f.privateKey, "base64url"));
    else if (f.sealedPrivateKey) pkcs8 = this.api.unseal(f.sealedPrivateKey, this.keks, `tb:seal:bridge-key:${f.kid}`);
    else throw new BridgeError("identity_corrupt", 500, "bridge identity has no key");
    const key = await this.api.importKeyPair(pkcs8);
    if (key.kid !== f.kid) throw new BridgeError("identity_corrupt", 500, "bridge key does not match its record");
    const id: Identity = { bridgeId: f.bridgeId, workspaceId: f.workspaceId, key, portalKeys: f.portalKeys, ...(isPinned(f.pinnedKeySet) ? { pinnedKeySet: f.pinnedKeySet } : {}), enrolCodeDigest: f.enrolCodeDigest, configPath: f.configPath, ackPath: f.ackPath };
    if (this.keks.previous || this.migrating) await this.saveIdentity(id);
    if (this.migrating) {
      this.markFormat();
      this.migrating = false;
    }
    return id;
  }

  async saveIdentity(id: Identity): Promise<void> {
    const pkcs8 = await this.api.exportPrivateKey(id.key);
    const f: IdentityFile = {
      bridgeId: id.bridgeId,
      workspaceId: id.workspaceId,
      kid: id.key.kid,
      publicKey: id.key.publicJwk,
      privateKey: Buffer.from(pkcs8).toString("base64url"),
      portalKeys: id.portalKeys,
      ...(id.pinnedKeySet ? { pinnedKeySet: id.pinnedKeySet } : {}),
      enrolCodeDigest: id.enrolCodeDigest,
      configPath: id.configPath,
      ackPath: id.ackPath,
    };
    // the WHOLE record is sealed (portalKeys = trust anchor, workspaceId, enrolCodeDigest included)
    this.writeRecord("identity", f, "identity.json");
    if (!this.formatMarked()) this.markFormat();
  }

  /**
   * C63a: digest of an enrolment code whose re-enrolment was refused by the key-set rule. S1 stays unchanged, so
   * without this record every restart would try the same (now used) code again.
   */
  loadRefusedEnrolCode(): Sha256Digest | undefined {
    return this.readRecord<{ digest: Sha256Digest }>("enrol-refused", "enrol-refused.json")?.digest;
  }

  saveRefusedEnrolCode(digest: Sha256Digest): void {
    this.writeRecord("enrol-refused", { digest });
  }

  loadConfigJws(): string | undefined {
    const p = this.path("config.jws");
    return existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
  }

  saveConfigJws(jws: string): void {
    atomicWrite(this.path("config.jws"), jws);
  }

  saveConnections(): void {
    this.writeRecord("connections", [...this.connections.values()], "connections.json");
  }

  saveClaims(): void {
    this.writeRecord("claims", this.claims, "claims.json");
  }

  private saveJtis(): void {
    this.writeRecord("jtis", Object.fromEntries(this.usedJtis), "jtis.json");
  }

  saveKeyStore(): void {
    const blob = this.api.seal(Buffer.from(JSON.stringify(this.keyStore), "utf8"), this.keks.current, "tb:seal:bridge-keys:store");
    atomicWrite(this.path("keys.sealed.json"), JSON.stringify(blob));
  }

  saveStandalone(): void {
    if (this.standalone) this.writeRecord("standalone", this.standalone, "standalone.json");
  }

  saveReports(): void {
    this.writeRecord("reports", this.reports, "reports.json");
  }

  /** One-time use of a jti (pairing code, keys ticket). Returns false when already used. */
  useJti(jti: string, exp: number): boolean {
    const now = nowS();
    for (const [k, e] of this.usedJtis) if (e <= now) this.usedJtis.delete(k);
    if (this.usedJtis.has(jti)) return false;
    this.usedJtis.set(jti, exp + 30);
    this.saveJtis();
    return true;
  }

  setKey(name: string, value: string | null): void {
    if (value === null) delete this.keyStore.values[name];
    else this.keyStore.values[name] = value;
    this.keyStore.keysRev += 1;
    this.saveKeyStore();
  }
}

/** Reads TB_KEK / TB_KEK_PREVIOUS through the manifest package (one encoding rule, C35). */
export function keksFromEnv(env: NodeJS.ProcessEnv, api: ManifestApi): { current: Kek; previous?: Kek } {
  if (!env.TB_KEK) throw new BridgeError("kek_missing", 500, "TB_KEK is not set");
  const current = api.kekFromEnv(env.TB_KEK);
  return env.TB_KEK_PREVIOUS ? { current, previous: api.kekFromEnv(env.TB_KEK_PREVIOUS) } : { current };
}
