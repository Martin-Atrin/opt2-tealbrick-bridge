/** C62 property: `redact()` follows random RFC 6901 pointers and never touches the shared prototypes. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { redact } from "../../src/calls.ts";
import { check, fc } from "./support.ts";

const KEYS = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "length", "a", "b", "0", "1", "-1", "", "~0", "~1", "x/y", "~"];
const key = fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...KEYS) }, { weight: 1, arbitrary: fc.string({ maxLength: 6 }) });

type Tree = unknown;
/** JSON text (not an object literal): `JSON.parse` makes `__proto__` an OWN key, like a real after-hook response. */
const tree: fc.Arbitrary<Tree> = fc.letrec((tie) => ({
  leaf: fc.oneof(fc.constant(null), fc.boolean(), fc.integer(), fc.string({ maxLength: 5 })),
  node: fc.oneof(
    { weight: 2, arbitrary: tie("leaf") },
    { weight: 1, arbitrary: fc.array(tie("node"), { maxLength: 4 }) },
    { weight: 2, arbitrary: fc.array(fc.tuple(key, tie("node")), { maxLength: 4 }).map((kv) => ({ __kv: kv })) },
  ),
})).node;

function toText(t: Tree): string {
  if (Array.isArray(t)) return `[${t.map(toText).join(",")}]`;
  if (t && typeof t === "object" && "__kv" in t) {
    return `{${(t as { __kv: [string, Tree][] }).__kv.map(([k, v]) => `${JSON.stringify(k)}:${toText(v)}`).join(",")}}`;
  }
  return JSON.stringify(t);
}

const json = tree.map((t) => JSON.parse(toText(t)) as unknown);
const escapePointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const segment = fc.oneof(
  { weight: 6, arbitrary: key.map(escapePointer) },
  { weight: 1, arbitrary: key }, // raw: may contain "~" and "/" (extra segments, bad escapes)
  { weight: 1, arbitrary: fc.constantFrom("~0", "~1", "~2", "~", "~0~1", "%5f%5fproto%5f%5f") },
);
const pointer = fc.oneof(
  { weight: 8, arbitrary: fc.array(segment, { minLength: 1, maxLength: 5 }).map((s) => `/${s.join("/")}`) },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
  { weight: 1, arbitrary: fc.anything() },
);
const hasProtoSegment = (p: unknown): boolean => typeof p === "string" && p.split("/").some((s) => s === "__proto__");

/** Everything observable about the two shared prototypes (own keys, descriptors). */
function snapshot() {
  return [Object.prototype, Array.prototype].map((p) => Reflect.ownKeys(p).map((k) => [k, Object.getOwnPropertyDescriptor(p, k)] as const));
}
const before = snapshot();

function restore(): void {
  [Object.prototype, Array.prototype].forEach((p, i) => {
    for (const [k, d] of before[i] ?? []) if (d && !Object.hasOwn(p, k)) Object.defineProperty(p, k, d);
  });
}

function assertPristine(pointers: unknown[]): void {
  const now = snapshot();
  const same = now.every((own, i) => {
    const was = new Map(before[i]);
    return own.length === was.size && own.every(([k, d]) => {
      const w = was.get(k);
      return !!w && w.value === d?.value && w.get === d?.get && w.set === d?.set;
    });
  });
  if (!same) {
    const missing = [Object.prototype, Array.prototype].flatMap((p, i) => (before[i] ?? []).filter(([k]) => !Object.hasOwn(p, k)).map(([k]) => String(k)));
    restore();
    assert.fail(`prototype changed by pointers ${JSON.stringify(pointers)}; lost members: ${missing.join(", ") || "(added or replaced)"}`);
  }
}

describe("redact() properties (C62)", () => {
  test("never throws, never mutates its input, only removes members, for any pointers", async () => {
    await check(
      "redact.shape",
      fc.property(json, fc.array(pointer, { maxLength: 4 }), (value, pointers) => {
        const text = JSON.stringify(value);
        const out = redact(value as never, pointers);
        restore();
        assert.equal(JSON.stringify(value), text, "input is not mutated");
        assert.ok(JSON.stringify(out).length <= text.length, "redaction only removes");
      }),
      { seed: 62001, numRuns: 3000 },
    );
  });

  test("pointers without a __proto__ segment (constructor, prototype, ~0, ~1, numeric...) never change Object.prototype or Array.prototype", async () => {
    await check(
      "redact.prototypes.noproto",
      fc.property(json, fc.array(pointer.filter((p) => !hasProtoSegment(p)), { maxLength: 4 }), (value, pointers) => {
        redact(value as never, pointers);
        assertPristine(pointers);
      }),
      { seed: 62002, numRuns: 4000 },
    );
  });

  // C62: with this tree and pointer ["/__proto__/toString"] redact() walks into Object.prototype and deletes toString (BSD-06)
  test(
    "random pointers incl. __proto__ never change Object.prototype or Array.prototype",
    async () => {
      await check(
        "redact.prototypes.all",
        fc.property(json, fc.array(pointer, { maxLength: 4 }), (value, pointers) => {
          redact(value as never, pointers);
          assertPristine(pointers);
        }),
        { seed: 62003, numRuns: 4000 },
      );
    },
  );
});
