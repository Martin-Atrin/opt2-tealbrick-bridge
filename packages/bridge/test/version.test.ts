import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BRIDGE_VERSION, SDK_CURRENT_MAJOR } from "../src/context.ts";
import { manifestApi } from "../src/manifest-adapter.ts";

test("reported bridge version is read from the bridge package and equals bridge-server's (one release number)", () => {
  const read = (p: string) => (JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { version: string }).version;
  assert.equal(read("../package.json"), BRIDGE_VERSION);
  assert.equal(read("../../bridge-server/package.json"), BRIDGE_VERSION);
  assert.match(BRIDGE_VERSION, /^\d+\.\d+\.\d+$/);
});

test("claims use manifest sdkMajorServed (C44): 0.x and 1.x served, 2.x and junk not", () => {
  const api = manifestApi();
  assert.equal(api.sdkMajorServed("0.1.2", SDK_CURRENT_MAJOR), true);
  assert.equal(api.sdkMajorServed("1.4.0", SDK_CURRENT_MAJOR), true);
  assert.equal(api.sdkMajorServed("2.0.0", SDK_CURRENT_MAJOR), false);
  assert.equal(api.sdkMajorServed("x", SDK_CURRENT_MAJOR), false);
});
