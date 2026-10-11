import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BRIDGE_VERSION, SDK_MAJORS, sdkMajorOf } from "../src/context.ts";

test("reported bridge version = bridge and bridge-server package versions (one release number)", () => {
  const read = (p: string) => (JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { version: string }).version;
  assert.equal(read("../package.json"), BRIDGE_VERSION);
  assert.equal(read("../../bridge-server/package.json"), BRIDGE_VERSION);
});

test("SDK 0.x counts as major 1 (C44); other majors map to themselves; junk is unsupported", () => {
  assert.equal(sdkMajorOf("0.1.2"), 1);
  assert.equal(sdkMajorOf("0.9.0-rc.1"), 1);
  assert.equal(sdkMajorOf("1.4.0"), 1);
  assert.equal(sdkMajorOf("2.0.0"), 2);
  assert.equal(sdkMajorOf("x"), undefined);
  assert.ok(SDK_MAJORS.includes(sdkMajorOf("0.1.2") as number));
});
