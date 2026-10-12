import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT } from "./io.ts";

/**
 * Credential store (CLI.md section 2 "Credential store", CREDENTIALS K3 / K4).
 * Items are named `tealbrick.person` (K3) and `tealbrick.agent.<con>` (K4). The value is an
 * opaque string (JSON written by the owning mode). Owner commands only ever touch the person item.
 */
export interface CredentialStore {
  readonly kind: "keychain" | "file" | "memory";
  /** Item names present in this store (metadata only, no secret is read). */
  list(): Promise<string[]>;
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
  /** true when an item was removed. */
  delete(name: string): Promise<boolean>;
}

export const PERSON_ITEM = "tealbrick.person";
export const AGENT_ITEM_PREFIX = "tealbrick.agent.";

export function isAgentItem(name: string): boolean {
  return name.startsWith(AGENT_ITEM_PREFIX) && name.length > AGENT_ITEM_PREFIX.length;
}

const ITEM_NAME = /^tealbrick\.[A-Za-z0-9._-]{1,200}$/;

function checkName(name: string): void {
  if (!ITEM_NAME.test(name)) throw new CliError(EXIT.unexpected, "internal", "invalid credential item name");
}

// ───────────────────────────── macOS keychain (via the `security` tool) ─────────────────────────────

export interface SecurityResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `security <args>` with optional stdin. Injectable so tests never touch the real keychain. */
export type SecurityRunner = (args: string[], stdin?: string) => Promise<SecurityResult>;

export const runSecurity: SecurityRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });

const KEYCHAIN_ACCOUNT = "default";
const SEC_NOT_FOUND = 44;

/**
 * The secret never appears in argv (visible in `ps`): `security -i` reads its commands from stdin.
 * The value is stored as base64url text so no shell or security-parser quoting is needed.
 */
export function buildKeychainAddCommand(name: string, value: string): string {
  checkName(name);
  const b64 = Buffer.from(value, "utf8").toString("base64url");
  return `add-generic-password -U -s ${name} -a ${KEYCHAIN_ACCOUNT} -w ${b64}\n`;
}

export function createKeychainStore(run: SecurityRunner = runSecurity): CredentialStore {
  return {
    kind: "keychain",
    async list() {
      const r = await run(["dump-keychain"]).catch(() => null);
      if (r?.code !== 0) return [];
      const names = new Set<string>();
      for (const m of r.stdout.matchAll(/"svce"<blob>="(tealbrick\.[A-Za-z0-9._-]+)"/g)) {
        if (m[1]) names.add(m[1]);
      }
      return [...names].sort();
    },
    async get(name) {
      checkName(name);
      const r = await run(["find-generic-password", "-s", name, "-a", KEYCHAIN_ACCOUNT, "-w"]);
      if (r.code === SEC_NOT_FOUND) return null;
      if (r.code !== 0) throw new CliError(EXIT.unexpected, "internal", "keychain read failed");
      const text = r.stdout.replace(/\r?\n$/, "");
      try {
        return Buffer.from(text, "base64url").toString("utf8");
      } catch {
        throw new CliError(EXIT.unexpected, "internal", "keychain item is not in the expected encoding");
      }
    },
    async put(name, value) {
      const r = await run(["-i"], buildKeychainAddCommand(name, value));
      if (r.code !== 0) throw new CliError(EXIT.unexpected, "internal", "keychain write failed");
      // `security -i` can exit 0 when the inner command fails: read the item back before trusting the write
      const check = await run(["find-generic-password", "-s", name, "-a", KEYCHAIN_ACCOUNT, "-w"]);
      if (check.code !== 0 || check.stdout.replace(/\r?\n$/, "") !== Buffer.from(value, "utf8").toString("base64url")) {
        throw new CliError(EXIT.unexpected, "internal", "keychain write could not be verified");
      }
    },
    async delete(name) {
      checkName(name);
      const r = await run(["delete-generic-password", "-s", name, "-a", KEYCHAIN_ACCOUNT]);
      if (r.code === SEC_NOT_FOUND) return false;
      if (r.code !== 0) throw new CliError(EXIT.unexpected, "internal", "keychain delete failed");
      return true;
    },
  };
}

