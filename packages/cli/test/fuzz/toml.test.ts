/** C62 property: the TOML scanner/upsert throw only TomlError, whatever the text. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scanToml, TomlError, tomlString, upsertMcpTable } from "../../src/toml.ts";
import { check, fc } from "./support.ts";

const PIECES = [
  "[", "]", "[[", "]]", '"', "'", '"""', "'''", "=", "#", "\\", ".", ",", "{", "}", "\n", "\r\n", "\n", " ", "\t", "a", "b", "mcp_servers", "tealbrick", "[mcp_servers.tealbrick]", "[mcp_servers]", "[[mcp_servers.tealbrick]]",
  "[mcp_servers.tealbrick.env]", 'command = "x"', "args = [", '"\\u00e9"', "\\\"", "= ", " = 1", "\u0000", "﻿", " ", "é", "key", "-", "_", "0",
];
const piece = fc.constantFrom(...PIECES);
const LINES = [
  "# comment", "", 'model = "gpt"', "[mcp_servers.other]", 'command = "o"', "[mcp_servers.tealbrick]", 'command = "old"', 'args = ["a", "b"]', "[mcp_servers.tealbrick.env]", "[[mcp_servers.tealbrick]]", "[profiles.x]", 'multi = """',
  'text"""', "list = [", "  1,", "]", 'mcp_servers.tealbrick.command = "dotted"', "[mcp_servers]", "inline = { a = 1 }",
];
const document = fc.array(fc.constantFrom(...LINES), { maxLength: 14 }).map((a) => a.join("\n"));
const text = fc.oneof(
  { weight: 5, arbitrary: document },
  { weight: 5, arbitrary: fc.array(piece, { maxLength: 40 }).map((a) => a.join("")) },
  { weight: 2, arbitrary: fc.array(fc.array(piece, { maxLength: 6 }).map((a) => a.join("")), { maxLength: 8 }).map((a) => a.join("\n")) },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 80 }) },
  { weight: 1, arbitrary: fc.string({ maxLength: 80 }) },
);
const body = fc.array(fc.oneof({ weight: 1, arbitrary: fc.string({ maxLength: 20 }) }, { weight: 4, arbitrary: fc.constantFrom('command = "tealbrick"', 'args = ["mcp"]', "[x]", "", "# c") }), { maxLength: 4 });

const onlyTomlError = (f: () => unknown): { ok: boolean } => {
  try {
    f();
    return { ok: true };
  } catch (e) {
    assert.ok(e instanceof TomlError, `threw ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`);
    return { ok: false };
  }
};

describe("toml scanner properties (C62)", () => {
  test("scanToml throws nothing but TomlError", () => {
    let ok = 0;
    let refused = 0;
    check(
      "cli.scanToml",
      fc.property(text, (t) => {
        if (onlyTomlError(() => scanToml(t)).ok) ok++;
        else refused++;
      }),
      { seed: 62060, numRuns: 6000 },
    );
    assert.ok(ok > 0 && refused > 0, `generator reached both outcomes (accepted ${ok}, refused ${refused})`);
  });

  test("upsertMcpTable throws nothing but TomlError; on success the result scans cleanly with exactly one [mcp_servers.tealbrick] and a second upsert changes nothing", () => {
    let checked = 0;
    check(
      "cli.upsertMcpTable",
      fc.property(text, body, (t, lines) => {
        let out = "";
        if (!onlyTomlError(() => (out = upsertMcpTable(t, lines))).ok) return;
        assert.ok(out.endsWith("\n"));
        // body lines are free text: only assert the table itself when they cannot open a table or string of their own
        // (a blank LAST body line is trailing whitespace that the section trimming removes, so it is not idempotent by design)
        if (lines.length > 0 && lines.every((l) => /^[a-z]+ = ("[a-z]*"|\[.*\])$|^#.*$/.test(l))) {
          const headers = scanToml(out).filter((s) => s.kind === "header" && !s.array && s.path.join(".") === "mcp_servers.tealbrick");
          checked++;
          assert.equal(headers.length, 1, "exactly one table after upsert");
          assert.equal(upsertMcpTable(out, lines), out, "idempotent");
        }
      }),
      { seed: 62061, numRuns: 4000 },
    );
    assert.ok(checked > 100, `the idempotence branch ran ${checked} times`);
  });

  test("tomlString output is always a JSON string that round-trips", () => {
    check(
      "cli.tomlString",
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (s) => {
        assert.equal(JSON.parse(tomlString(s)), s);
      }),
      { seed: 62062, numRuns: 1000 },
    );
  });
});
