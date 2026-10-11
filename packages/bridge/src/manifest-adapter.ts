/**
 * Binds `@opt2-tealbrick/manifest` (the ONE owner of primitives) to the bridge's `ManifestApi`.
 * This is the only file that knows the package's exact call shapes; a shape drift fails typecheck here.
 */
import * as m from "@opt2-tealbrick/manifest";
import type { AssertionExpect, ManifestApi } from "./api.ts";

type AnyTyp = Parameters<typeof m.signAssertion>[0];

export function manifestApi(): ManifestApi {
  return {
    canonicalize: (v) => m.canonicalize(v),
    digest: (v) => m.digest(v),
    validateManifest: (j) => m.validateManifest(j),
    manifestDigest: (mf) => m.manifestDigest(mf),
    withStandardOps: (mf) => m.withStandardOps(mf),
    generateKeyPair: () => m.generateKeyPair({ extractable: true }),
    thumbprint: (jwk) => m.thumbprint(jwk),
    keySetFrom: (jwks, issuer) => m.keySetFrom(jwks, issuer),
    signJws: (typ, claims, key) => m.signJws(typ, claims, key),
    verifyJws: (token, keys, expect) => m.verifyJws(token, keys, expect),
    verifyGrant: (token, ctx) => m.verifyGrant(token, ctx),
    verifyConfig: (token, ctx) => m.verifyConfig(token, ctx),
    renderSkill: (skill, body, vars) => m.renderSkill(skill, body, vars),
    gate: (input) => m.gate(input),
    kekFromEnv: (v) => m.kekFromEnv(v),
    sdkMajorServed: (v, current) => {
      try {
        return m.sdkMajorServed(v, current);
      } catch {
        return false;
      }
    },
    seal: (pt, kek, aad) => m.seal(pt, kek, aad),
    unseal: (blob, keks, aad) => m.unseal(blob, keks, aad),
    exportPrivateKey: (pair) => m.exportPrivateKey(pair),
    importKeyPair: (pkcs8) => m.importKeyPair(pkcs8, { extractable: true }),
    opaqueValue: (prefix) => m.opaqueValue(prefix as Parameters<typeof m.opaqueValue>[0]),
    opaqueDigest: (v) => m.opaqueDigest(v),
    digestEqual: (a, b) => m.digestEqual(a, b),
    ulid: () => m.ulid(),
    sha256Bytes: (b) => m.sha256Bytes(b),
    signAssertion: (typ, claims, key, request) => m.signAssertion(typ as AnyTyp, claims as never, key, request),
    verifyAssertion: <C extends object>(token: string, keys: Parameters<typeof m.verifyAssertion>[1], e: AssertionExpect) => {
      const r = m.verifyAssertion(token, keys, {
        typ: e.typ as AnyTyp,
        aud: e.aud,
        now: e.now,
        ...(e.request ? { method: e.request.method, pathAndQuery: e.request.pathAndQuery, ...(e.request.body ? { body: e.request.body } : {}) } : {}),
      });
      return r as { ok: true; header: { typ: AnyTyp; kid: string }; claims: C } | { ok: false; code: string; reason: string };
    },
    validateInput: (op, input) => {
      const r = m.validateInput(op, input);
      return r.ok ? r : { ok: false, errors: r.errors.map((x) => `${x.path || "/"} ${x.message}`) };
    },
    signJwsWithSigner: (typ, claims, signer) => m.signJwsWithSigner(typ, claims, signer),
  };
}

/** Kept for entry points that load lazily. */
export async function loadManifestApi(): Promise<ManifestApi> {
  return manifestApi();
}
