import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dropRoot, type PrivilegeProcess } from "../src/server.ts";

function fakeProc(start: number, opts: { stuck?: boolean } = {}): PrivilegeProcess & { calls: string[] } {
  let uid = start;
  let gid = start;
  const calls: string[] = [];
  return {
    calls,
    getuid: () => uid,
    getgid: () => gid,
    setgroups: (g) => void calls.push(`setgroups:${g.join(",")}`),
    setgid: (id) => {
      calls.push(`setgid:${id}`);
      if (!opts.stuck) gid = id;
    },
    setuid: (id) => {
      calls.push(`setuid:${id}`);
      if (!opts.stuck) uid = id;
    },
    chown: (p, u, g) => void calls.push(`chown:${p.endsWith("bridge") ? "bridge" : "data"}:${u}:${g}`),
  };
}

test("BSD-04: root drops to 1000:1000 after chowning the data dir, before anything else", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-priv-"));
  try {
    const p = fakeProc(0);
    assert.equal(dropRoot({ TB_DATA_DIR: dir }, p), true);
    assert.equal(p.getuid?.(), 1000);
    assert.ok(p.calls.some((c) => c.startsWith("chown:data:1000:1000")));
    const order = p.calls.filter((c) => !c.startsWith("chown")).join(" ");
    assert.equal(order, "setgroups: setgid:1000 setuid:1000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BSD-04: a non-root start is left alone", () => {
  const p = fakeProc(1000);
  assert.equal(dropRoot({ TB_DATA_DIR: "/nonexistent-tb" }, p), false);
  assert.deepEqual(p.calls, []);
});

test("BSD-04: refuses to keep running as root when the drop does not take", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-priv-"));
  try {
    assert.throws(() => dropRoot({ TB_DATA_DIR: dir }, fakeProc(0, { stuck: true })), /privilege|root|uid\/gid 1000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BSD-04: TB_DATA_DIR is required", () => {
  assert.throws(() => dropRoot({}, fakeProc(0)), /TB_DATA_DIR/);
});
