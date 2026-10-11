/**
 * Binds the real `@opt2-tealbrick/manifest` package to the bridge's `ManifestApi` (the only place that
 * knows its exact call shapes). Loaded with a dynamic import so the bridge repo builds before the
 * manifest release exists; entry points (bridge-server, CLI) call `loadManifestApi()` at start.
 */
import type { AssertionExpect, Ed25519KeyPair, Json, ManifestApi } from "./api.ts";

/** Package specifier kept in a variable so the type checker does not require the package at build time. */
const MANIFEST_PACKAGE = "@opt2-tealbrick/manifest";

type AnyFn = (...args: never[]) => unknown;
type ManifestModule = Record<string, AnyFn>;

export async function loadManifestApi(): Promise<ManifestApi> {
  const m = (await import(MANIFEST_PACKAGE)) as ManifestModule;
  const need = (name: string): AnyFn => {
    const f = m[name];
    if (typeof f !== "function") throw new Error(`@opt2-tealbrick/manifest lacks export ${name}`);
    return f;
  };
  const call = <R>(name: string, ...args: unknown[]): R => (need(name) as unknown as (...a: unknown[]) => R)(...args);
  const api: ManifestApi = {
    canonicalize: (v) => call("canonicalize", v),
    digest: (v) => call("digest", v),
    validateManifest: (j) => call("validateManifest", j),
    manifestDigest: (mf) => call("manifestDigest", mf),
    withStandardOps: (mf) => call("withStandardOps", mf),
    generateKeyPair: () => call<Promise<Ed25519KeyPair>>("generateKeyPair", { extractable: true }),
    thumbprint: (jwk) => call("thumbprint", jwk),
    keySetFrom: (jwks, issuer) => call("keySetFrom", jwks, issuer),
    signJws: (typ, claims, key) => call("signJws", typ, claims, key),
    verifyJws: (token, keys, expect) => call("verifyJws", token, keys, expect),
    verifyGrant: (token, ctx) => call("verifyGrant", token, ctx),
    verifyConfig: (token, ctx) => call("verifyConfig", token, ctx),
    renderSkill: (skill, body, vars) => call("renderSkill", skill, body, vars),
    gate: (input) => call("gate", input),
    seal: (pt, kek, aad) => call("seal", pt, kek, aad),
    unseal: (blob, keks, aad) => call("unseal", blob, keks, aad),
    exportPrivateKey: (pair) => call("exportPrivateKey", pair),
    importKeyPair: (pkcs8) => call("importKeyPair", pkcs8, { extractable: true }),
    opaqueValue: (prefix) => call("opaqueValue", prefix),
    opaqueDigest: (v) => call("opaqueDigest", v),
    digestEqual: (a, b) => call("digestEqual", a, b),
    ulid: () => call("ulid"),
    sha256Bytes: (b) => call("sha256Bytes", b),
    signAssertion: (typ, claims, key, request) => call("signAssertion", typ, claims, key, request),
    verifyAssertion: (token, keys, e: AssertionExpect) =>
      call("verifyAssertion", token, keys, {
        typ: e.typ,
        aud: e.aud,
        now: e.now,
        ...(e.request ? { method: e.request.method, pathAndQuery: e.request.pathAndQuery, ...(e.request.body ? { body: e.request.body } : {}) } : {}),
      }),
    validateInput: (op, input: Json) => {
      const r = call<{ ok: true } | { ok: false; errors: { path: string; message: string }[] }>("validateInput", op, input);
      return r.ok ? r : { ok: false, errors: r.errors.map((x) => `${x.path || "/"} ${x.message}`) };
    },
    signJwsWithSigner: (typ, claims, signer) => call("signJwsWithSigner", typ, claims, signer),
  };
  return api;
}
