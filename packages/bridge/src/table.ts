/**
 * The routing table: everything the bridge derives from one verified workspace config (BRIDGE §5.3).
 * Built off to the side and swapped as one pointer; calls in flight keep the table they started with.
 */
import type { AgentEntry, AppEntry, HookEntry, WorkspaceConfig } from "@opt2-tealbrick/spec/bridge";
import type {
  AgentId,
  BridgeId,
  ConnectionEntry,
  ConnectionId,
  GrantClaims,
  InstanceId,
  PortalKeyEntry,
  Ulid,
  WorkspaceId,
} from "@opt2-tealbrick/spec/credentials";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { KeySet, ManifestApi, OperationView, TrustContext } from "./api.ts";
import { isRefusal } from "./api.ts";

export interface AppRuntime {
  entry: AppEntry;
  manifest: Manifest | undefined;
  /** op id → view (manifest ops + standard ops) */
  ops: Map<string, OperationView>;
  scopeTypes: string[];
  /** manifest could not be fetched or did not match its digest */
  down: boolean;
  /** internalUrl outside the allow-list (BSD-07): never contacted, never recovered by the manifest retry */
  refused?: boolean;
}

export interface GrantRef {
  token: string;
  claims: GrantClaims;
}

export interface Rejection {
  kind: "config" | "grant" | "slice" | "assertion" | "ticket" | "pairing" | "claim";
  code: string;
  /** log only (never in the status report): e.g. the verifier's reason, never a token */
  detail?: string;
}

export interface Table {
  config: WorkspaceConfig;
  jws: string;
  rev: number;
  exp: number;
  ws: WorkspaceId;
  bridgeId: BridgeId;
  /** keys trusted for Portal-signed kinds (or the standalone issuer) */
  issuers: KeySet;
  /** this bridge's own key, as apps see it */
  bridgeKeys: KeySet;
  agents: Map<AgentId, AgentEntry>;
  connections: Map<ConnectionId, ConnectionEntry>;
  apps: Map<InstanceId, AppRuntime>;
  appsByProduct: Map<string, AppRuntime>;
  /** `${sub}|${aud}` → grant */
  grants: Map<string, GrantRef>;
  /** `${ins}|${svc ?? ""}` → kid set */
  instanceKeys: Map<string, KeySet>;
  hooks: HookEntry[];
  revokedJtis: Set<Ulid>;
  pausedAgents: Set<AgentId>;
  pausedInstances: Set<InstanceId>;
  pausedWorkspace: boolean;
  standalone: boolean;
}

/** Reads a compact JWS payload for indexing only; every use of a grant re-verifies it with `verifyGrant`. */
export function peekClaims<C>(token: string): C | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as C;
  } catch {
    return undefined;
  }
}

export const grantKey = (sub: string, aud: string): string => `${sub}|${aud}`;
export const insRef = (ins: InstanceId): `tb:ins:${InstanceId}` => `tb:ins:${ins}`;
export const agtRef = (agt: AgentId): `tb:agt:${AgentId}` => `tb:agt:${agt}`;

export function trustFor(t: Table, target: InstanceId, now: number): TrustContext {
  return { now, self: insRef(target), ws: t.ws, bridge: t.bridgeId, issuers: t.issuers, bridgeKeys: t.bridgeKeys, revokedJtis: t.revokedJtis };
}

export function portalKeySet(api: ManifestApi, entries: PortalKeyEntry[]): KeySet {
  const set = api.keySetFrom({ keys: entries.map((e) => e.jwk) }, "tb:portal");
  const status = new Map(entries.map((e) => [api.thumbprint(e.jwk), e.status]));
  return { keys: set.keys.map((k) => ({ ...k, status: status.get(api.thumbprint(k.jwk)) ?? k.status })) };
}

/**
 * BSD-07 (BRIDGE §5.7): where the bridge may send app traffic (tool inputs, grants, call proofs, hook envelopes,
 * owner UI). `http://<name>.railway.internal:<port>`, or — only for an entry with `ownInfra: true` — an origin in
 * the owner-set TB_OWN_INFRA_ORIGINS. The rule is manifest's `isPrivateInternalUrl` (one implementation).
 */
export function internalUrlAllowed(api: ManifestApi, url: string, ownInfra: boolean, ownInfraOrigins: readonly string[]): boolean {
  return api.isPrivateInternalUrl(url, { ownInfra, allowList: ownInfraOrigins });
}

