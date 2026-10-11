import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { resolve } from "node:path";
import type { DeviceOwnerTokenResult, DeviceStart, DeviceStartOwnerInput, DeviceTokenInput } from "@opt2-tealbrick/spec/routes";
import type { Ctx, Handler } from "./ctx.ts";
import { requirePos, table } from "./ctx.ts";
import { CliError, EXIT, isRecord, usageError } from "./io.ts";
import type { PortalClient } from "./portal.ts";
import { readPerson, requireKeychain, requireSession, resolveWorkspace, savePerson } from "./session.ts";
import { listAgentItems, PERSON_ITEM } from "./store.ts";
import { CLIENT_ID } from "./version.ts";

/** Owner mode (CLI.md section 3): sign-in, sign-out and the read commands. Drafts live in drafts.ts. */

const MIN_INTERVAL_S = 5;
const SLOW_DOWN_S = 5;
const MAX_POLL_NETWORK_FAILURES = 3;

export async function defaultOpenUrl(url: string, platform: string = process.platform): Promise<void> {
  const [cmd, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  await new Promise<void>((res, rej) => {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", rej);
    child.on("spawn", () => {
      child.unref();
      res();
    });
  });
}

function toInt(raw: string | undefined, what: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw usageError(`${what} must be a positive integer`);
  return n;
}

function pageInput(ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const limit = toInt(ctx.v.limit, "--limit");
  if (limit !== undefined) out.limit = limit;
  if (ctx.v.cursor !== undefined) out.cursor = ctx.v.cursor;
  return out;
}

// ───────────────────────────── login / logout ─────────────────────────────

export const login: Handler = async (ctx) => {
  if (ctx.v.code !== undefined) throw usageError("login takes no code (the owner approves in the browser)");
  requireKeychain(ctx);
  const origin = ctx.portalOrigin();

  const agentItems = await listAgentItems(ctx.store(), ctx.io.env);
  if (agentItems.length > 0) {
    ctx.say(
      `Warning: ${agentItems.length} agent item(s) exist on this machine. Agents on this machine run as the same OS user; the owner session is readable by them through this CLI. Prefer a separate OS user for agents.`,
    );
  }

  const client = ctx.client(origin);
  const startInput: DeviceStartOwnerInput = {
    scope: "owner",
    client_id: CLIENT_ID,
    machine_label: (ctx.v.label ?? ctx.io.hostname ?? osHostname()).slice(0, 64) || "machine",
  };
  const start = await client.call<DeviceStart>("device.start", startInput as unknown as Record<string, unknown>);
  if (typeof start.device_code !== "string" || typeof start.user_code !== "string" || typeof start.verification_uri_complete !== "string") {
    throw new CliError(EXIT.network, "upstream_timeout", "the Portal returned an unexpected device flow response");
  }

  ctx.say(`Open this URL to approve the sign-in:\n  ${start.verification_uri_complete}\nCheck that the code shown there is: ${start.user_code}`);
  ctx.say("Approve only if you started this sign-in. Approving signs a tool in AS YOU: reads and drafts, nothing else.");
  if (ctx.v.open === true) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(start.verification_uri_complete).origin === origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      ctx.say("Not opening the browser: the approval URL is not on the Portal origin.");
    } else {
      try {
        await (ctx.io.openUrl ?? ((u: string) => defaultOpenUrl(u, ctx.platform())))(start.verification_uri_complete);
      } catch {
        ctx.say("Could not open a browser; open the URL yourself.");
      }
    }
  }

  const token = await pollForOwnerToken(ctx, client, start);

  const expiresAt = new Date(ctx.now() + token.expires_in * 1000).toISOString();
  await savePerson(ctx, { v: 1, kind: "person", token: token.access_token, sessionId: token.session_id, portal: origin, expiresAt });
  ctx.say("Signed in. The owner session is in the OS keychain (item tealbrick.person).");
  ctx.say("Run agents under a separate OS user: any process of your OS user can use this session (reads and drafts only).");
  ctx.emit(
    { signedIn: true, sessionId: token.session_id, portal: origin, expiresAt },
    `signed in (session ${token.session_id}) to ${origin}`,
  );
};

