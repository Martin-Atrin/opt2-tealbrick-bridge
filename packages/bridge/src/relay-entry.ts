/**
 * Lean entry for the local relay (`@opt2-tealbrick/bridge/relay`): only the relay and the manifest binding,
 * without the deployed bridge (server, OAuth AS, MCP server, routing). Keeps the relay process small.
 */
export { manifestApi } from "./manifest-adapter.ts";
export { type RelayOptions, type RelaySigner, type RelayStatus, type RunningRelay, startRelay } from "./relay.ts";
