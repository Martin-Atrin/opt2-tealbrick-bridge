import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Io } from "../src/cli.ts";
import { run } from "../src/cli.ts";
import type { CredentialStore } from "../src/store.ts";

/** Test fixtures: a fake Portal on loopback, a file-backed fake keychain, and an IO harness for `run`. */

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: any;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = (req: RecordedRequest) => FakeReply | Promise<FakeReply>;

export class FakePortal {
  server: Server;
  origin = "";
  requests: RecordedRequest[] = [];
  #routes: { method: string; re: RegExp; keys: string[]; fn: Handler }[] = [];

  constructor() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://x");
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      this.requests.push(recorded);
      const route = this.#routes.find((r) => r.method === recorded.method && r.re.test(recorded.path));
      let reply: FakeReply = { status: 404, body: { error: { code: "not_found", message: "no such route", requestId: "req_fake" } } };
      if (route) reply = await route.fn(recorded);
      res.statusCode = reply.status ?? 200;
      res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
  }

  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const addr = this.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    this.origin = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Register `METHOD /api/v1/<path>`; `{x}` matches one path segment. */
  on(method: string, path: string, fn: Handler): void {
    const keys: string[] = [];
    const re = new RegExp(`^/api/v1${path.replace(/\{(\w+)\}/g, (_m, k: string) => { keys.push(k); return "([^/]+)"; })}$`);
    this.#routes.unshift({ method, re, keys, fn });
  }

  calls(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === `/api/v1${path}`);
  }
}

export function apiError(status: number, code: string, message = code): FakeReply {
  return { status, body: { error: { code, message, requestId: "req_fake" } } };
}

/** File-backed fake keychain (never touches the real one). Records every item name that was read. */
export class FakeKeychain implements CredentialStore {
  readonly kind = "keychain" as const;
  reads: string[] = [];
  #file: string;
  constructor(file: string) {
    this.#file = file;
  }
  async #load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.#file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  async list(): Promise<string[]> {
    return Object.keys(await this.#load()).sort();
  }
  async get(name: string): Promise<string | null> {
    this.reads.push(name);
    return (await this.#load())[name] ?? null;
  }
  async put(name: string, value: string): Promise<void> {
    const all = await this.#load();
    all[name] = value;
    await writeFile(this.#file, JSON.stringify(all));
  }
  async delete(name: string): Promise<boolean> {
    const all = await this.#load();
    const had = name in all;
    delete all[name];
    await writeFile(this.#file, JSON.stringify(all));
    return had;
  }
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
  json: any;
}

export class Harness {
  dir = "";
  home = "";
  cwd = "";
  portal = new FakePortal();
  store!: FakeKeychain;
  sleeps: number[] = [];
  clock = Date.parse("2026-10-11T12:00:00Z");
  env: Record<string, string | undefined> = {};
  platform = "darwin";
  stdinTty = false;
  stdinText = "";
  opened: string[] = [];
  /** false: let the CLI build its real store from env (used for TB_CREDENTIAL_STORE=file). */
  injectStore = true;

  async setup(): Promise<void> {
    this.dir = await mkdtemp(join(tmpdir(), "tb-cli-test-"));
    this.home = join(this.dir, "home");
    this.cwd = join(this.dir, "cwd");
    await mkdir(this.home, { recursive: true });
    await mkdir(this.cwd, { recursive: true });
    this.store = new FakeKeychain(join(this.dir, "keychain.json"));
    await this.portal.start();
    this.env = {
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, ".config"),
      TB_PORTAL_URL: this.portal.origin,
    };
  }

  async teardown(): Promise<void> {
    await this.portal.stop();
    await rm(this.dir, { recursive: true, force: true });
  }

  /** Put a signed-in person item in the fake keychain. */
  async signIn(token = "tbo_testtoken0123456789"): Promise<void> {
    await this.store.put(
      "tealbrick.person",
      JSON.stringify({ v: 1, kind: "person", token, sessionId: "osn_01TEST", portal: this.portal.origin, expiresAt: "2099-01-01T00:00:00.000Z" }),
    );
    this.store.reads = [];
  }

  async run(argv: string[], opts: { fetch?: typeof fetch } = {}): Promise<RunResult> {
    let out = "";
    let err = "";
    const stdin = new PassThrough();
    (stdin as any).isTTY = this.stdinTty;
    if (this.stdinText) stdin.end(this.stdinText);
    const io: Io = {
      stdout: { write: (c: string) => { out += c; return true; } },
      stderr: { write: (c: string) => { err += c; return true; } },
      stdin: stdin as any,
      env: this.env,
      fetch: opts.fetch ?? globalThis.fetch,
      ...(this.injectStore ? { store: this.store } : {}),
      sleep: async (ms) => {
        this.sleeps.push(ms);
        this.clock += ms;
      },
      now: () => this.clock,
      cwd: this.cwd,
      platform: this.platform,
      hostname: "test-host",
      openUrl: async (u) => {
        this.opened.push(u);
      },
    };
    const code = await run(argv, io);
    let json: any;
    if (argv.includes("--json")) {
      const lines = out.trim().split("\n").filter(Boolean);
      if (lines.length !== 1) throw new Error(`--json must print exactly one value, got ${lines.length}: ${out}`);
      json = JSON.parse(lines[0] as string);
    }
    return { code, out, err, json };
  }
}
