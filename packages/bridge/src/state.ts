/**
 * Persistent bridge state on ONE volume (BRIDGE §1.2): S1 identity, S2 last good config, S3 sealed key
 * store, S4 pairing connections, S5 pending claims, S6 used one-time jtis, S9 standalone overlay.
 * Writes are atomic (temp file + fsync + rename). S1 and S3 are sealed with TB_KEK (CREDENTIALS §9.1).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ClaimRecord, PairingConnectionRecord } from "@opt2-tealbrick/spec/bridge";
import type { AgentId, BridgeId, ConnectionId, Ed25519PublicJwk, PortalKeyEntry, SealedBlob, Sha256Digest, WorkspaceId } from "@opt2-tealbrick/spec/credentials";
import type { Ed25519KeyPair, Kek, ManifestApi } from "./api.ts";
import { BridgeError, nowS } from "./util.ts";

export interface Identity {
  bridgeId: BridgeId;
  workspaceId: WorkspaceId;
  key: Ed25519KeyPair;
  portalKeys: PortalKeyEntry[];
  enrolCodeDigest: Sha256Digest;
  configPath: string;
  ackPath: string;
}

interface IdentityFile {
  bridgeId: BridgeId;
  workspaceId: WorkspaceId;
  kid: string;
  publicKey: Ed25519PublicJwk;
  sealedPrivateKey: SealedBlob;
  portalKeys: PortalKeyEntry[];
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

function atomicWrite(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

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

  constructor(dataDir: string, api: ManifestApi, keks: { current: Kek; previous?: Kek }) {
    this.dir = join(dataDir, "bridge");
    this.api = api;
    this.keks = keks;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  /** Loads S3–S6 and S9; S1 and S2 are read on demand. Reseals with the current KEK when a previous one was used. */
  load(): void {
    for (const r of readJson<PairingConnectionRecord[]>(this.path("connections.json")) ?? []) this.connections.set(r.con, r);
    this.claims = readJson<PendingClaim[]>(this.path("claims.json")) ?? [];
    const now = nowS();
    for (const [jti, exp] of Object.entries(readJson<Record<string, number>>(this.path("jtis.json")) ?? {})) if (exp > now) this.usedJtis.set(jti, exp);
    const sealed = readJson<SealedBlob>(this.path("keys.sealed.json"));
    if (sealed) {
      this.keyStore = JSON.parse(Buffer.from(this.api.unseal(sealed, this.keks, "tb:seal:bridge-keys:store")).toString("utf8")) as KeyStore;
      if (this.keks.previous) this.saveKeyStore();
    }
    this.standalone = readJson<StandaloneOverlay>(this.path("standalone.json"));
  }

  async loadIdentity(): Promise<Identity | undefined> {
    const f = readJson<IdentityFile>(this.path("identity.json"));
    if (!f) return undefined;
    const pkcs8 = this.api.unseal(f.sealedPrivateKey, this.keks, `tb:seal:bridge-key:${f.kid}`);
    const key = await this.api.importKeyPair(pkcs8);
    if (key.kid !== f.kid) throw new BridgeError("identity_corrupt", 500, "bridge key does not match its record");
    const id: Identity = {
      bridgeId: f.bridgeId,
      workspaceId: f.workspaceId,
      key,
      portalKeys: f.portalKeys,
      enrolCodeDigest: f.enrolCodeDigest,
      configPath: f.configPath,
      ackPath: f.ackPath,
    };
    if (this.keks.previous) await this.saveIdentity(id);
    return id;
  }

  async saveIdentity(id: Identity): Promise<void> {
    const pkcs8 = await this.api.exportPrivateKey(id.key);
    const f: IdentityFile = {
      bridgeId: id.bridgeId,
      workspaceId: id.workspaceId,
      kid: id.key.kid,
      publicKey: id.key.publicJwk,
      sealedPrivateKey: this.api.seal(pkcs8, this.keks.current, `tb:seal:bridge-key:${id.key.kid}`),
      portalKeys: id.portalKeys,
      enrolCodeDigest: id.enrolCodeDigest,
      configPath: id.configPath,
      ackPath: id.ackPath,
    };
    atomicWrite(this.path("identity.json"), JSON.stringify(f));
  }

  loadConfigJws(): string | undefined {
    const p = this.path("config.jws");
    return existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
  }

  saveConfigJws(jws: string): void {
    atomicWrite(this.path("config.jws"), jws);
  }

  saveConnections(): void {
    atomicWrite(this.path("connections.json"), JSON.stringify([...this.connections.values()]));
  }

  saveClaims(): void {
    atomicWrite(this.path("claims.json"), JSON.stringify(this.claims));
  }

  saveKeyStore(): void {
    const blob = this.api.seal(Buffer.from(JSON.stringify(this.keyStore), "utf8"), this.keks.current, "tb:seal:bridge-keys:store");
    atomicWrite(this.path("keys.sealed.json"), JSON.stringify(blob));
  }

  saveStandalone(): void {
    if (this.standalone) atomicWrite(this.path("standalone.json"), JSON.stringify(this.standalone));
  }

  /** One-time use of a jti (pairing code, keys ticket). Returns false when already used. */
  useJti(jti: string, exp: number): boolean {
    const now = nowS();
    for (const [k, e] of this.usedJtis) if (e <= now) this.usedJtis.delete(k);
    if (this.usedJtis.has(jti)) return false;
    this.usedJtis.set(jti, exp + 30);
    atomicWrite(this.path("jtis.json"), JSON.stringify(Object.fromEntries(this.usedJtis)));
    return true;
  }

  setKey(name: string, value: string | null): void {
    if (value === null) delete this.keyStore.values[name];
    else this.keyStore.values[name] = value;
    this.keyStore.keysRev += 1;
    this.saveKeyStore();
  }
}

/** Reads TB_KEK / TB_KEK_PREVIOUS (32 bytes, base64url or hex). The KEK id is derived from its digest, never the key. */
export function keksFromEnv(env: NodeJS.ProcessEnv, api: ManifestApi): { current: Kek; previous?: Kek } {
  const parse = (v: string | undefined): Kek | undefined => {
    if (!v) return undefined;
    const raw = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64url");
    if (raw.length !== 32) throw new BridgeError("kek_invalid", 500, "TB_KEK must be 32 bytes");
    return { id: api.sha256Bytes(raw).slice(7, 23), key: new Uint8Array(raw) };
  };
  const current = parse(env.TB_KEK);
  if (!current) throw new BridgeError("kek_missing", 500, "TB_KEK is not set");
  const previous = parse(env.TB_KEK_PREVIOUS);
  return previous ? { current, previous } : { current };
}
