/** Versions reported by `tealbrick --version --json` ({cli, bridge, spec}). */
export const CLI_VERSION = "0.1.17";
export { BRIDGE_VERSION } from "@opt2-tealbrick/bridge";

/**
 * Build-time Portal origin of this release. Empty until a release fixes it: the CLI then
 * requires --portal or TB_PORTAL_URL (CLI.md section 2).
 */
export const BUILD_PORTAL_ORIGIN = "";

/** Device flow client id of this binary (DeviceStartOwnerInput.client_id). */
export const CLIENT_ID = "tealbrick-cli" as const;
