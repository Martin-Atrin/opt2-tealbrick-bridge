import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_JSON_DEPTH, tooDeep, validRpcId } from "../src/json-limits.ts";

function nest(depth: number, shape: "array" | "object"): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = shape === "array" ? [v] : { k: v };
  return v;
}

test("C62: tooDeep is iterative and bounds nesting before any recursive digest sees it", () => {
  for (const shape of ["array", "object"] as const) {
    assert.equal(tooDeep(nest(MAX_JSON_DEPTH, shape)), false, `${shape} at the limit is accepted`);
    assert.equal(tooDeep(nest(MAX_JSON_DEPTH + 1, shape)), true);
    assert.equal(tooDeep(nest(200_000, shape)), true, "far beyond any stack");
  }
  assert.equal(tooDeep({ a: "x".repeat(2_000_000), b: [1, 2, { c: null }] }), false);
  assert.equal(tooDeep(null), false);
});

test("C62: JSON-RPC ids are a bounded string, a finite number or null", () => {
  for (const ok of [undefined, null, 0, 7, -1.5, "a", "x".repeat(256)]) assert.ok(validRpcId(ok), String(ok));
  for (const bad of [[], {}, true, Number.NaN, Number.POSITIVE_INFINITY, "x".repeat(257), nest(10, "array")]) assert.ok(!validRpcId(bad));
});
