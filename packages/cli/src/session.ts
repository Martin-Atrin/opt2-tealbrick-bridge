import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx } from "./ctx.ts";
import { CliError, EXIT, isRecord, usageError } from "./io.ts";
import type { PortalClient } from "./portal.ts";
import { PERSON_ITEM } from "./store.ts";

/** The person item (K3). Owner commands read this item and no other. */
export interface PersonRecord {
  v: 1;
  kind: "person";
  token: string;
  sessionId: string;
  portal: string;
  expiresAt: string;
}

const AGENT_KEYS = ["privateKey", "private_key", "privateJwk", "private_jwk", "jwk", "connectionId", "connection_id", "con", "bridgeUrl", "bridge_url", "agentId", "agent_id", "agt"];
const NON_OWNER_TOKEN = /^(tbr_|tbac_|tbdv_|tbat_|eyJ)/;

/** "person" | "agent" | "unknown": a stored value is classified without being logged. */
export function classifyCredential(raw: string): "person" | "agent" | "unknown" {
  const text = raw.trim();
  if (NON_OWNER_TOKEN.test(text)) return "agent";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unknown";
  }
  if (!isRecord(parsed)) return "unknown";
  if (parsed.kind === "agent") return "agent";
  if (parsed.kind === "person") {
    // only a string token is inspected: String() on an object with a non-callable toString throws (C62 fuzz)
    if (typeof parsed.token !== "string") return "unknown";
    return parsed.token.startsWith("tbo_") ? "person" : NON_OWNER_TOKEN.test(parsed.token) ? "agent" : "unknown";
  }
  if (AGENT_KEYS.some((k) => k in parsed)) return "agent";
  const token = parsed.token ?? parsed.access_token;
  if (typeof token === "string") {
    if (token.startsWith("tbo_")) return "person";
    if (NON_OWNER_TOKEN.test(token)) return "agent";
  }
  return "unknown";
}

function parsePerson(raw: string): PersonRecord | null {
  try {
    const p: unknown = JSON.parse(raw);
    if (!isRecord(p)) return null;
    const { token, sessionId, portal, expiresAt } = p;
    if (typeof token !== "string" || typeof sessionId !== "string" || typeof portal !== "string" || typeof expiresAt !== "string") return null;
    return { v: 1, kind: "person", token, sessionId, portal, expiresAt };
  } catch {
    return null;
  }
}

export function requireKeychain(ctx: Ctx): void {
  if (ctx.store().kind === "file") {
    throw new CliError(
      EXIT.notSignedIn,
      "unauthenticated",
      "owner mode needs the OS keychain for the person credential; TB_CREDENTIAL_STORE=file is for agent items only",
    );
  }
}

export async function savePerson(ctx: Ctx, rec: PersonRecord): Promise<void> {
  requireKeychain(ctx);
  await ctx.store().put(PERSON_ITEM, JSON.stringify(rec));
}

/** Read the person item. Refuses (exit 4) when it holds an agent-looking credential, before any network call. */
export async function readPerson(ctx: Ctx): Promise<PersonRecord | null> {
  requireKeychain(ctx);
  const raw = await ctx.store().get(PERSON_ITEM);
  if (raw === null) return null;
  const kind = classifyCredential(raw);
  if (kind === "agent") {
    throw new CliError(EXIT.wrongKind, "wrong_credential_kind", "the person item holds an agent credential; owner commands accept only a person credential (tbo_). Run tealbrick login.");
  }
  const rec = kind === "person" ? parsePerson(raw) : null;
  if (!rec) throw new CliError(EXIT.notSignedIn, "unauthenticated", "the stored person credential is unreadable; run tealbrick login");
  return rec;
}

export interface Session {
  person: PersonRecord;
  client: PortalClient;
}

/** Signed-in session for an owner command. Exit 3 when missing, expired, or for another Portal. */
export async function requireSession(ctx: Ctx): Promise<Session> {
  const person = await readPerson(ctx);
  if (!person) throw new CliError(EXIT.notSignedIn, "unauthenticated", "not signed in; run tealbrick login");
  const explicit = ctx.explicitPortal();
  if (explicit && explicit !== person.portal) {
    throw new CliError(EXIT.notSignedIn, "unauthenticated", `signed in to ${person.portal}, not ${explicit}; run tealbrick login --portal ${explicit}`);
  }
  // expiresAt is informational (the Portal slides the idle window); a stale token gets 401 -> exit 3.
  return { person, client: ctx.client(person.portal, person.token) };
}

const WS_ID = /^ws_[A-Za-z0-9]+$/;

export function checkWsId(ws: string): string {
  if (!WS_ID.test(ws)) throw usageError("workspace id must look like ws_…");
  return ws;
}

/** --ws / TB_WORKSPACE, else the account's current workspace (account.me). */
export async function resolveWorkspace(ctx: Ctx, client: PortalClient): Promise<string> {
  if (ctx.g.ws) return checkWsId(ctx.g.ws);
  const me = await client.call<{ currentWorkspaceId?: string | null }>("account.me");
  if (!me.currentWorkspaceId) throw usageError("no current workspace; pass --ws <ws_…> or set TB_WORKSPACE");
  return me.currentWorkspaceId;
}

// ───────────────────────────── local "current draft" pointer (no secret) ─────────────────────────────

function statePath(ctx: Ctx): string {
  return join(ctx.configDir(), "state.json");
}

export async function getCurrentDraft(ctx: Ctx, portal: string): Promise<string | undefined> {
  try {
    const s: unknown = JSON.parse(await readFile(statePath(ctx), "utf8"));
    if (isRecord(s) && isRecord(s.currentDraft) && s.currentDraft.portal === portal && typeof s.currentDraft.id === "string") return s.currentDraft.id;
  } catch {
    // no state yet
  }
  return undefined;
}

export async function setCurrentDraft(ctx: Ctx, portal: string, id: string): Promise<void> {
  const dir = ctx.configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = statePath(ctx);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({ currentDraft: { id, portal } })}\n`, { mode: 0o600 });
  await rename(tmp, path);
}
