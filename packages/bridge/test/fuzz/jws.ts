/** C62 fuzz (registered by http.test.ts): mutated agent assertions at /oauth/token (jwt-bearer) are always refused with a 4xx JSON body. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AGT, CON, type World } from "../support/world.ts";
import { check, fc, rawRequest, tryJson } from "./support.ts";

const GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const dec = (s: string) => Buffer.from(s, "base64url").toString("utf8");

/** Replacement values for a claim or header field; each is semantically invalid for every field it is used on. */
const BAD_VALUES = ["null", "[]", "{}", '""', "0", "-1", "true", "1e999", "-1e999", "1e308", "9007199254740993", "123456789012345678901234567890", '"x"', '"tb:agt:agt_01HZZZZZZZZZZZZZZZZZZZZZZZ"', '"tb:brg:brg_other"', `"${"A".repeat(9000)}"`, '"\\u0000"', '{"__proto__":{"a":1}}', '["con"]'];
const HEADER_FIELDS = ["alg", "typ", "kid"];
const CLAIM_FIELDS = ["iss", "sub", "aud", "iat", "exp", "jti", "con"];
const badValue = fc.constantFrom(...BAD_VALUES);

type Spec =
  | { k: "sig"; op: "flip" | "truncate" | "extend" | "empty" | "zeros" | "random" | "insert"; pos: number; ch: string }
  | { k: "raw-header" | "raw-payload"; op: "badvalue" | "delete" | "dupkey" | "protokey" | "bignum" | "notjson" | "array" | "append" | "truncate"; field: number; value: string }
  | { k: "segments"; op: "drop" | "extra" | "extra-empty" | "dots" | "empty" | "space" | "bearer" | "newline" | "swap" | "double"; junk: string }
  | { k: "chars"; seg: 0 | 1; pos: number; ch: string }
  | { k: "signed-header"; op: "badvalue" | "delete" | "dupkey" | "notobject"; field: number; value: string }
  | { k: "signed-payload"; op: "badvalue" | "delete" | "dupkey" | "protonest" | "notobject" | "expiry" | "future" | "bignum"; field: number; value: string }
  | { k: "body"; shape: "json-number" | "json-array" | "json-object" | "json-null" | "json-huge" | "json-nested" | "empty" | "missing" | "big-form" | "no-grant"; junk: string };

const junkChar = fc.constantFrom("+", "/", "=", " ", "\n", "\t", "%2e", "%", "é", "‮", "\0", ".", "~", "*", "\\", "😀", "A", "-", "_");
const spec: fc.Arbitrary<Spec> = fc.oneof(
  fc.record({ k: fc.constant("sig" as const), op: fc.constantFrom("flip", "truncate", "extend", "empty", "zeros", "random", "insert"), pos: fc.nat(200), ch: junkChar }),
  fc.record({
    k: fc.constantFrom("raw-header" as const, "raw-payload" as const),
    op: fc.constantFrom("badvalue", "delete", "dupkey", "protokey", "bignum", "notjson", "array", "append", "truncate"),
    field: fc.nat(10),
    value: badValue,
  }),
  fc.record({ k: fc.constant("segments" as const), op: fc.constantFrom("drop", "extra", "extra-empty", "dots", "empty", "space", "bearer", "newline", "swap", "double"), junk: fc.string({ maxLength: 20 }) }),
  fc.record({ k: fc.constant("chars" as const), seg: fc.constantFrom(0, 1), pos: fc.nat(300), ch: junkChar }),
  fc.record({ k: fc.constant("signed-header" as const), op: fc.constantFrom("badvalue", "delete", "dupkey", "notobject"), field: fc.nat(10), value: badValue }),
  fc.record({ k: fc.constant("signed-payload" as const), op: fc.constantFrom("badvalue", "delete", "dupkey", "protonest", "notobject", "expiry", "future", "bignum"), field: fc.nat(10), value: badValue }),
  fc.record({ k: fc.constant("body" as const), shape: fc.constantFrom("json-number", "json-array", "json-object", "json-null", "json-huge", "json-nested", "empty", "missing", "big-form", "no-grant"), junk: fc.string({ maxLength: 10 }) }),
);

