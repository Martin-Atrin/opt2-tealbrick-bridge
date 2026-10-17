/**
 * @opt2-tealbrick/bridge — the workspace's one door (BRIDGE.md): the deployed form (gate, hooks, routing, MCP,
 * OAuth AS, key store). The agent side (stdio relay, MCP client, manifest binding, protocol constants) lives in
 * `@opt2-tealbrick/relay`, which this package imports (private → public only).
 *
 * Does: verify callers, gate every routed call, run the hook chain, route to apps on the private
 * network, serve MCP, person launch, the key-entry page and health.
 * Does NOT: run agents, call models, hold app data, store holds or receipts (apps do), count caps,
 * send tool payloads to Portal, or accept inbound connections from Portal.
 */
export { redact } from "./calls.ts";
export type { BridgeContext } from "./context.ts";
export { BRIDGE_VERSION, DRAIN_RETRY_AFTER_S } from "./context.ts";
export { type BridgeServerOptions, DRAIN_BOUND_MS, enrolBridge, onStopSignals, ownInfraEnv, type RunningBridge, startBridge } from "./server.ts";
export { jsonLogger, type Logger, silentLogger } from "./util.ts";

/** The one form this package has (the relay form lives in `@opt2-tealbrick/relay`). */
export type BridgeForm = "deployed";
export { dropPrivileges, loadManifestApi, PrivilegeDropError, RUN_GID, RUN_UID } from "./manifest-adapter.ts";
