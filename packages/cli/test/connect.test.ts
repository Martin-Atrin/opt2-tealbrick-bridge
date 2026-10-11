import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Harness } from "./fixtures.ts";

const AGT = "agt_01HXYZ";
const BRIDGE = "https://bridge.example.test";

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

describe("connect", () => {
  let h: Harness;
  let desktop: string;
  let codex: string;
  let mcpJson: string;
  beforeEach(async () => {
    h = new Harness();
    await h.setup();
    desktop = join(h.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    codex = join(h.home, ".codex", "config.toml");
    mcpJson = join(h.cwd, ".mcp.json");
  });
  afterEach(async () => {
    await h.teardown();
  });

  const baks = async (path: string) => (await readdir(dirname(path))).filter((f) => f.includes(".bak-"));

  it("prints by default for every harness and makes no Portal call", async () => {
    const dsk = await h.run(["connect", "claude-desktop", "--bridge", BRIDGE, "--agent", AGT, "--json"]);
    assert.equal(dsk.code, 0, dsk.err);
    assert.equal(dsk.json.mode, "remote");
    assert.equal(dsk.json.url, `${BRIDGE}/mcp`);

    const dskLocal = await h.run(["connect", "claude-desktop", "--local", "--agent", AGT, "--json"]);
    assert.deepEqual(dskLocal.json.entry, { command: "tealbrick", args: ["bridge", "serve", "--stdio", "--agent", AGT] });

    const cx = await h.run(["connect", "codex", "--agent", AGT]);
    assert.match(cx.out, /\[mcp_servers\.tealbrick\]\ncommand = "tealbrick"\nargs = \["bridge", "serve", "--stdio", "--agent", "agt_01HXYZ"\]/);
    const cxRemote = await h.run(["connect", "codex", "--remote", "--bridge", BRIDGE]);
    assert.match(cxRemote.out, /url = "https:\/\/bridge\.example\.test\/mcp"/);

    const cc = await h.run(["connect", "claude-code", "--agent", AGT]);
    assert.match(cc.out, /claude mcp add --scope user tealbrick -- tealbrick bridge serve --stdio --agent agt_01HXYZ/);

    const gen = await h.run(["connect", "generic", "--agent", AGT, "--bridge", BRIDGE, "--json"]);
    assert.equal(gen.json.entry.remote.url, `${BRIDGE}/mcp`);
    assert.equal(gen.json.entry.stdio.command, "tealbrick");

    assert.equal(h.portal.requests.length, 0);
    for (const p of [desktop, codex, mcpJson]) await assert.rejects(stat(p));
  });

  it("takes agt and bridge URL from the agent item, and never reads the person item or prints key material", async () => {
    await h.signIn();
    await h.store.put("tealbrick.agent.con_01", JSON.stringify({ kind: "agent", agt: AGT, bridgeUrl: BRIDGE, privateKey: "SECRET_KEY_MATERIAL" }));
    h.store.reads = [];
    const r = await h.run(["connect", "claude-desktop", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.url, `${BRIDGE}/mcp`);
    assert.ok(!r.out.includes("SECRET_KEY_MATERIAL") && !r.err.includes("SECRET_KEY_MATERIAL"));
    assert.ok(!h.store.reads.includes("tealbrick.person"));
    // two agent items need --agent
    await h.store.put("tealbrick.agent.con_02", JSON.stringify({ kind: "agent", agt: "agt_other", bridgeUrl: BRIDGE }));
    assert.equal((await h.run(["connect", "claude-desktop", "--json"])).code, 2);
    assert.equal((await h.run(["connect", "claude-desktop", "--agent", "agt_other", "--json"])).code, 0);
  });

  it("--write (claude-desktop --local): diff on stderr, backup kept, other keys preserved, atomic", async () => {
    await put(desktop, `{\n    "theme": "dark",\n    "mcpServers": {\n        "other": { "command": "x" }\n    }\n}\n`);
    const before = await readFile(desktop, "utf8");
    const r = await h.run(["connect", "claude-desktop", "--local", "--agent", AGT, "--write", "--yes", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.written, true);
    assert.match(r.err, /^--- /m);
    assert.match(r.err, /^\+.*"tealbrick"/m);
    const after = JSON.parse(await readFile(desktop, "utf8"));
    assert.equal(after.theme, "dark");
    assert.deepEqual(after.mcpServers.other, { command: "x" });
    assert.deepEqual(after.mcpServers.tealbrick, { command: "tealbrick", args: ["bridge", "serve", "--stdio", "--agent", AGT] });
    const bak = await baks(desktop);
    assert.equal(bak.length, 1);
    assert.match(bak[0] as string, /\.bak-20261011T120000Z$/);
    assert.equal(await readFile(join(dirname(desktop), bak[0] as string), "utf8"), before);
    assert.ok((await readFile(desktop, "utf8")).includes('\n    "theme"'), "indent style kept");
    assert.deepEqual((await readdir(dirname(desktop))).filter((f) => f.includes(".tmp-")), []);

    // idempotent: second run changes nothing and creates no new backup
    const again = await h.run(["connect", "claude-desktop", "--local", "--agent", AGT, "--write", "--yes", "--json"]);
    assert.equal(again.json.unchanged, true);
    assert.equal((await baks(desktop)).length, 1);
  });

  it("--write creates a missing file without a backup", async () => {
    const r = await h.run(["connect", "claude-code", "--agent", AGT, "--write", "--yes", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.backup, null);
    assert.deepEqual(JSON.parse(await readFile(mcpJson, "utf8")).mcpServers.tealbrick.args.at(-1), AGT);
  });

  it("a target that does not parse is never touched (exit 8), no backup", async () => {
    const broken = '{ "mcpServers": { "a": ';
    await put(desktop, broken);
    await put(mcpJson, "// comment\n{}");
    await put(codex, 'mcp_servers = { tealbrick = { command = "x" } }\n');
    for (const argv of [["claude-desktop", "--local"], ["claude-code"], ["codex"]]) {
      const r = await h.run(["connect", ...argv, "--agent", AGT, "--write", "--yes", "--json"]);
      assert.equal(r.code, 8, argv.join(" "));
      assert.equal(r.json.error.code, "validation_failed");
    }
    assert.equal(await readFile(desktop, "utf8"), broken);
    assert.equal(await readFile(mcpJson, "utf8"), "// comment\n{}");
    assert.equal(await readFile(codex, "utf8"), 'mcp_servers = { tealbrick = { command = "x" } }\n');
    for (const p of [desktop, mcpJson, codex]) assert.equal((await baks(p)).length, 0);
    // valid JSON of the wrong shape
    await put(desktop, "[1,2]");
    assert.equal((await h.run(["connect", "claude-desktop", "--local", "--agent", AGT, "--write", "--yes", "--json"])).code, 8);
    await put(desktop, '{"mcpServers": []}');
    assert.equal((await h.run(["connect", "claude-desktop", "--local", "--agent", AGT, "--write", "--yes", "--json"])).code, 8);
  });

  it("codex: appends the table, replaces only that table, keeps the rest and a backup", async () => {
    const original = `model = "x"\n\n[mcp_servers.other]\ncommand = "o"\nargs = [\n  "a",\n  "b",\n]\n`;
    await put(codex, original);
    const r1 = await h.run(["connect", "codex", "--agent", AGT, "--write", "--yes", "--json"]);
    assert.equal(r1.code, 0, r1.err);
    const t1 = await readFile(codex, "utf8");
    assert.ok(t1.startsWith(original), "existing content untouched");
    assert.match(t1, /\n\n\[mcp_servers\.tealbrick\]\ncommand = "tealbrick"\nargs = \["bridge", "serve", "--stdio", "--agent", "agt_01HXYZ"\]\n$/);
    assert.equal((await baks(codex)).length, 1);

    // replace: now with another table after it and a stale tealbrick body
    await put(codex, `[mcp_servers.tealbrick]\ncommand = "old"\nargs = []\n\n[mcp_servers.after]\ncommand = "z"\n`);
    const r2 = await h.run(["connect", "codex", "--remote", "--bridge", BRIDGE, "--write", "--yes", "--json"]);
    assert.equal(r2.code, 0, r2.err);
    assert.equal(await readFile(codex, "utf8"), `[mcp_servers.tealbrick]\nurl = "${BRIDGE}/mcp"\n\n[mcp_servers.after]\ncommand = "z"\n`);
  });

  it("codex: refuses a table it cannot cleanly replace", async () => {
    for (const text of [
      `[mcp_servers.tealbrick]\ncommand = "a"\n[mcp_servers.tealbrick.env]\nK = "v"\n`,
      `[mcp_servers]\ntealbrick = { command = "a" }\n`,
      `[mcp_servers.tealbrick]\ncommand = "a"\n\n[mcp_servers.tealbrick]\ncommand = "b"\n`,
      `[[mcp_servers.tealbrick]]\ncommand = "a"\n`,
      `mcp_servers.tealbrick.command = "a"\n`,
    ]) {
      await put(codex, text);
      const r = await h.run(["connect", "codex", "--agent", AGT, "--write", "--yes", "--json"]);
      assert.equal(r.code, 8, text);
      assert.equal(await readFile(codex, "utf8"), text);
    }
  });

  it("confirmation: needs --yes without a TTY (exit 2); a TTY answer y writes, n does not", async () => {
    const noTty = await h.run(["connect", "claude-code", "--agent", AGT, "--write", "--json"]);
    assert.equal(noTty.code, 2);
    await assert.rejects(stat(mcpJson));

    h.stdinTty = true;
    h.stdinText = "n\n";
    const no = await h.run(["connect", "claude-code", "--agent", AGT, "--write", "--json"]);
    assert.equal(no.code, 0);
    assert.equal(no.json.written, false);
    await assert.rejects(stat(mcpJson));

    h.stdinText = "y\n";
    const yes = await h.run(["connect", "claude-code", "--agent", AGT, "--write", "--json"]);
    assert.equal(yes.json.written, true);
    assert.ok((await stat(mcpJson)).isFile());
  });

  it("--write is refused where there is no file", async () => {
    assert.equal((await h.run(["connect", "generic", "--agent", AGT, "--write", "--yes", "--json"])).code, 2);
    assert.equal((await h.run(["connect", "claude-desktop", "--bridge", BRIDGE, "--agent", AGT, "--write", "--yes", "--json"])).code, 2);
    assert.equal((await h.run(["connect", "claude-desktop", "--remote", "--local", "--agent", AGT, "--json"])).code, 2);
    assert.equal((await h.run(["connect", "nope", "--json"])).code, 2);
    assert.equal((await h.run(["connect", "claude-code", "--agent", "bad id; rm", "--json"])).code, 2);
  });
});