async function pollForOwnerToken(ctx: Ctx, client: PortalClient, start: DeviceStart): Promise<DeviceOwnerTokenResult> {
  let interval = Math.max(MIN_INTERVAL_S, Number.isFinite(start.interval) ? start.interval : MIN_INTERVAL_S);
  const deadline = ctx.now() + (Number.isFinite(start.expires_in) ? start.expires_in : 600) * 1000;
  const body: DeviceTokenInput = {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: start.device_code,
    client_id: CLIENT_ID,
  };
  let netFailures = 0;
  for (;;) {
    await ctx.sleep(interval * 1000);
    if (ctx.now() >= deadline) {
      throw new CliError(EXIT.deviceDenied, "expired_token", "the sign-in request expired before it was approved");
    }
    try {
      const res = await client.call<unknown>("device.token", body as unknown as Record<string, unknown>);
      netFailures = 0;
      if (!isRecord(res) || typeof res.access_token !== "string") {
        if (isRecord(res) && res.scope === "agent") {
          throw new CliError(EXIT.wrongKind, "wrong_credential_kind", "the Portal returned an agent connection, not an owner session");
        }
        throw new CliError(EXIT.network, "upstream_timeout", "the Portal returned an unexpected token response");
      }
      if (res.scope !== "owner" || !res.access_token.startsWith("tbo_") || typeof res.session_id !== "string") {
        throw new CliError(EXIT.wrongKind, "wrong_credential_kind", "the Portal returned a credential that is not an owner session (tbo_)");
      }
      return { scope: "owner", access_token: res.access_token, token_type: "Bearer", expires_in: Number(res.expires_in) || 86_400, session_id: res.session_id as `osn_${string}` };
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      if (e.code === "authorization_pending") {
        netFailures = 0;
        continue;
      }
      if (e.code === "slow_down") {
        netFailures = 0;
        interval += SLOW_DOWN_S;
        continue;
      }
      if (e.code === "access_denied") throw new CliError(EXIT.deviceDenied, "access_denied", "the sign-in request was denied in the browser", { requestId: e.requestId });
      if (e.code === "expired_token") throw new CliError(EXIT.deviceDenied, "expired_token", "the sign-in request expired before it was approved", { requestId: e.requestId });
      if (e.exit === EXIT.network && ++netFailures <= MAX_POLL_NETWORK_FAILURES) continue;
      throw e;
    }
  }
}

export const logout: Handler = async (ctx) => {
  const person = await readPerson(ctx);
  if (!person) throw new CliError(EXIT.notSignedIn, "unauthenticated", "not signed in; nothing to sign out");
  let revoked = false;
  let note: string | null = null;
  let deferred: CliError | null = null;
  try {
    // the token only ever goes to the Portal it was issued by
    await ctx.client(person.portal, person.token).call("owner_sessions.logout");
    revoked = true;
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    if (e.exit === EXIT.notSignedIn) note = "the Portal said the session was already invalid";
    else if (e.exit === EXIT.network) note = "the Portal could not be reached: the session stays valid on the server until it idles out or you revoke it in the Portal account page";
    else deferred = e;
  }
  await ctx.store().delete(PERSON_ITEM);
  if (deferred) throw deferred;
  if (note) ctx.say(`Deleted the local session. Note: ${note}.`);
  ctx.emit({ loggedOut: true, revokedOnServer: revoked, deletedLocally: true }, revoked ? "signed out; session revoked and local item deleted" : "signed out locally");
};

// ───────────────────────────── reads ─────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "-" : String(v);
}

function itemsOf(res: unknown): Record<string, unknown>[] {
  return isRecord(res) && Array.isArray(res.items) ? res.items.filter(isRecord) : [];
}

