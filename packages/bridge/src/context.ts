/**
 * Shared runtime of a deployed (full) bridge: identity, state, current table, status counters and
 * change notifications. One instance per process.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AppStatus, StatusReport } from "@opt2-tealbrick/spec/bridge";
import type { AgentId, InstanceId } from "@opt2-tealbrick/spec/credentials";
import type { KeySet, ManifestApi } from "./api.ts";
import type { BridgeState, Identity } from "./state.ts";
import type { Rejection, Table } from "./table.ts";
import type { Logger } from "./util.ts";
import { nowS } from "./util.ts";

export const BRIDGE_VERSION = "0.1.3";
export const SDK_MAJORS = [1];
export const MCP_VERSIONS = ["2025-06-18", "2025-03-26"];

export interface BridgeOptions {
  api: ManifestApi;
  state: BridgeState;
  logger: Logger;
  portalUrl: string;
  publicUrl: string;
  /** internal listener origin as apps reach it (e.g. http://bridge.railway.internal:8788) */
  internalUrl: string;
  form: "deployed" | "own_infra";
  fetch?: typeof fetch;
}

export interface AppHealth {
  status: AppStatus;
  lastSeen: number;
}

export class BridgeContext extends EventEmitter {
  readonly api: ManifestApi;
  readonly state: BridgeState;
  readonly log: Logger;
  readonly portalUrl: string;
  readonly publicUrl: string;
  readonly internalUrl: string;
  readonly form: "deployed" | "own_infra";
  readonly fetch: typeof fetch;
  readonly boot = randomUUID();
  identity: Identity | undefined;
  table: Table | undefined;
  /** last successful config pull (epoch s) */
  lastPull = 0;
  readonly health = new Map<InstanceId, AppHealth>();
  readonly scopeSummaries = new Map<string, { agt: AgentId; ins: InstanceId; label: string }>();
  readonly rejected = new Map<string, number>();
  readonly toolsOmitted = new Map<string, { ins: InstanceId; name: string; code: "tool_name_too_long" | "name_collision" | "ceiling" }>();
  connectionsRevoked: StatusReport["connectionsRevoked"] = [];

  constructor(o: BridgeOptions) {
    super();
    this.setMaxListeners(0);
    this.api = o.api;
    this.state = o.state;
    this.log = o.logger;
    this.portalUrl = o.portalUrl;
    this.publicUrl = o.publicUrl;
    this.internalUrl = o.internalUrl;
    this.form = o.form;
    this.fetch = o.fetch ?? fetch;
  }

  get bridgeRef(): `tb:brg:brg_${string}` {
    if (!this.identity) throw new Error("not enrolled");
    return `tb:brg:${this.identity.bridgeId}`;
  }

  ownKeySet(): KeySet {
    if (!this.identity) throw new Error("not enrolled");
    return this.api.keySetFrom({ keys: [this.identity.key.publicJwk] }, this.bridgeRef);
  }

  reject(r: Rejection): void {
    const k = `${r.kind}|${r.code}`;
    this.rejected.set(k, (this.rejected.get(k) ?? 0) + 1);
    this.log.warn("bridge.rejected", { kind: r.kind, code: r.code });
  }

  /** Config older than 12 h → agent and app→app calls fail closed (C9). Standalone documents are re-minted. */
  configExpired(now = nowS()): boolean {
    return !this.table || now > this.table.exp;
  }

  portalReachable(now = nowS()): boolean {
    return now - this.lastPull < 120;
  }

  swapTable(next: Table): void {
    const prev = this.table;
    this.table = next;
    this.emit("table", next, prev);
  }
}
