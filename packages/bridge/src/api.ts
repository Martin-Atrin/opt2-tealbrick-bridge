/**
 * The primitives the bridge uses, all owned by `@opt2-tealbrick/manifest` (SDK-API §1 rule 2, C21).
 * The bridge never implements JCS, digests, JWS, key sets, sealing or token checks itself: the entry
 * point (bridge-server, CLI) passes the manifest package in as `ManifestApi`. Tests pass a test double.
 *
 * Names follow types/sdk.ts §A plus the C21 additions (seal/unseal, key export/import, opaque values,
 * ulid, raw-bytes digest, generic assertion verify, input validation).
 */
import type { BridgeRef, Ed25519PublicJwk, InstanceRef, PortalRef, SealedBlob, Sha256Digest, Typ, Ulid } from "@opt2-tealbrick/spec/credentials";
import type { Manifest, ManifestValidation, Skill } from "@opt2-tealbrick/spec/manifest";
import type {
  Ed25519KeyPair,
  GateDecision,
  GateInput,
  Json,
  JwsExpect,
  KeySet,
  OperationView,
  Refusal,
  SkillVars,
  TrustContext,
  VerifiedGrant,
} from "@opt2-tealbrick/spec/sdk";

export type { Ed25519KeyPair, GateInput, Json, KeySet, OperationView, Refusal, TrustContext, VerifiedGrant };

export interface Kek {
  id: string;
  key: Uint8Array;
}

export interface AssertionExpect {
  typ: Typ;
  aud: string;
  /** allowed `iss` values (= `sub`) */
  iss: readonly string[];
  now: number;
  maxLifetimeS: number;
  /** request binding for assertions with htm/htu/bd */
  request?: { method: string; pathAndQuery: string; body?: Uint8Array };
}

export interface ManifestApi {
  canonicalize(value: Json): string;
  digest(value: Json): Sha256Digest;
  validateManifest(json: unknown): ManifestValidation;
  manifestDigest(manifest: Manifest): Sha256Digest;
  withStandardOps(manifest: Manifest): OperationView[];
  generateKeyPair(): Promise<Ed25519KeyPair>;
  thumbprint(jwk: Ed25519PublicJwk): string;
  keySetFrom(jwks: { keys: Ed25519PublicJwk[] }, issuer: PortalRef | BridgeRef | InstanceRef): KeySet;
  signJws<C extends object>(typ: Typ, claims: C, key: Ed25519KeyPair): Promise<string>;
  verifyJws<C extends object>(token: string, keys: KeySet, expect: JwsExpect): { ok: true; header: { typ: Typ; kid: string }; claims: C } | Refusal;
  verifyGrant(token: string, ctx: TrustContext): VerifiedGrant | Refusal;
  verifyConfig(token: string, ctx: { now: number; self: BridgeRef; issuers: KeySet }): { ok: true; claims: unknown; body: unknown } | Refusal;
  renderSkill(skill: Skill, body: string, vars: SkillVars): string;
  gate(input: GateInput): GateDecision;
  // C21 additions
  /** TB_KEK / TB_KEK_PREVIOUS env value → KEK (manifest owns the encoding rules, C35). */
  kekFromEnv(value: string): Kek;
  /** C44: SDK 0.x counts as major 1; current major and the one before are served. */
  sdkMajorServed(version: string, currentMajor: number): boolean;
  seal(plaintext: Uint8Array, kek: Kek, aad: string): SealedBlob;
  unseal(blob: SealedBlob, keks: { current: Kek; previous?: Kek }, aad: string): Uint8Array;
  exportPrivateKey(pair: Ed25519KeyPair): Promise<Uint8Array>;
  importKeyPair(pkcs8: Uint8Array): Promise<Ed25519KeyPair>;
  opaqueValue(prefix: string): string;
  opaqueDigest(value: string): Sha256Digest;
  digestEqual(a: string, b: string): boolean;
  ulid(): Ulid;
  sha256Bytes(body: Uint8Array): Sha256Digest;
  /** Signs an assertion with request binding (htm/htu/bd) for header `TB-Assert`. */
  signAssertion<C extends object>(typ: Typ, claims: C, key: Ed25519KeyPair, request?: { method: string; pathAndQuery: string; body?: Uint8Array }): Promise<string>;
  verifyAssertion<C extends object>(token: string, keys: KeySet, expect: AssertionExpect): { ok: true; header: { typ: Typ; kid: string }; claims: C } | Refusal;
  validateInput(op: OperationView, input: Json): { ok: true } | { ok: false; errors: string[] };
  /** JWS with an external signer (key held by the OS keychain / Secure Enclave; C24 relay). */
  signJwsWithSigner(typ: Typ, claims: object, signer: { kid: string; sign(input: string): Promise<string> | string }): Promise<string>;
}

export const isRefusal = (v: unknown): v is Refusal => !!v && typeof v === "object" && (v as { ok?: unknown }).ok === false;