/** Platforms without a keychain backend in this build (Windows Credential Manager, Secret Service). */
export function createUnsupportedKeychain(platform: string): CredentialStore {
  const fail = (): never => {
    throw new CliError(
      EXIT.unexpected,
      "internal",
      `no OS keychain backend for ${platform} in this build; agent items can use TB_CREDENTIAL_STORE=file, the person item needs a keychain`,
    );
  };
  return {
    kind: "keychain",
    list: async () => [],
    get: async () => null,
    put: async () => fail(),
    delete: async () => fail(),
  };
}

// ───────────────────────────── file store (agent items only, headless) ─────────────────────────────

export function configDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "tealbrick");
  return join(env.HOME && env.HOME.length > 0 ? env.HOME : homedir(), ".config", "tealbrick");
}

const FILE_ITEM_PREFIX = "agent-";

function fileFor(dir: string, name: string): string {
  if (!isAgentItem(name)) {
    throw new CliError(
      EXIT.notSignedIn,
      "unauthenticated",
      "the person credential requires the OS keychain; the file store holds agent items only",
    );
  }
  checkName(name);
  return join(dir, `${FILE_ITEM_PREFIX}${name.slice(AGENT_ITEM_PREFIX.length)}.json`);
}

/** `$XDG_CONFIG_HOME/tealbrick/agent-<con>.json`, mode 0600. Refuses the person item. */
export function createFileStore(dir: string): CredentialStore {
  return {
    kind: "file",
    async list() {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return [];
      }
      return entries
        .filter((f) => f.startsWith(FILE_ITEM_PREFIX) && f.endsWith(".json"))
        .map((f) => `${AGENT_ITEM_PREFIX}${f.slice(FILE_ITEM_PREFIX.length, -".json".length)}`)
        .sort();
    },
    async get(name) {
      try {
        return await readFile(fileFor(dir, name), "utf8");
      } catch (e) {
        if (e instanceof CliError) throw e;
        return null;
      }
    },
    async put(name, value) {
      const path = fileFor(dir, name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, value, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    },
    async delete(name) {
      const path = fileFor(dir, name);
      try {
        await rm(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createStore(env: Record<string, string | undefined>, platform: string = process.platform): CredentialStore {
  const choice = env.TB_CREDENTIAL_STORE;
  if (choice === "file") return createFileStore(configDir(env));
  if (choice !== undefined && choice !== "" && choice !== "keychain") {
    throw new CliError(EXIT.usage, "bad_request", "TB_CREDENTIAL_STORE must be keychain or file");
  }
  return platform === "darwin" ? createKeychainStore() : createUnsupportedKeychain(platform);
}

/**
 * Arguments that carry THIS process's credential-store choice to a relay it hands to a harness
 * (`tealbrick bridge serve --stdio …`). Harnesses start the relay with a filtered env (harness-claude `sessionEnv`
 * drops every TB_* name and XDG_CONFIG_HOME; desktop apps use their own env), so the choice must travel as argv.
 * Keychain (the default) needs none. The config dir is a path, never a secret.
 */
export function relayStoreArgs(env: Record<string, string | undefined>): string[] {
  return env.TB_CREDENTIAL_STORE === "file" ? ["--store", "file", "--config-dir", configDir(env)] : [];
}

/** The store a relay process uses: `--store`/`--config-dir` from argv win over its (possibly filtered) env. */
export function relayStore(env: Record<string, string | undefined>, args: { store?: string; configDir?: string }, platform: string = process.platform): CredentialStore {
  if (args.store === "file") return createFileStore(args.configDir ?? configDir(env));
  if (args.store === "keychain") return createStore({ TB_CREDENTIAL_STORE: "keychain" }, platform);
  if (args.store !== undefined) throw new CliError(EXIT.usage, "bad_request", "--store must be keychain or file");
  if (args.configDir !== undefined) throw new CliError(EXIT.usage, "bad_request", "--config-dir needs --store file");
  return createStore(env, platform);
}

/** Agent item names on this machine across the keychain and the file store (login warning only). */
export async function listAgentItems(store: CredentialStore, env: Record<string, string | undefined>): Promise<string[]> {
  const names = new Set<string>();
  for (const n of await store.list().catch(() => [])) if (isAgentItem(n)) names.add(n);
  if (store.kind !== "file") {
    for (const n of await createFileStore(configDir(env)).list()) names.add(n);
  }
  return [...names].sort();
}
