/**
 * Unit and property tests for the bridge hardening helpers: prototype-safe redaction (BSD-06), capped app
 * answers (BSD-05), app error-code rules and fixed metric labels (H-5, H-7), the token bucket (BSD-02).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { JsonValue } from "@opt2-tealbrick/spec/bridge";
import fc from "fast-check";
import { appErrorCode, appErrorMessage, metricCode, redact } from "../src/calls.ts";
import { BridgeError, readCapped, TokenBucket } from "../src/util.ts";

const protoNames = () => Object.getOwnPropertyNames(Object.prototype).sort();
const protoDescriptors = () => Object.getOwnPropertyDescriptors(Object.prototype);

describe("BSD-06: redact() never reaches a prototype", () => {
  test("/__proto__/toString and /constructor/prototype/x do not change Object.prototype", () => {
    const before = protoNames();
    const protoToString = Object.prototype.toString;
    const out = redact({ a: 1, b: { c: 2 } }, ["/__proto__/toString", "/constructor/prototype/x", "/constructor/prototype/hasOwnProperty", "/b/__proto__/valueOf", "/prototype"]);
    assert.deepEqual(protoNames(), before);
    assert.equal(Object.prototype.toString, protoToString);
    assert.deepEqual(out, { a: 1, b: { c: 2 } });
  });

  test("own members are still removed (objects, arrays, escaped segments)", () => {
    const value: JsonValue = { a: { "x/y": 1, "t~": 2, keep: 3 }, list: [10, 20, 30], s: "x" };
    assert.deepEqual(redact(value, ["/a/x~1y", "/a/t~0", "/list/1", "/missing/deep", "/list/01", "/s/0"]), { a: { keep: 3 }, list: [10, 30], s: "x" });
    assert.deepEqual(value, { a: { "x/y": 1, "t~": 2, keep: 3 }, list: [10, 20, 30], s: "x" }, "input not mutated");
  });

  test("an own key named like a prototype member is not followed into the prototype", () => {
    const out = redact({ toString: { inner: 1 }, hasOwnProperty: 2 } as JsonValue, ["/toString/inner", "/hasOwnProperty", "/valueOf"]);
    assert.deepEqual(out, { toString: {} });
    assert.equal(typeof Object.prototype.valueOf, "function");
  });

  test("property: random pointers over random JSON never change Object.prototype", () => {
    const before = protoDescriptors();
    const segment = fc.oneof(fc.constantFrom("__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "0", "1", "a", "b"), fc.string({ maxLength: 6 }));
    const pointer = fc.array(segment, { minLength: 1, maxLength: 5 }).map((parts) => `/${parts.map((p) => p.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`);
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), fc.array(pointer, { maxLength: 8 }), (value, pointers) => {
        redact(value as JsonValue, pointers);
        const after = protoDescriptors();
        assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
        for (const k of Object.keys(before)) assert.equal((after as Record<string, PropertyDescriptor>)[k]?.value, (before as Record<string, PropertyDescriptor>)[k]?.value, k);
      }),
      { numRuns: 500 },
    );
  });
});

describe("BSD-05: readCapped()", () => {
  test("an endless app body is cut at the cap with payload_too_large and the stream is cancelled", async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(readCapped(new Response(body), 256 * 1024), (e: unknown) => e instanceof BridgeError && e.code === "payload_too_large");
    assert.ok(cancelled, "the body stream is cancelled");
    assert.ok(pulled <= 8, `stopped reading early (${pulled} chunks)`);
  });

  test("a declared Content-Length over the cap is refused before reading", async () => {
    const res = new Response("x", { headers: { "content-length": String(10 * 1024 * 1024) } });
    await assert.rejects(readCapped(res, 1024), (e: unknown) => e instanceof BridgeError && e.code === "payload_too_large");
  });

  test("a body within the cap is returned whole", async () => {
    const buf = await readCapped(new Response(JSON.stringify({ ok: true })), 1024);
    assert.deepEqual(JSON.parse(buf.toString("utf8")), { ok: true });
  });
});

describe("H-5 / H-7: app error codes and metric labels", () => {
  test("bridge verdict codes and malformed codes from an app become app_error", () => {
    for (const c of ["paused", "grant_revoked", "grant_invalid", "grant_expired", "no_grant", "unauthenticated", "config_expired", "hook_denied", "hook_failed", "crud_exceeds_grant", "not_in_workflow", "audience_not_agent", "scope_type_unknown"]) {
      assert.equal(appErrorCode(c), "app_error", c);
    }
    for (const c of ["", "a", "Scope_denied", "scope-denied", "scope denied", `a${"b".repeat(41)}`, "x\n", 42, null]) assert.equal(appErrorCode(c), "app_error", String(c));
    for (const c of ["scope_denied", "idempotency_conflict", "not_found", "ab"]) assert.equal(appErrorCode(c), c);
  });

  test("app messages lose control and bidi-override characters and are capped", () => {
    assert.equal(appErrorMessage("a\u0000b\u001b[31mc\u007f\u0085d‮", "fb"), "a b [31mc  d");
    assert.equal(appErrorMessage(undefined, "fb"), "fb");
    assert.equal(appErrorMessage("\n\t", "fb"), "fb");
    assert.equal(appErrorMessage("x".repeat(2000), "fb").length, 500);
  });

  test("metric labels come from a fixed set", () => {
    assert.equal(metricCode("ok"), "ok");
    assert.equal(metricCode("paused"), "paused");
    assert.equal(metricCode("rate_limited"), "rate_limited");
    assert.equal(metricCode("scope_denied"), "app_code");
    assert.equal(metricCode('x"}\n'), "app_code");
  });
});

describe("BSD-02: TokenBucket", () => {
  test("burst then refill; keys are independent", async () => {
    const b = new TokenBucket(10, 5);
    for (let i = 0; i < 5; i++) assert.equal(b.take("a"), 0);
    assert.ok(b.take("a") >= 1, "over the burst: seconds to wait");
    assert.equal(b.take("b"), 0, "another key is not affected");
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(b.take("a"), 0, "refilled at the rate");
  });
});
