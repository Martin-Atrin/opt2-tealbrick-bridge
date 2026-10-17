/**
 * The bridge's two server-only bindings of `@opt2-tealbrick/manifest`. The `ManifestApi` binding itself
 * (`manifestApi()`) is owned by `@opt2-tealbrick/relay` (one owner, L1); nothing here re-implements it.
 */
import { type ManifestApi, manifestApi } from "@opt2-tealbrick/relay";

/** Kept for entry points that load lazily. */
export async function loadManifestApi(): Promise<ManifestApi> {
  return manifestApi();
}

/**
 * BSD-04: the SDK's one privilege-drop implementation (manifest `dropPrivileges`), re-exported so the deployed
 * entry drops root before it loads state or listens. Never a second copy here.
 */
export { dropPrivileges, PrivilegeDropError, RUN_GID, RUN_UID } from "@opt2-tealbrick/manifest";
