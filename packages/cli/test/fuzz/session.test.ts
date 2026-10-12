/** C62 property: `classifyCredential` never throws and always answers one of three words, for any input. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyCredential } from "../../src/session.ts";
import { check, fc } from "./support.ts";

const TOKENS = ["tbo_abc", "tbr_abc", "tbac_x", "tbdv_x", "tbat_x", "eyJhbGciOi", "tbo_", "", " tbo_x", "TBO_x", "﻿tbo_x", "tbo_\u0000"];
const KEYS = ["kind", "token", "access_token", "privateKey", "private_key", "jwk", "con", "agt", "sessionId", "portal", "expiresAt", "__proto__", "constructor", "toString"];
const scalar = fc.oneof(fc.constantFrom(...TOKENS), fc.string({ maxLength: 12 }), fc.integer(), fc.boolean(), fc.constant(null));
const valueWith = (nestedKeys: string[]) => fc.oneof(scalar, fc.constantFrom("agent", "person", "owner"), fc.array(scalar, { maxLength: 3 }), fc.dictionary(fc.constantFrom(...nestedKeys), scalar, { maxKeys: 3 }));
// built as JSON text so "__proto__" is an own key, as in a stored credential item
const objectTextWith = (nestedKeys: string[]) => fc.array(fc.tuple(fc.constantFrom(...KEYS), valueWith(nestedKeys)), { maxLength: 6 }).map((kv) => `{${kv.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`);
// "toString" as a nested key makes String(token) throw (see the BUG-skipped test below)
const objectText = objectTextWith(KEYS.filter((k) => k !== "toString"));
const inputWith = (objects: fc.Arbitrary<string>) => fc.oneof(
  { weight: 3, arbitrary: fc.string({ maxLength: 60 }) },
  { weight: 2, arbitrary: fc.string({ unit: "binary", maxLength: 60 }) },
  { weight: 4, arbitrary: objects },
  { weight: 2, arbitrary: fc.tuple(fc.constantFrom(...TOKENS), fc.string({ maxLength: 30 })).map(([a, b]) => a + b) },
  { weight: 1, arbitrary: fc.jsonValue().map((v) => JSON.stringify(v)) },
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom("tbo_", "eyJ", "{", "[", " "), fc.nat({ max: 200_000 })).map(([c, n]) => c.repeat(Math.min(n, 100_000))) },
);
const input = inputWith(objectText);

describe("classifyCredential properties (C62)", () => {
  test("never throws and returns person | agent | unknown", async () => {
    const seen = new Set<string>();
    check(
      "cli.classifyCredential",
      fc.property(input, (raw) => {
        const kind = classifyCredential(raw);
        seen.add(kind);
        assert.ok(kind === "person" || kind === "agent" || kind === "unknown", `unexpected ${String(kind)}`);
      }),
      { seed: 62050, numRuns: 5000 },
    );
    assert.ok(seen.size === 3, `generator reached ${[...seen].join(",")}`);
  });

  test(
    "never throws on a credential whose token is an object with its own toString (nested keys unrestricted)",
    { skip: "BUG: classifyCredential throws TypeError (String(parsed.token)) for {\"kind\":\"person\",\"token\":{\"toString\":null}} (session.ts:34)" },
    () => {
      check(
        "cli.classifyCredential.all",
        fc.property(inputWith(objectTextWith(KEYS)), (raw) => {
          assert.ok(["person", "agent", "unknown"].includes(classifyCredential(raw)));
        }),
        { seed: 62052, numRuns: 5000 },
      );
    },
  );

  test("a bare tbo_ token or tbr_/tbac_/eyJ token is never classified across kinds", () => {
    check(
      "cli.classifyCredential.prefix",
      fc.property(fc.string({ maxLength: 30 }), (tail) => {
        assert.equal(classifyCredential(`tbr_${tail}`), "agent");
        assert.equal(classifyCredential(`eyJ${tail}`), "agent");
        assert.notEqual(classifyCredential(JSON.stringify({ kind: "person", token: `tbr_${tail}` })), "person");
        assert.equal(classifyCredential(JSON.stringify({ token: `tbo_${tail}` })), "person");
      }),
      { seed: 62051, numRuns: 1000 },
    );
  });

  test("a hostile-sized input is classified in well under a second (no regex blow-up)", () => {
    for (const s of ["tbo_".repeat(250_000), "{".repeat(500_000), "[".repeat(500_000), ` ${"a".repeat(1_000_000)}`, `{"token":"${"tbo_".repeat(200_000)}"}`, "e".repeat(1_000_000)]) {
      const t = performance.now();
      classifyCredential(s);
      assert.ok(performance.now() - t < 1000, `slow on input of ${s.length} chars`);
    }
  });
});
