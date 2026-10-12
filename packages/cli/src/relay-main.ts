/**
 * `tealbrick bridge serve --stdio` (C5, CLI.md §5): the local relay, loaded WITHOUT the rest of the CLI and
 * without the deployed bridge, so the relay process stays small. Reads agent items only (never the person item).
 */
import { manifestApi, type RelayStatus, startRelay } from "@opt2-tealbrick/bridge/relay";
import type { AgentId, BridgeId, ConnectionId, Ed25519PublicJwk } from "@opt2-tealbrick/spec/credentials";
import { CliError, EXIT, usageError } from "./io.ts";
import { type CredentialStore, isAgentItem, relayStore } from "./store.ts";

/** One key connection on this machine: item `tealbrick.agent.<con>` (K4 + bridge endpoints). */
export interface AgentItem {
  v: 1;
  kind: "agent";
  con: ConnectionId;
  agt: AgentId;
  ws: string;
  bridgeId: BridgeId;
  bridgeUrl: string;
  tokenEndpoint: string;
  harness: string;
  label: string;
  publicJwk: Ed25519PublicJwk;
  /** PKCS#8 of the K4 private key, base64url; only in the OS keychain (or 0600 file store, headless) */
  privateKey: string;
  createdAt: string;
}

export async function readAgentItems(store: CredentialStore): Promise<AgentItem[]> {
  const out: AgentItem[] = [];
  for (const name of await store.list()) {
    if (!isAgentItem(name)) continue;
    const raw = await store.get(name);
    if (!raw) continue;
    try {
      const v = JSON.parse(raw) as AgentItem;
      if (v.kind === "agent" && typeof v.con === "string" && typeof v.privateKey === "string") out.push(v);
    } catch {
      /* not an agent item of ours */
    }
  }
  return out;
}

/** The item for `want` (agent or connection id), or the only one. */
export async function pickAgentItem(store: CredentialStore, want: string | undefined): Promise<AgentItem> {
  const items = await readAgentItems(store);
  const matches = want ? items.filter((i) => i.agt === want || i.con === want) : items;
  if (matches.length === 0) throw new CliError(EXIT.notSignedIn, "unauthenticated", want ? `no agent item for ${want} on this machine; run tealbrick agent login` : "no agent signed in on this machine; run tealbrick agent login");
  if (matches.length > 1) throw usageError("more than one agent item on this machine; pass --agent <agt_…>");
  return matches[0] as AgentItem;
}

export async function serveRelay(opts: { store: CredentialStore; agent: string | undefined; stderr: { write(s: string): unknown } }): Promise<void> {
  const item = await pickAgentItem(opts.store, opts.agent);
  const api = manifestApi();
  const key = await api.importKeyPair(new Uint8Array(Buffer.from(item.privateKey, "base64url")));
  const relay = startRelay({
    api,
    bridgeUrl: item.bridgeUrl,
    connection: { con: item.con, agt: item.agt, bridgeId: item.bridgeId },
    signer: {
      sign: async (input) => Buffer.from(await crypto.subtle.sign("Ed25519", key.privateKey, new TextEncoder().encode(input))).toString("base64url"),
      publicJwk: () => item.publicJwk,
    },
    onStatus: (s: RelayStatus) => opts.stderr.write(`${JSON.stringify({ event: "relay.status", status: s, agent: item.agt })}\n`),
  });
  await relay.done;
}

/**
 * Standalone process entry used by main.ts for `bridge serve`: `[--stdio] [--agent <id>] [--store keychain|file]
 * [--config-dir <dir>]`. `--store`/`--config-dir` carry the credential-store choice when a harness starts the relay with
 * a filtered env (harness-claude drops every TB_* name and XDG_CONFIG_HOME).
 */
export async function relayMain(argv: string[]): Promise<number> {
  const rest = argv.slice(2);
  let agent = process.env.TB_AGENT;
  let stdio = false;
  const storeArgs: { store?: string; configDir?: string } = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--stdio") stdio = true;
    else if (a === "--store") storeArgs.store = rest[++i];
    else if (a === "--config-dir") storeArgs.configDir = rest[++i];
    else if (a === "--agent") agent = rest[++i];
    else if (a?.startsWith("--agent=")) agent = a.slice(8);
    else {
      process.stderr.write(`error: unknown option for bridge serve: ${a}\n`);
      return EXIT.usage;
    }
  }
  if (!stdio) {
    process.stderr.write("error: bridge serve needs --stdio (the relay has no listener)\n");
    return EXIT.usage;
  }
  try {
    await serveRelay({ store: relayStore(process.env, storeArgs), agent, stderr: process.stderr });
    return EXIT.ok;
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError(EXIT.unexpected, "internal", e instanceof Error ? e.message : "unexpected error");
    process.stderr.write(`error: ${err.message}\n`);
    return err.exit;
  }
}
