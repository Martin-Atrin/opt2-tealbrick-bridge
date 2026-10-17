// L34: the agent-side gate is quiet on the clean tree and fires on every planted violation.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_SYMBOLS, agentSideGate } from "../agent-side-gate.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BRIDGE_PKG = JSON.stringify({ name: "@opt2-tealbrick/bridge", dependencies: { "@opt2-tealbrick/relay": "https://example.invalid/relay.tgz" } });

/** a minimal clean tree with the files planted on top */
function tree(files: Record<string, string>): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "tb-agent-gate-"));
  const all: Record<string, string> = { "packages/bridge/package.json": BRIDGE_PKG, "packages/bridge/src/index.ts": "export const a = 1;\n", ...files };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("agent-side gate", () => {
  test("quiet on this repo's tree", () => {
    assert.deepEqual(agentSideGate(repoRoot), []);
  });

  test("quiet on a minimal clean tree that imports the relay package", () => {
    const t = tree({ "packages/bridge/src/x.ts": 'import { startRelay, isRefusal, type ManifestApi } from "@opt2-tealbrick/relay";\nexport const go = () => startRelay;\n' });
    try {
      assert.deepEqual(agentSideGate(t.root), []);
    } finally {
      t.done();
    }
  });

  test("fires on a re-added agent-side module file name", () => {
    for (const f of ["relay.ts", "relay-entry.ts", "mcp-client.ts", "json-limits.ts", "api.ts"]) {
      const t = tree({ [`packages/bridge/src/${f}`]: "export const a = 1;\n" });
      try {
        assert.ok(
          agentSideGate(t.root).some((p) => p.includes(`src/${f}`) && p.includes("agent-side module file name")),
          f,
        );
      } finally {
        t.done();
      }
    }
  });

  test("fires on a re-added agent-side package directory", () => {
    for (const d of ["cli", "harness-claude", "harness-eve", "relay"]) {
      const t = tree({ [`packages/${d}/package.json`]: "{}" });
      try {
        assert.ok(agentSideGate(t.root).some((p) => p.startsWith(`packages/${d}/`)), d);
      } finally {
        t.done();
      }
    }
  });

  test("fires on a definition of every relay-owned symbol, in any file name and in any declaration form", () => {
    for (const s of AGENT_SYMBOLS) {
      for (const decl of [`export function ${s}() {}`, `export async function ${s}() {}`, `export const ${s} = 1;`, `export interface ${s} {}`, `export type ${s} = string;`, `class ${s} {}`]) {
        const t = tree({ "packages/bridge/src/other.ts": `${decl}\n` });
        try {
          assert.ok(
            agentSideGate(t.root).some((p) => p.includes(`defines ${s}`)),
            decl,
          );
        } finally {
          t.done();
        }
      }
    }
  });

  test("fires on a relative import of an agent-side module", () => {
    for (const line of ['import { startRelay } from "./relay.ts";', 'export * from "../src/mcp-client.ts";', 'const m = await import("../src/json-limits.ts");', 'import type { Json } from "./api.ts";']) {
      const t = tree({ "packages/bridge/test/y.test.ts": `${line}\n` });
      try {
        assert.ok(
          agentSideGate(t.root).some((p) => p.includes("by a relative path")),
          line,
        );
      } finally {
        t.done();
      }
    }
  });

  test("a use or an import of a relay symbol from the package is not a definition", () => {
    const t = tree({ "packages/bridge/src/z.ts": 'import { tooDeep, validRpcId, MCP_VERSIONS } from "@opt2-tealbrick/relay";\nexport const ok = tooDeep(1) && validRpcId(1) && MCP_VERSIONS.length;\n' });
    try {
      assert.deepEqual(agentSideGate(t.root), []);
    } finally {
      t.done();
    }
  });

  test("fires when the bridge package drops the relay dependency or exports ./relay again", () => {
    const noDep = tree({ "packages/bridge/package.json": JSON.stringify({ name: "@opt2-tealbrick/bridge", dependencies: {} }) });
    const exp = tree({ "packages/bridge/package.json": JSON.stringify({ name: "@opt2-tealbrick/bridge", dependencies: { "@opt2-tealbrick/relay": "x" }, exports: { ".": "./dist/index.js", "./relay": "./dist/relay-entry.js" } }) });
    try {
      assert.ok(agentSideGate(noDep.root).some((p) => p.includes("does not depend on @opt2-tealbrick/relay")));
      assert.ok(agentSideGate(exp.root).some((p) => p.includes("exports ./relay")));
    } finally {
      noDep.done();
      exp.done();
    }
  });
});