export const sessions: Handler = async (ctx) => {
  const { client, person } = await requireSession(ctx);
  const res = await client.call<{ items?: unknown[] }>("owner_sessions.list");
  const accountUrl = `${person.portal}/account`;
  const rows = [["ID", "CLIENT", "MACHINE", "LAST USED", "EXPIRES", ""]].concat(
    itemsOf(res).map((s) => [str(s.id), str(s.client), str(s.machineLabel), str(s.lastUsedAt), str(s.expiresAt), s.current === true ? "(this one)" : ""]),
  );
  ctx.emit({ ...res, accountUrl }, `${table(rows)}\n\nTo revoke another session open ${accountUrl}`);
};

export const whoami: Handler = async (ctx) => {
  const { client, person } = await requireSession(ctx);
  const me = await client.call<Record<string, any>>("account.me");
  const session = { id: person.sessionId, portal: person.portal, expiresAt: person.expiresAt };
  ctx.emit(
    { ...me, session },
    [
      `${str(me.person?.email)} (${str(me.account?.id)})`,
      `current workspace: ${str(me.currentWorkspaceId)} of ${str(me.workspaceCount)}`,
      `session: ${session.id} on ${session.portal}, expires ${session.expiresAt}`,
    ].join("\n"),
  );
};

export const workspaces: Handler = async (ctx) => {
  const sub = requirePos(ctx, 1, "command (list | show)");
  const { client } = await requireSession(ctx);
  if (sub === "list") {
    const res = await client.call("workspaces.list", pageInput(ctx));
    ctx.emit(res, table(itemsOf(res).map((w) => [str(w.id), str(w.name), str(w.status)])));
  } else if (sub === "show") {
    const ws = ctx.pos[2] ?? (await resolveWorkspace(ctx, client));
    ctx.emit(await client.call("workspaces.get", { ws }));
  } else throw usageError(`unknown command: workspaces ${sub}`);
};

export const agents: Handler = async (ctx) => {
  const sub = requirePos(ctx, 1, "command (list | show)");
  const { client } = await requireSession(ctx);
  const ws = await resolveWorkspace(ctx, client);
  if (sub === "list") {
    const res = await client.call("agents.list", { ws, ...pageInput(ctx) });
    ctx.emit(res, table(itemsOf(res).map((a) => [str(a.id), str(a.name), str(a.status), `${str(a.connections)} conn`])));
  } else if (sub === "show") {
    const agt = requirePos(ctx, 2, "agent id");
    const agent = await client.call("agents.get", { ws, agt });
    const conns = await client.call<{ items?: unknown[] }>("connections.list", { ws, agt });
    ctx.emit({ agent, connections: conns.items ?? [] });
  } else throw usageError(`unknown command: agents ${sub}`);
};

