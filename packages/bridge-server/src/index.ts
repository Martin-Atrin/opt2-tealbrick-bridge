/**
 * Deployed bridge: thin entry around the bridge core for the workspace private network.
 * Owns process wiring only (env, volume paths, health, graceful shutdown); no logic of its own.
 */
export const role = 'bridge-server';
