/**
 * Bridge 0.2.1 (LA-1): the deployed entry's two roles. `TB_ROLE=views` starts the views service; a views service that holds
 * any bridge env exits non-zero with a clear message (names only). REAL process (the entry file itself), same wiring as the image.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dropViewsRoot, type PrivilegeProcess, roleOf } from "../src/server.ts";

const ENTRY = resolve(fileURLToPath(new URL("../src/server.ts", import.meta.url)));
const KEY = randomBytes(32).toString("base64url");

function run(env: Record<string, string>): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("exit", (code) => resolveRun({ code, stderr, stdout }));
  });
}

test("TB_ROLE: unset or bridge is the bridge, views is the views service, anything else is refused", () => {
  assert.equal(roleOf({}), "bridge");
  assert.equal(roleOf({ TB_ROLE: "" }), "bridge");
  assert.equal(roleOf({ TB_ROLE: "bridge" }), "bridge");
  assert.equal(roleOf({ TB_ROLE: "views" }), "views");
  assert.equal(roleOf({ TB_ROLE: " views " }), "views", "surrounding blanks are not part of the name");
  for (const bad of ["View", "admin", "relay"]) assert.throws(() => roleOf({ TB_ROLE: bad }), /TB_ROLE/, bad);
});

test("a views service started as root drops to 1000 over an empty scratch dir, and never keeps root; not root → nothing", () => {
  let uid = 0;
  let gid = 0;
  const calls: string[] = [];
  const proc = (stuck = false): PrivilegeProcess => ({
    getuid: () => uid,
    getgid: () => gid,
    setgroups: () => void calls.push("setgroups"),
    setgid: (id) => {
      calls.push(`setgid:${id}`);
      if (!stuck) gid = id;
    },
    setuid: (id) => {
      calls.push(`setuid:${id}`);
      if (!stuck) uid = id;
    },
    chown: (p, u, g) => void calls.push(`chown:${/tb-views-/.test(p) ? "scratch" : "other"}:${u}:${g}`),
  });
  assert.equal(dropViewsRoot(proc()), true);
  assert.deepEqual(calls, ["chown:scratch:1000:1000", "setgroups", "setgid:1000", "setuid:1000"], "only the empty scratch dir is chowned");
  calls.length = 0;
  assert.equal(dropViewsRoot(proc()), false, "already 1000: nothing to do");
  assert.deepEqual(calls, []);
  uid = 0;
  gid = 0;
  assert.throws(() => dropViewsRoot(proc(true)), /uid|root/, "a drop that does not take is an error");
});

test("TB_ROLE=views with TB_ENROL_CODE, TB_KEK or TB_PORTAL_URL exits non-zero and says which variable (never the value or the key)", async () => {
  for (const name of ["TB_ENROL_CODE", "TB_KEK", "TB_PORTAL_URL"]) {
    const secret = `value-of-${name}-1234567890`;
    const r = await run({ TB_ROLE: "views", TB_VIEWS_UPSTREAM: "http://127.0.0.1:9", TB_VIEWS_KEY: KEY, PORT: "0", [name]: secret });
    assert.notEqual(r.code, 0, name);
    assert.match(r.stderr, new RegExp(name), name);
    assert.ok(!r.stderr.includes(secret) && !r.stderr.includes(KEY), "no value in the output");
  }
});

test("TB_ROLE=views without TB_VIEWS_UPSTREAM or TB_VIEWS_KEY exits non-zero; an unknown TB_ROLE too", async () => {
  const noUp = await run({ TB_ROLE: "views", TB_VIEWS_KEY: KEY, PORT: "0" });
  assert.notEqual(noUp.code, 0);
  assert.match(noUp.stderr, /TB_VIEWS_UPSTREAM/);
  const noKey = await run({ TB_ROLE: "views", TB_VIEWS_UPSTREAM: "http://127.0.0.1:9", PORT: "0" });
  assert.notEqual(noKey.code, 0);
  assert.match(noKey.stderr, /TB_VIEWS_KEY/);
  const odd = await run({ TB_ROLE: "nonsense" });
  assert.notEqual(odd.code, 0);
  assert.match(odd.stderr, /TB_ROLE/);
});

test("TB_ROLE=views with a good env serves /healthz and forwards /v/* with the key; SIGTERM drains and exits 0", async () => {
  let seen: { url?: string; key?: string } = {};
  const up = createServer((req, res) => {
    seen = { url: req.url, key: req.headers["tb-views-key"] as string | undefined };
    res.writeHead(200, { "content-type": "text/plain" }).end("from the bridge");
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const upstream = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;
  const child: ChildProcess = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH ?? "", TB_ROLE: "views", TB_VIEWS_UPSTREAM: upstream, TB_VIEWS_KEY: KEY, PORT: "0" }, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      const t = setTimeout(() => reject(new Error(`views did not start: ${log}`)), 15_000);
      const poll = setInterval(() => {
        const m = /"event":"views\.listening","port":(\d+)/.exec(log);
        if (m) {
          clearInterval(poll);
          clearTimeout(t);
          resolvePort(Number(m[1]));
        }
      }, 25);
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    const page = await fetch(`http://127.0.0.1:${port}/v/notes/tok?a=1`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "from the bridge");
    assert.equal(seen.url, "/tb/v1/views/notes/tok?a=1");
    assert.equal(seen.key, KEY);
    assert.ok(!log.includes(KEY) && !log.includes("tok"), "neither the key nor the viewer path is logged");
    child.kill("SIGTERM");
    assert.equal(await exited, 0, "SIGTERM drains and exits 0");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    up.closeAllConnections();
    await new Promise((r) => up.close(r));
  }
});
