/**
 * The primitives the bridge uses, all owned by `@opt2-tealbrick/manifest` (SDK-API §1 rule 2, C21).
 * The bridge never implements JCS, digests, JWS, key sets, sealing or token checks itself: the entry
 * point (bridge-server, CLI) passes the manifest package in as `ManifestApi`. Tests pass a test double.
 *
 * Names follow types/sdk.ts §A plus the C21 additions (seal/unseal, key export/import, opaque values,
 * ulid, raw-bytes digest, generic assertion verify, input validation).
 */
import type { BridgeRef, Ed25519PublicJwk, InstanceRef, PortalRef, SealedBlob, Sha256Digest, Typ, Ulid } from "@opt2-tealbrick/spec/credentials";
import type { CrudAction, Manifest, ManifestValidation, Skill } from "@opt2-tealbrick/spec/manifest";
import type {
  Ed25519KeyPair,
  GateDecision,
  GateInput,
  Json,
  JwsExpect,
  KeySet,
  OperationView,
  PinnedKeySet,
  Refusal,
  SkillVars,
  TrustContext,
  VerifiedGrant,
  VerifiedKeySet,
} from "@opt2-tealbrick/spec/sdk";

export type { Ed25519KeyPair, GateInput, Json, KeySet, OperationView, PinnedKeySet, Refusal, TrustContext, VerifiedGrant, VerifiedKeySet };

/** BSD-08 trust decision for one body (CREDENTIALS §9.5): a verified statement, the 0.1.11 legacy path, or a refusal. */
export type KeySetDecision = (VerifiedKeySet & { legacy: false; changed: boolean }) | { ok: true; legacy: true; reason: string } | Refusal;

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
  /** manifest 0.1.14 (L1): THE tools/list rule = the static part of gate() steps (3)–(4) */
  opVisibleToGrant(op: GateInput["op"], claims: { mode: string; wf: readonly string[]; crud: readonly CrudAction[] }, declaredScopeTypes: readonly string[]): boolean;
  /** manifest 0.1.14 (C111a, L1): THE workflow rule (gate() step 4) */
  opInGrantWorkflow(claims: { mode: string; wf: readonly string[] }, opId: string): boolean;
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
  // v0.1.11 (BSD-08, BSD-07)
  /** build-pinned Portal Root Keys of a channel (a build constant, never env) */
  portalRootKeys(channel: "dev" | "prod"): Ed25519PublicJwk[];
  /** the ONE key-set trust rule for an enrolment response / config body */
  trustedPortalKeys(body: { portalKeySet?: unknown }, pinned: PinnedKeySet | null, roots: readonly Ed25519PublicJwk[], opts?: { required?: boolean }): KeySetDecision;
  /** BRIDGE §5.7 app address rule */
  isPrivateInternalUrl(url: string, opts?: { ownInfra?: boolean; allowList?: readonly string[] }): boolean;
  // spec 0.1.14 / manifest 0.1.9 shared rules (LEARNINGS L1: one implementation, never a bridge copy)
  /** C91: the claims of a bridge-op proof for `body` (exactly what the SDK binds) */
  bridgeOpProofClaims(bop: "catalog" | "resolve" | "mark" | "scope_summary", body: Json): { bop: "catalog" | "resolve" | "mark" | "scope_summary"; op?: string; in?: Sha256Digest };
  /** C98: the idempotency key derived for a tools/call without a client key */
  deriveIdempotencyKey(i: { connection: string; session: string; op: string; input: unknown; now: number }): string;
  // v0.1.13 spine (manifest 0.1.9): hook answers, before-chain precedence, hold verdict, onBehalfOf, launch path
  /** shape problem of a hook answer for `phase` (incl. the reserved `tb.` namespace), or null */
  hookResponseProblem(phase: "before" | "context" | "after", body: unknown, product: string): string | null;
  /** first refuse wins; else the first hold is kept; else allow */
  reduceBeforeChain(answers: readonly { by: string; answer: { allow: boolean; reason?: string; hold?: HoldVerdict } }[]): BeforeChainResult;
  /** `hv` call-proof claim of a kept hold */
  holdVerdictClaim(r: Extract<BeforeChainResult, { kind: "hold" }>): { f: string; r: string; by: string };
  /** `_meta["tealbrick/onBehalfOf"]` → `tb.onBehalfOf` context (unverified), or null when invalid */
  onBehalfOfFromMeta(value: unknown): Json | null;
  /** C86 launch path rule */
  isValidLaunchPath(path: string): boolean;
  /** C104 (spec 0.1.17): minimum bridge version a manifest needs (declared requires.bridge + BRIDGE_FEATURES) */
  requiredBridgeVersion(m: Manifest): { bridge: string | null; reasons: string[] };
  compareSemver(a: string, b: string): number;
}

export interface HoldVerdict {
  family: string;
  reason: string;
}
export type BeforeChainResult = { kind: "allow" } | { kind: "refuse"; by: string; reason: string | null } | { kind: "hold"; by: string; verdict: HoldVerdict };

export const isRefusal = (v: unknown): v is Refusal => !!v && typeof v === "object" && (v as { ok?: unknown }).ok === false;
