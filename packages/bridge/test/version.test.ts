import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BRIDGE_VERSION } from "../src/context.ts";

test("reported bridge version is read from the bridge package and equals bridge-server's (one release number)", () => {
  const read = (p: string) => (JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { version: string }).version;
  assert.equal(read("../package.json"), BRIDGE_VERSION);
  assert.equal(read("../../bridge-server/package.json"), BRIDGE_VERSION);
  assert.match(BRIDGE_VERSION, /^\d+\.\d+\.\d+$/);
});
