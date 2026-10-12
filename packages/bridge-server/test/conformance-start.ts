/**
 * Conformance harness entry ONLY (CONFORMANCE §7, `tb-conformance bridge --start <this> --test-roots`). Starts the
 * BUILT bridge (`@opt2-tealbrick/bridge` → dist) like bridge-server does, and passes the suite's test roots
 * (`TBCONF_PORTAL_ROOT_KEYS`, a harness-only name) to the programmatic `portalRootKeys` start option so the B20
 * key-set checks run. The production entry (src/server.ts) never reads that name and never passes the option.
 * BRIDGE_CONF_KEYSET_REQUIRED=1 (set by scripts/conformance.ts for the --keyset-required pass, harness-only) runs the
 * spec 0.1.12 strict rule through the `keysetRequired` start option; the released build keeps KEYSET_REQUIRED=false
 * until spec 0.1.12 (Core does not emit statements yet).
 * Not shipped: the image and the package contain dist/ only.
 */
import type { AddressInfo } from "node:net";
import { jsonLogger, loadManifestApi, startBridge } from "@opt2-tealbrick/bridge";
import type { Ed25519PublicJwk } from "@opt2-tealbrick/spec/credentials";

export default async function start(env: Record<string, string>): Promise<{ publicUrl: string; internalUrl: string; stop(): Promise<void> }> {
  const roots = env.TBCONF_PORTAL_ROOT_KEYS ? (JSON.parse(env.TBCONF_PORTAL_ROOT_KEYS) as Ed25519PublicJwk[]) : undefined;
  const running = await startBridge({ api: await loadManifestApi(), env: { ...process.env, ...env }, logger: jsonLogger(), ...(roots ? { portalRootKeys: roots } : {}), ...(process.env.BRIDGE_CONF_KEYSET_REQUIRED === "1" ? { keysetRequired: true } : {}) });
  const port = (s: { address(): unknown }) => (s.address() as AddressInfo).port;
  return {
    publicUrl: `http://127.0.0.1:${port(running.publicServer)}`,
    internalUrl: `http://127.0.0.1:${port(running.internalServer)}`,
    stop: () => running.stop(),
  };
}