/** Local search over discovery intents and keywords (plus name/slug), every term must match. */
export function searchCatalog(items: Record<string, unknown>[], text: string): Record<string, unknown>[] {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;
  return items.filter((e) => {
    const hay = [str(e.slug), str(e.name), ...(Array.isArray(e.intents) ? e.intents.map(str) : []), ...(Array.isArray(e.keywords) ? e.keywords.map(str) : [])].join("\n").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export const catalog: Handler = async (ctx) => {
  const { client } = await requireSession(ctx);
  const input: Record<string, unknown> = {};
  if (ctx.g.ws) input.ws = ctx.g.ws;
  const res = await client.call<Record<string, unknown>>("catalog.list", input);
  const all = itemsOf(res);
  const items = ctx.v.search !== undefined ? searchCatalog(all, ctx.v.search) : all;
  ctx.emit({ ...res, items }, table(items.map((e) => [str(e.slug), str(e.name), str(e.category), str(e.summary)])));
};

export const instances: Handler = async (ctx) => {
  const sub = requirePos(ctx, 1, "command (list | show)");
  const { client } = await requireSession(ctx);
  const ws = await resolveWorkspace(ctx, client);
  if (sub === "list") {
    const res = await client.call("instances.list", { ws });
    ctx.emit(res, table(itemsOf(res).map((i) => [str(i.id), str(i.product), str(i.version), str(i.state), str(i.health)])));
  } else if (sub === "show") {
    ctx.emit(await client.call("instances.get", { ws, ins: requirePos(ctx, 2, "instance id") }));
  } else throw usageError(`unknown command: instances ${sub}`);
};

export const canvas: Handler = async (ctx) => {
  if (requirePos(ctx, 1, "command (show)") !== "show") throw usageError(`unknown command: canvas ${ctx.pos[1]}`);
  const { client } = await requireSession(ctx);
  ctx.emit(await client.call("canvas.get", { ws: await resolveWorkspace(ctx, client) }));
};

export const keys: Handler = async (ctx) => {
  if (requirePos(ctx, 1, "command (status)") !== "status") throw usageError(`unknown command: keys ${ctx.pos[1]}`);
  const { client } = await requireSession(ctx);
  const res = await client.call("keys.status", { ws: await resolveWorkspace(ctx, client) });
  ctx.emit(res, table(itemsOf(res).map((k) => [str(k.name), k.set === true ? "set" : k.set === false ? "missing" : "unknown", k.required === true ? "required" : "optional"])));
};

export const skills: Handler = async (ctx) => {
  const sub = requirePos(ctx, 1, "command (show | pack)");
  const { client } = await requireSession(ctx);
  const ws = await resolveWorkspace(ctx, client);
  const input: Record<string, unknown> = { ws };
  const agt = ctx.g.agents[0];
  if (agt) input.agt = agt;
  if (sub === "show") {
    ctx.emit(await client.call("skills.get", input));
  } else if (sub === "pack") {
    const file = resolve(ctx.cwd(), ctx.v.output ?? `skills-${ws}.zip`);
    const zip = await client.callBinary("skills.pack", input);
    await writeFile(file, zip.bytes);
    ctx.emit({ file, bytes: zip.bytes.byteLength }, `wrote ${file} (${zip.bytes.byteLength} bytes)`);
  } else throw usageError(`unknown command: skills ${sub}`);
};

export const harness: Handler = async (ctx) => {
  if (requirePos(ctx, 1, "command (options)") !== "options") throw usageError(`unknown command: harness ${ctx.pos[1]}`);
  const { client } = await requireSession(ctx);
  const res = await client.call("harness.options");
  ctx.emit(res, table(itemsOf(res).map((h) => [str(h.id), str(h.kind), str(h.label)])));
};

export const licences: Handler = async (ctx) => {
  if (requirePos(ctx, 1, "command (list)") !== "list") throw usageError(`unknown command: licences ${ctx.pos[1]}`);
  const { client } = await requireSession(ctx);
  const input = pageInput(ctx);
  if (ctx.v.product !== undefined) input.product = ctx.v.product;
  if (ctx.v.assigned !== undefined) {
    if (ctx.v.assigned !== "true" && ctx.v.assigned !== "false") throw usageError("--assigned must be true or false");
    input.assigned = ctx.v.assigned;
  }
  const res = await client.call("licences.list", input);
  ctx.emit(res, table(itemsOf(res).map((l) => [str(l.id), str(l.product), str(l.status), isRecord(l.assignment) ? str(l.assignment.ws) : "unassigned"])));
};

export const audit: Handler = async (ctx) => {
  const { client } = await requireSession(ctx);
  const input = pageInput(ctx);
  if (ctx.g.ws) input.ws = ctx.g.ws;
  if (ctx.v.action !== undefined) input.action = ctx.v.action;
  const res = await client.call("audit.list", input);
  ctx.emit(res, table(itemsOf(res).map((a) => [str(a.at), str(a.action), str(a.outcome), str(a.subject)])));
};
