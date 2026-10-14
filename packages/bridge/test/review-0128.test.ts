/**
 * Bridge 0.1.28:
 *  - Key page (C171, L3/L15/L18/L34): a pasted value loses only its surrounding whitespace; every refused save is
 *    one `bridge.keys.save_refused {app, keyName, code}` line (never the value) plus a plain page; a good save logs
 *    `bridge.keys.saved {app, keyName}` and no refusal line.
 *  - TB_PUBLIC_HOST (C171): the public listener binds it when set; unset = the bind without a host in both forms
 *    (unchanged); `bridge.listening` names the bound public address.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { publicListenHost } from "../src/server.ts";
import { BRG, makeWorld, type World, WS } from "./support/world.ts";

const now = () => Math.floor(Date.now() / 1000);
type Line = { level: string; e: string; f: Record<string, unknown> };
const capture = (lines: Line[]) => {
  const at = (level: string) => (e: string, f?: Record<string, unknown>) => void lines.push({ level, e, f: f ?? {} });
  return { info: at("info"), warn: at("warn"), error: at("error") };
};
const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe("key page: trimmed values, refusals logged and shown (C171)", () => {
  let w: World;
  const lines: Line[] = [];
  let cookie = "";
  let csrf = "";
  before(async () => {
    w = await makeWorld({ real: true, logger: capture(lines) });
    const ticket = await w.signPortal("tb-ticket+jwt", { iss: "tb:portal", sub: "tb:per:per_01HPPPPPPPPPPPPPPPPPPPPPPP", aud: `tb:brg:${BRG}`, iat: now(), exp: now() + 120, jti: w.api.ulid(), ws: WS, pur: "keys" });
    const open = await fetch(`${w.keysUrl}/keys`, { method: "POST", headers: FORM, body: new URLSearchParams({ ticket }), redirect: "manual" });
    assert.equal(open.status, 200);
    cookie = String(open.headers.get("set-cookie")).split(";")[0] as string;
    csrf = /name="csrf" value="([^"]+)"/.exec(await open.text())?.[1] as string;
    assert.ok(csrf);
  });
  after(async () => {
    await w.close();
  });

  const save = (fields: Record<string, string>, withCookie = true) =>
    fetch(`${w.keysUrl}/keys`, { method: "POST", headers: { ...FORM, ...(withCookie ? { cookie } : {}) }, body: new URLSearchParams(fields), redirect: "manual" });
  const refusals = () => lines.filter((l) => l.e === "bridge.keys.save_refused");
  const stored = () => w.bridge.ctx.state.keyStore.values.NOTES_API_KEY;

  test("a pasted value with a trailing newline is saved trimmed; inner characters stay", async () => {
    const r = await save({ csrf, name: "NOTES_API_KEY", value: "sk-test-trailing\n" });
    assert.equal(r.status, 303);
    assert.equal(stored(), "sk-test-trailing");
    const inner = await save({ csrf, name: "NOTES_API_KEY", value: " \t sk-a b\tc==\r\n" });
    assert.equal(inner.status, 303);
    assert.equal(stored(), "sk-a b\tc==", "only the surrounding whitespace goes");
  });

  test("quiet case: a good save logs bridge.keys.saved {app, keyName} and no refusal (L34)", async () => {
    const before = refusals().length;
    const r = await save({ csrf, name: "NOTES_API_KEY", value: "sk-good-save-QUIET" });
    assert.equal(r.status, 303);
    assert.equal(refusals().length, before, "no save_refused on a good save");
    const saved = lines.filter((l) => l.e === "bridge.keys.saved").at(-1);
    assert.deepEqual({ app: saved?.f.app, keyName: saved?.f.keyName }, { app: "notes", keyName: "NOTES_API_KEY" });
    assert.ok(!JSON.stringify(lines).includes("sk-good-save-QUIET"), "the value is never logged");
  });

  const SECRET = "sk-REFUSED-value-never-logged";
  const cases: { code: string; status: number; send: () => Promise<Response>; keyName: string | null; app: string | null }[] = [
    { code: "empty_value", status: 400, keyName: "NOTES_API_KEY", app: "notes", send: () => save({ csrf, name: "NOTES_API_KEY", value: " \r\n\t " }) },
    { code: "ticket_invalid", status: 401, keyName: null, app: null, send: () => save({ ticket: "x.y.z", value: SECRET }, false) },
    { code: "page_expired", status: 401, keyName: "NOTES_API_KEY", app: "notes", send: () => save({ csrf, name: "NOTES_API_KEY", value: SECRET }, false) },
    { code: "csrf_invalid", status: 403, keyName: "NOTES_API_KEY", app: "notes", send: () => save({ csrf: "wrong", name: "NOTES_API_KEY", value: SECRET }) },
    { code: "unknown_key", status: 400, keyName: "OTHER_KEY", app: null, send: () => save({ csrf, name: "OTHER_KEY", value: SECRET }) },
    { code: "too_large", status: 400, keyName: "NOTES_API_KEY", app: "notes", send: () => save({ csrf, name: "NOTES_API_KEY", value: `${SECRET}${"x".repeat(17 * 1024)}` }) },
    { code: "too_large", status: 413, keyName: null, app: null, send: () => save({ csrf, name: "NOTES_API_KEY", value: `${SECRET}${"x".repeat(21 * 1024)}` }) },
  ];
  for (const c of cases) {
    test(`refused save (${c.code}, ${c.status}): one save_refused line without the value + a plain page`, async () => {
      const keep = stored();
      const n = refusals().length;
      const res = await c.send();
      assert.equal(res.status, c.status);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, "a page, never raw JSON (L18)");
      const page = await res.text();
      assert.ok(page.includes("not saved") || page.includes("expired"), "the page says the key was not saved");
      assert.ok(!page.includes(SECRET), "the page never shows the value");
      const added = refusals().slice(n);
      assert.equal(added.length, 1, "exactly one refusal line");
      assert.deepEqual(added[0]?.f, { app: c.app, keyName: c.keyName, code: c.code });
      assert.ok(!JSON.stringify(lines).includes(SECRET), "no value in any log line (L15)");
      assert.equal(stored(), keep, "nothing changed");
    });
  }

  test("a key name that does not look like a name is never logged as given", async () => {
    const n = refusals().length;
    const res = await save({ csrf, name: SECRET, value: "x" });
    assert.equal(res.status, 400);
    assert.equal(refusals().slice(n)[0]?.f.keyName, "(invalid)");
    assert.ok(!JSON.stringify(lines).includes(SECRET));
  });
});

describe("public listener address (TB_PUBLIC_HOST, C171)", () => {
  const bound = (w: World) => (w.bridge.publicServer.address() as AddressInfo).address;
  const listening = (lines: Line[]) => lines.find((l) => l.e === "bridge.listening")?.f;

  test("publicListenHost: set wins (trimmed), unset or empty = no host", () => {
    assert.equal(publicListenHost({}), undefined);
    assert.equal(publicListenHost({ TB_PUBLIC_HOST: "" }), undefined);
    assert.equal(publicListenHost({ TB_PUBLIC_HOST: " 127.0.0.1 " }), "127.0.0.1");
  });

  for (const form of ["deployed", "own_infra"] as const) {
    test(`${form}, TB_PUBLIC_HOST unset: the bind without a host (wildcard, unchanged), reachable on 127.0.0.1, logged`, async () => {
      const lines: Line[] = [];
      const w = await makeWorld({ real: true, form, formDefaultHosts: true, logger: capture(lines) });
      try {
        assert.ok(["::", "0.0.0.0"].includes(bound(w)), `wildcard bind, got ${bound(w)}`);
        assert.equal(listening(lines)?.publicHost, bound(w), "bridge.listening names the bound public address");
        assert.equal((await fetch(`${w.publicUrl}/healthz`)).status, 200);
      } finally {
        await w.close();
      }
    });

    test(`${form}, TB_PUBLIC_HOST=127.0.0.1: bound to exactly that address, logged`, async () => {
      const lines: Line[] = [];
      const w = await makeWorld({ real: true, form, formDefaultHosts: true, env: { TB_PUBLIC_HOST: "127.0.0.1" }, logger: capture(lines) });
      try {
        assert.equal(bound(w), "127.0.0.1");
        assert.equal(listening(lines)?.publicHost, "127.0.0.1");
        assert.equal((await fetch(`${w.publicUrl}/healthz`)).status, 200);
      } finally {
        await w.close();
      }
    });
  }

  test("the shared test world binds both listeners to 127.0.0.1 (no shadowing by another program)", async () => {
    const w = await makeWorld({ real: true });
    try {
      assert.equal(bound(w), "127.0.0.1");
      assert.equal((w.bridge.internalServer.address() as AddressInfo).address, "127.0.0.1");
    } finally {
      await w.close();
    }
  });
});