/** Replaces `field` in a one-level JSON object text, keeping the key order and every other member as written. */
function setField(obj: Record<string, unknown>, field: string, rawValue: string): string {
  const parts = Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}:${k === field ? rawValue : JSON.stringify(v)}`);
  if (!(field in obj)) parts.push(`${JSON.stringify(field)}:${rawValue}`);
  return `{${parts.join(",")}}`;
}
const without = (obj: Record<string, unknown>, field: string) => JSON.stringify(Object.fromEntries(Object.entries(obj).filter(([k]) => k !== field)));
/** The valid pair first and an invalid duplicate LAST: any parser that keeps the last (JSON.parse) sees the invalid value. */
const dupLast = (obj: Record<string, unknown>, field: string, rawValue: string) => `${JSON.stringify(obj).slice(0, -1)},${JSON.stringify(field)}:${rawValue}}`;

interface Case {
  /** the form `assertion` value, or a prebuilt request body */
  assertion: string;
  body?: { contentType: string; text: string };
  mustReject: boolean;
}

async function build(w: World, s: Spec): Promise<Case> {
  const base = await w.agentAssertion(AGT, CON);
  const [h = "", p = "", sig = ""] = base.split(".");
  const header = JSON.parse(dec(h)) as Record<string, unknown>;
  const payload = JSON.parse(dec(p)) as Record<string, unknown>;
  const sigBytes = Buffer.from(sig, "base64url");
  const signed = async (headerText: string, payloadText: string, mustReject: boolean): Promise<Case> => {
    const input = `${b64(headerText)}.${b64(payloadText)}`;
    return { assertion: `${input}.${await w.signRaw(input)}`, mustReject };
  };
  const pick = (list: string[], n: number) => list[n % list.length] as string;
  switch (s.k) {
    case "sig": {
      let next: string;
      switch (s.op) {
        case "flip": {
          const b = Buffer.from(sigBytes);
          b[s.pos % b.length] = (b[s.pos % b.length] as number) ^ (1 << (s.pos % 8));
          next = b64(b);
          break;
        }
        case "truncate":
          next = sig.slice(0, s.pos % sig.length);
          break;
        case "extend":
          next = sig + s.ch.repeat(1 + (s.pos % 5));
          break;
        case "empty":
          next = "";
          break;
        case "zeros":
          next = b64(Buffer.alloc(64));
          break;
        case "random":
          next = b64(Buffer.from(Array.from({ length: 64 }, (_, i) => (s.pos * 31 + i * 17) & 255)));
          break;
        case "insert":
          next = sig.slice(0, s.pos % sig.length) + s.ch + sig.slice(s.pos % sig.length);
          break;
      }
      const assertion = `${h}.${p}.${next}`;
      // lax base64url decoding (Node ignores stray characters and unused trailing bits) can map a different string to the same signature bytes
      const sameBytes = Buffer.compare(Buffer.from(next, "base64url"), sigBytes) === 0;
      return { assertion, mustReject: !sameBytes };
    }
    case "raw-header":
    case "raw-payload": {
      const obj = s.k === "raw-header" ? header : payload;
      const fields = s.k === "raw-header" ? HEADER_FIELDS : CLAIM_FIELDS;
      const f = pick(fields, s.field);
      let text: string;
      switch (s.op) {
        case "badvalue":
          text = setField(obj, f, s.value);
          break;
        case "delete":
          text = without(obj, f);
          break;
        case "dupkey":
          text = dupLast(obj, f, s.value);
          break;
        case "protokey":
          text = setField(obj, "__proto__", '{"alg":"none","con":"con_x","exp":1e999}');
          break;
        case "bignum":
          text = setField(obj, f, `${"9".repeat(400)}e${"9".repeat(40)}`);
          break;
        case "notjson":
          text = s.value;
          break;
        case "array":
          text = JSON.stringify([obj]);
          break;
        case "append":
          text = `${JSON.stringify(obj)} ${s.value}`;
          break;
        case "truncate":
          text = JSON.stringify(obj).slice(0, 5 + s.field * 7);
          break;
      }
      const changed = b64(text) !== (s.k === "raw-header" ? h : p);
      const assertion = s.k === "raw-header" ? `${b64(text)}.${p}.${sig}` : `${h}.${b64(text)}.${sig}`;
      return { assertion, mustReject: changed };
    }
    case "segments": {
      let assertion: string;
      switch (s.op) {
        case "drop":
          assertion = `${h}.${p}`;
          break;
        case "extra":
          assertion = `${base}.${b64(s.junk)}`;
          break;
        case "extra-empty":
          assertion = `${base}.`;
          break;
        case "dots":
          assertion = "..";
          break;
        case "empty":
          assertion = "";
          break;
        case "space":
          assertion = ` ${base} `;
          break;
        case "bearer":
          assertion = `Bearer ${base}`;
          break;
        case "newline":
          assertion = `${h}\n.${p}.${sig}`;
          break;
        case "swap":
          assertion = `${p}.${h}.${sig}`;
          break;
        case "double":
          assertion = `${base}.${base}`;
          break;
      }
      return { assertion, mustReject: true };
    }
    case "chars": {
      const seg = s.seg === 0 ? h : p;
      const at = s.pos % (seg.length + 1);
      const mutated = seg.slice(0, at) + s.ch + seg.slice(at);
      return { assertion: s.seg === 0 ? `${mutated}.${p}.${sig}` : `${h}.${mutated}.${sig}`, mustReject: true };
    }
    case "signed-header": {
      const f = pick(HEADER_FIELDS, s.field);
      switch (s.op) {
        case "badvalue":
          return signed(setField(header, f, s.value), JSON.stringify(payload), true);
        case "delete":
          return signed(without(header, f), JSON.stringify(payload), true);
        case "dupkey":
          return signed(dupLast(header, f, s.value), JSON.stringify(payload), true);
        case "notobject":
          return signed(s.value, JSON.stringify(payload), true);
      }
      break;
    }
    case "signed-payload": {
      const f = pick(CLAIM_FIELDS, s.field);
      const h2 = JSON.stringify(header);
      switch (s.op) {
        case "badvalue":
          return signed(h2, setField(payload, f, s.value), true);
        case "delete":
          return signed(h2, without(payload, f), true);
        case "dupkey":
          return signed(h2, dupLast(payload, f, s.value), true);
        case "protonest":
          // all claims only inside "__proto__": own members of the parsed object are missing, an inherited read must not rescue them
          return signed(h2, `{"__proto__":${JSON.stringify(payload)}}`, true);
        case "notobject":
          return signed(h2, s.value, true);
        case "expiry": {
          const t = Math.floor(Date.now() / 1000);
          return signed(h2, JSON.stringify({ ...payload, iat: t - 7200, exp: t - 3600 }), true);
        }
        case "future": {
          const t = Math.floor(Date.now() / 1000);
          return signed(h2, JSON.stringify({ ...payload, iat: t + 1e9, exp: t + 1e9 + 60 }), true);
        }
        case "bignum":
          return signed(h2, setField(payload, f, `${"9".repeat(500)}`), true);
      }
      break;
    }
    case "body": {
      let text = "";
      let contentType = "application/json";
      switch (s.shape) {
        case "json-number":
          text = JSON.stringify({ grant_type: GRANT, assertion: 12345 });
          break;
        case "json-array":
          text = JSON.stringify({ grant_type: GRANT, assertion: [base] });
          break;
        case "json-object":
          text = JSON.stringify({ grant_type: GRANT, assertion: { toString: base } });
          break;
        case "json-null":
          text = JSON.stringify({ grant_type: GRANT, assertion: null });
          break;
        case "json-huge":
          text = JSON.stringify({ grant_type: GRANT, assertion: "a.".repeat(10_000) });
          break;
        case "json-nested":
          text = `{"grant_type":${JSON.stringify(GRANT)},"assertion":${"[".repeat(3000)}${"]".repeat(3000)}}`;
          break;
        case "empty":
          text = "";
          break;
        case "missing":
          contentType = "application/x-www-form-urlencoded";
          text = `grant_type=${encodeURIComponent(GRANT)}&${encodeURIComponent(s.junk)}=1`;
          break;
        case "big-form":
          contentType = "application/x-www-form-urlencoded";
          text = `grant_type=${encodeURIComponent(GRANT)}&assertion=${"A".repeat(40_000)}`;
          break;
        case "no-grant":
          contentType = "application/x-www-form-urlencoded";
          text = `assertion=${encodeURIComponent(base)}`;
          break;
      }
      return { assertion: "", body: { contentType, text }, mustReject: true };
    }
  }
  throw new Error("unreachable");
}

export function jwsMutations(world: () => World): void {
  describe("agent assertion mutations at /oauth/token (C62)", () => {
    const token = (w: World, c: Case) =>
      rawRequest(w.publicUrl, "/oauth/token", {
        method: "POST",
        headers: { "content-type": c.body?.contentType ?? "application/x-www-form-urlencoded" },
        body: c.body?.text ?? new URLSearchParams({ grant_type: GRANT, assertion: c.assertion }).toString(),
      });

    test("control: the unmodified assertion is accepted (the oracle is not vacuous)", async () => {
      const w = world();
      const r = await token(w, { assertion: await w.agentAssertion(AGT, CON), mustReject: false });
      assert.equal(r.status, 200);
      assert.ok((tryJson(r.body) as { access_token?: string }).access_token);
    });

    test("header/payload/signature mutations, duplicate keys, __proto__, huge numbers, bad characters, extra segments: always a 4xx JSON refusal, never a 5xx, never an access token", async () => {
      const w = world();
      const kinds = new Set<string>();
      await check(
        "jws.mutations",
        fc.asyncProperty(spec, async (s) => {
          const c = await build(w, s);
          const r = await token(w, c);
          const j = tryJson(r.body) as { access_token?: unknown } | undefined;
          const where = `${s.k}:${"op" in s ? s.op : "shape" in s ? s.shape : ""}`;
          kinds.add(s.k);
          assert.ok(r.status < 500, `HTTP ${r.status} for ${where}: ${r.body.slice(0, 200)}`);
          assert.ok(j !== undefined && typeof j === "object", `non-JSON answer (${r.status}) for ${where}: ${r.body.slice(0, 100)}`);
          if (c.mustReject) {
            assert.ok(r.status >= 400 && r.status < 500, `${where} must be refused, got ${r.status}`);
            assert.equal(j?.access_token, undefined, `access token issued for ${where}: ${c.assertion.slice(0, 300)}`);
          }
        }),
        { seed: 62040, numRuns: 3000, timeMs: 40_000 },
      );
      assert.ok(kinds.size >= 6, `generator covered ${[...kinds].join(",")}`);
    });
  });
}
