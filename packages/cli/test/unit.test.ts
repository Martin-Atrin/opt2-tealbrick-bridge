import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { unifiedDiff } from "../src/diff.ts";
import { checkStep, collectRefs, moveStep, removeStep } from "../src/draft.ts";
import { exitForError, normalizePortalOrigin } from "../src/portal.ts";
import type { SecurityRunner } from "../src/store.ts";
import { buildKeychainAddCommand, createFileStore, createKeychainStore } from "../src/store.ts";
import { scanToml, TomlError, upsertMcpTable } from "../src/toml.ts";

describe("keychain store", () => {
  it("never puts the secret in argv: add goes through `security -i` stdin", async () => {
    const calls: { args: string[]; stdin: string | undefined }[] = [];
    const run: SecurityRunner = async (args, stdin) => {
      calls.push({ args, stdin });
      return { code: 0, stdout: "", stderr: "" };
    };
    const secret = '{"token":"tbo_very_secret value with spaces and \\"quotes\\""}';
    await createKeychainStore(run).put("tealbrick.person", secret);
    assert.deepEqual(calls[0]?.args, ["-i"]);
    assert.ok(!JSON.stringify(calls[0]?.args).includes("tbo_"));
    const line = calls[0]?.stdin ?? "";
    assert.match(line, /^add-generic-password -U -s tealbrick\.person -a default -w [A-Za-z0-9_-]+\n$/);
    const b64 = /-w (\S+)\n/.exec(line)?.[1] as string;
    assert.equal(Buffer.from(b64, "base64url").toString("utf8"), secret);
    assert.throws(() => buildKeychainAddCommand("tealbrick.x\nadd-generic-password", "v"));
  });

  it("get decodes, not-found is null, list parses dump-keychain metadata", async () => {
    const run: SecurityRunner = async (args) => {
      if (args[0] === "find-generic-password") {
        return args.includes("tealbrick.person")
          ? { code: 0, stdout: `${Buffer.from("hello").toString("base64url")}\n`, stderr: "" }
          : { code: 44, stdout: "", stderr: "not found" };
      }
      if (args[0] === "dump-keychain") {
        return { code: 0, stdout: '    "svce"<blob>="tealbrick.person"\n    "svce"<blob>="tealbrick.agent.con_1"\n    "svce"<blob>="other"\n', stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const s = createKeychainStore(run);
    assert.equal(await s.get("tealbrick.person"), "hello");
    assert.equal(await s.get("tealbrick.agent.con_9"), null);
    assert.deepEqual(await s.list(), ["tealbrick.agent.con_1", "tealbrick.person"]);
  });
});

describe("file store", () => {
  it("agent items only, mode 0600; the person item is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tb-file-store-"));
    try {
      const s = createFileStore(join(dir, "tealbrick"));
      await s.put("tealbrick.agent.con_1", "{}");
      const file = join(dir, "tealbrick", "agent-con_1.json");
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.deepEqual(await s.list(), ["tealbrick.agent.con_1"]);
      assert.equal(await s.get("tealbrick.agent.con_1"), "{}");
      assert.equal(await s.delete("tealbrick.agent.con_1"), true);
      await assert.rejects(s.put("tealbrick.person", "x"), /keychain/);
      await assert.rejects(s.get("tealbrick.person"), /keychain/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("draft helpers", () => {
  it("collectRefs finds nested refs and malformed ones", () => {
    const r = collectRefs({ a: { $ref: "#/steps/2/output/x~1y" }, b: [{ $ref: "#/steps/0/output" }, { $ref: "nope" }], c: { $ref: "#/steps/1/output/id", extra: 1 } });
    assert.deepEqual(r.refs.map((x) => x.step), [2, 0]);
    assert.equal(r.bad.length, 2);
  });

  it("checkStep: ref must point earlier", () => {
    const step = { opId: "edges.create", input: { ws: "ws_1", agt: { $ref: "#/steps/1/output/id" }, product: "p", crud: ["read"] } };
    assert.equal(checkStep(step, 1, "ws_1").length, 1);
    assert.equal(checkStep(step, 2, "ws_1").length, 0);
  });

  it("removeStep and moveStep renumber refs", () => {
    const a = { opId: "agents.create", input: { name: "a" } };
    const b = { opId: "agents.create", input: { name: "b" } };
    const e = { opId: "edges.create", input: { agt: { $ref: "#/steps/1/output/id" }, product: "p", crud: ["read"] } };
    assert.deepEqual(removeStep([a, b, e], 0).steps[1]?.input.agt, { $ref: "#/steps/0/output/id" });
    assert.ok(removeStep([a, b, e], 1).dangling);
    const moved = moveStep([a, b, e], 0, 1);
    assert.deepEqual(moved[2]?.input.agt, { $ref: "#/steps/0/output/id" });
  });
});

describe("portal helpers", () => {
  it("exit code mapping", () => {
    assert.equal(exitForError(401, "x"), 3);
    assert.equal(exitForError(403, "forbidden"), 5);
    assert.equal(exitForError(422, "draft_op_not_draftable"), 5);
    assert.equal(exitForError(404, "not_found"), 6);
    assert.equal(exitForError(409, "revision_conflict"), 7);
    assert.equal(exitForError(422, "draft_state"), 7);
    assert.equal(exitForError(422, "validation_failed"), 8);
    assert.equal(exitForError(502, "internal"), 9);
  });

  it("origin must be https; loopback may use http", () => {
    assert.equal(normalizePortalOrigin("https://p.example.test/x/y"), "https://p.example.test");
    assert.equal(normalizePortalOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
    assert.throws(() => normalizePortalOrigin("http://p.example.test"));
    assert.throws(() => normalizePortalOrigin("not a url"));
  });
});

describe("toml + diff", () => {
  it("scanToml accepts multi-line strings and arrays, rejects broken input", () => {
    assert.doesNotThrow(() => scanToml('a = """x\n[not.a.header]\n"""\nb = [\n 1,\n [2],\n]\n[t.u] # c\nk = { x = "y" }\n'));
    assert.throws(() => scanToml("a = [1, 2\n"), TomlError);
    assert.throws(() => scanToml('a = "x\n'), TomlError);
    assert.throws(() => scanToml("just words\n"), TomlError);
    assert.throws(() => scanToml("[bad\n"), TomlError);
  });

  it("upsertMcpTable on an empty file and with trailing comments", () => {
    assert.equal(upsertMcpTable("", ['command = "t"']), '[mcp_servers.tealbrick]\ncommand = "t"\n');
    const out = upsertMcpTable('[mcp_servers.tealbrick]\ncommand = "old" # why\n# note\n\n[x]\na = 1\n', ['command = "t"']);
    assert.equal(out, '[mcp_servers.tealbrick]\ncommand = "t"\n\n[x]\na = 1\n');
  });

  it("unifiedDiff marks added and removed lines with context hunks", () => {
    const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\nd\n", "f");
    assert.match(d, /^--- f\n\+\+\+ f \(proposed\)\n@@ -1,3 \+1,4 @@\n a\n-b\n\+B\n c\n\+d$/);
    assert.equal(unifiedDiff("x\n", "x\n", "f").includes("@@"), false);
    assert.match(unifiedDiff("", '{\n}\n', "f"), /@@ -0,0 \+1,2 @@\n\+\{\n\+\}/);
  });
});
