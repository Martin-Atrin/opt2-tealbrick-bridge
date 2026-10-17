// L26 / L1: the bridge's verifier is @opt2-tealbrick/manifest, but since 0.2.0 the binding (manifestApi) lives in
// @opt2-tealbrick/relay, which imports the manifest package from ITS OWN dependency. If the two resolve to different
// versions, the bridge would verify grants, run gate() and validate app manifests with the relay's (older) library while
// its own pin says otherwise. This test fails as soon as they differ, so a manifest re-pin of the bridge also forces a
// relay re-pin or a pnpm override ("@opt2-tealbrick/relay>@opt2-tealbrick/manifest").
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

/** The package.json of the package that owns `entry` (walk up to the first package.json with that name). */
function pkgOf(entry: string, name: string): { dir: string; version: string } {
  let dir = dirname(entry);
  for (;;) {
    const f = join(dir, "package.json");
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, "utf8")) as { name?: string; version: string };
      if (j.name === name) return { dir, version: j.version };
    }
    const up = dirname(dir);
    if (up === dir) throw new Error(`no package.json for ${name} above ${entry}`);
    dir = up;
  }
}

test("the relay's manifest library is the bridge's manifest library (one verifier version)", () => {
  const fromBridge = createRequire(import.meta.url);
  const bridgeManifest = pkgOf(fromBridge.resolve("@opt2-tealbrick/manifest"), "@opt2-tealbrick/manifest");
  const relay = pkgOf(fromBridge.resolve("@opt2-tealbrick/relay"), "@opt2-tealbrick/relay");
  const relayManifest = pkgOf(createRequire(join(relay.dir, "package.json")).resolve("@opt2-tealbrick/manifest"), "@opt2-tealbrick/manifest");
  assert.equal(relayManifest.version, bridgeManifest.version, `relay uses manifest ${relayManifest.version}, the bridge pins ${bridgeManifest.version}`);
});
