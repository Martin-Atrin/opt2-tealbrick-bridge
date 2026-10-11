/**
 * @opt2-tealbrick/bridge — the workspace's one door (BRIDGE.md). Two forms of one package:
 * deployed (full: gate, hooks, routing, MCP, OAuth AS, key store) and relay (stdio, identity only).
 *
 * Does: verify callers, gate every routed call, run the hook chain, route to apps on the private
 * network, serve MCP, person launch, the key-entry page and health.
 * Does NOT: run agents, call models, hold app data, store holds or receipts (apps do), count caps,
 * send tool payloads to Portal, or accept inbound connections from Portal.
 */
export type { Kek, ManifestApi } from "./api.ts";
export { redact } from "./calls.ts";
export type { BridgeContext } from "./context.ts";
export { BRIDGE_VERSION, MCP_VERSIONS, SDK_MAJORS } from "./context.ts";
export { type RelayOptions, type RelaySigner, type RelayStatus, type RunningRelay, startRelay } from "./relay.ts";
export { type BridgeServerOptions, enrolBridge, ownInfraEnv, type RunningBridge, startBridge } from "./server.ts";
export { jsonLogger, type Logger, silentLogger } from "./util.ts";

/** Two forms of the same package (DECISION-LOG C5). */
export type BridgeForm = "deployed" | "relay";
export { loadManifestApi, manifestApi } from "./manifest-adapter.ts";
export { connectMcp, type HeldResult, heldOf, type McpClient, type McpTool, type McpToolResult, pollHold, type StdioTarget } from "./mcp-client.ts";
