/**
 * Bridge core: the workspace's one door.
 *
 * Does: verify callers, check grants, run the hook chain, route calls to apps on the
 * private network, serve MCP, person launch, the key-entry page and health.
 * Does NOT: run agents, call models, hold app data, store holds or receipts (apps do),
 * relay tool traffic to Portal, or accept inbound connections from Portal.
 *
 * Interfaces come from the frozen specs (coordination/specs/BRIDGE.md, CREDENTIALS.md).
 * Nothing is implemented before the freeze.
 */
export const role = 'bridge-core';

/** Two forms of the same package (DECISION-LOG C5). */
export type BridgeForm = 'deployed' | 'relay';