export interface BuildInput {
  api: ManifestApi;
  config: WorkspaceConfig;
  jws: string;
  bridgeId: BridgeId;
  ownKeys: KeySet;
  issuers: KeySet;
  /** previous table: manifests by digest are reused */
  previous: Table | undefined;
  fetchManifest: (app: AppEntry) => Promise<Manifest>;
  /** BSD-07 allow-list check for `apps[].internalUrl` (refused apps are marked down and reported) */
  internalUrlAllowed?: (entry: AppEntry) => boolean;
  onManifestFailure?: (app: AppEntry, e: unknown) => void;
  now: number;
  reject: (r: Rejection) => void;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function buildTable(input: BuildInput): Promise<Table> {
  const { api, config, now } = input;
  const prevByDigest = new Map<string, Manifest>();
  for (const a of input.previous?.apps.values() ?? []) if (a.manifest) prevByDigest.set(a.entry.manifestDigest, a.manifest);

  const runtimes = await mapLimit(config.apps, 4, async (entry): Promise<AppRuntime> => {
    if (input.internalUrlAllowed && !input.internalUrlAllowed(entry)) {
      input.reject({ kind: "config", code: "internal_url_refused", detail: `ins ${entry.ins}` });
      return { entry, manifest: undefined, ops: new Map(), scopeTypes: [], down: true, refused: true };
    }
    let manifest = prevByDigest.get(entry.manifestDigest);
    let down = false;
    if (!manifest) {
      try {
        const m = await input.fetchManifest(entry);
        const got = api.manifestDigest(m);
        if (got !== entry.manifestDigest) throw Object.assign(new Error("manifest_mismatch"), { served: got });
        manifest = m;
      } catch (e) {
        down = true;
        input.onManifestFailure?.(entry, e);
      }
    }
    const ops = new Map<string, OperationView>();
    if (manifest) for (const op of api.withStandardOps(manifest)) ops.set(op.id, op);
    return { entry, manifest, ops, scopeTypes: (manifest?.scopes ?? []).map((s) => s.type), down };
  });

  const apps = new Map<InstanceId, AppRuntime>();
  const appsByProduct = new Map<string, AppRuntime>();
  for (const r of runtimes) {
    apps.set(r.entry.ins, r);
    appsByProduct.set(r.entry.product, r);
  }

  const revokedJtis = new Set<Ulid>(config.revoked.jtis.filter((j) => j.exp + 30 > now).map((j) => j.jti));
  const partial: Table = {
    config,
    jws: input.jws,
    rev: config.rev,
    exp: config.exp,
    ws: config.ws,
    bridgeId: input.bridgeId,
    issuers: input.issuers,
    bridgeKeys: input.ownKeys,
    agents: new Map(config.agents.map((a) => [a.agt, a])),
    connections: new Map(config.connections.map((c) => [c.con, c])),
    apps,
    appsByProduct,
    grants: new Map(),
    instanceKeys: new Map(),
    hooks: [...config.hooks].sort((a, b) => (a.phase === b.phase ? a.order - b.order || a.product.localeCompare(b.product) : 0)),
    revokedJtis,
    pausedAgents: new Set(config.pause.agents),
    pausedInstances: new Set(config.pause.instances),
    pausedWorkspace: config.pause.workspace,
    standalone: !!config.standalone,
  };

  for (const token of config.grants) {
    const peek = peekClaims<GrantClaims>(token);
    const target = peek?.aud?.startsWith("tb:ins:") ? (peek.aud.slice(7) as InstanceId) : undefined;
    const v = target ? api.verifyGrant(token, trustFor(partial, target, now)) : undefined;
    if (!v || isRefusal(v)) {
      input.reject({ kind: "grant", code: v && isRefusal(v) ? v.code : "grant_invalid" });
      continue;
    }
    partial.grants.set(grantKey(v.claims.sub, v.claims.aud), { token, claims: v.claims });
  }

  for (const k of config.instanceKeys) {
    const key = `${k.ins}|${k.svc ?? ""}`;
    partial.instanceKeys.set(key, api.keySetFrom({ keys: [k.jwk] }, insRef(k.ins)));
  }
  return partial;
}

/** Pause decision inputs for `gate()` step 1 (CREDENTIALS §13). */
export function pauseFor(t: Table, agent: AgentId | undefined, con: ConnectionId | undefined, target: InstanceId) {
  const c = con ? t.connections.get(con) : undefined;
  return {
    workspace: t.pausedWorkspace,
    agent: agent ? t.pausedAgents.has(agent) : false,
    connection: con ? !!c && c.status !== "active" : false,
    instance: t.pausedInstances.has(target),
  };
}
