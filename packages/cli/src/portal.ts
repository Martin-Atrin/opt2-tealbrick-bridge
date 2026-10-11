import { randomUUID } from "node:crypto";
import type { RouteOp } from "@opt2-tealbrick/spec/routes";
import { ROUTES, TRANSPORTS } from "@opt2-tealbrick/spec/routes";
import { CliError, EXIT, isRecord, usageError } from "./io.ts";

/** Generic Portal route client: one function per route-registry row, no per-op code. */

const ROW_BY_ID: ReadonlyMap<string, RouteOp> = new Map(ROUTES.map((r) => [r.opId, r as RouteOp]));

export function routeRow(opId: string): RouteOp {
  const row = ROW_BY_ID.get(opId);
  if (!row) throw new CliError(EXIT.unexpected, "internal", `unknown op ${opId}`);
  return row;
}

export function isDraftableOp(opId: string): boolean {
  return ROW_BY_ID.get(opId)?.draftable === true;
}

/** https only; http only for loopback (CLI.md section 2). Returns the bare origin. */
export function normalizePortalOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError("portal origin is not a valid URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw usageError("portal origin must use https (http is allowed for loopback only)");
  }
  return url.origin;
}

/** Exit code for a Portal error (code first, then HTTP status). */
export function exitForError(status: number, code: string): number {
  switch (code) {
    case "draft_op_not_draftable":
    case "workspace_paused":
    case "forbidden":
      return EXIT.refused;
    case "revision_conflict":
    case "idempotency_conflict":
    case "draft_state":
    case "conflict":
      return EXIT.conflict;
    case "access_denied":
    case "expired_token":
      return EXIT.deviceDenied;
    case "unauthenticated":
      return EXIT.notSignedIn;
    default:
  }
  if (status === 401) return EXIT.notSignedIn;
  if (status === 403) return EXIT.refused;
  if (status === 404) return EXIT.notFound;
  if (status === 409) return EXIT.conflict;
  if (status === 400 || status === 422) return EXIT.validation;
  if (status === 429 || status >= 500) return EXIT.network;
  return EXIT.unexpected;
}

export interface CallOptions {
  /** Override the Idempotency-Key for rows that require one. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface PortalClientOptions {
  origin: string;
  fetch: typeof fetch;
  /** K3 `tbo_…`. Never logged, never put in an error. */
  token?: string;
}

export interface BinaryResult {
  bytes: Uint8Array;
  contentType: string;
}

export class PortalClient {
  origin: string;
  #fetch: typeof fetch;
  #token: string | undefined;

  constructor(opts: PortalClientOptions) {
    this.origin = opts.origin;
    this.#fetch = opts.fetch;
    this.#token = opts.token;
    if (opts.token !== undefined && !opts.token.startsWith("tbo_")) {
      throw new CliError(EXIT.wrongKind, "wrong_credential_kind", "owner commands accept only the person credential (tbo_); refusing to send another kind");
    }
  }

  /** Call a route-registry op by id. `input` is the flat input object of the row. */
  async call<T = unknown>(opId: string, input: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const res = await this.#send(opId, input, opts);
    if (res.status === 204) return {} as T;
    const text = await res.text();
    if (text.length === 0) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError(EXIT.network, "upstream_timeout", `unexpected non-JSON response from ${opId}`);
    }
  }

  /** For `binary` transport rows (skills.pack). */
  async callBinary(opId: string, input: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<BinaryResult> {
    const res = await this.#send(opId, input, opts);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async #send(opId: string, input: Record<string, unknown>, opts: CallOptions): Promise<Response> {
    const row = routeRow(opId);
    if (row.exposure !== "gateway") throw new CliError(EXIT.unexpected, "internal", `${opId} is not a gateway route`);
    const ownerCallable = row.auth.includes("owner-cli");
    const open = row.auth.includes("public") || row.auth.includes("device");
    if (!ownerCallable && !open) {
      throw new CliError(EXIT.refused, "forbidden", `${opId} is not callable from the owner CLI`);
    }

    const rest: Record<string, unknown> = {};
    const used = new Set<string>();
    const path = row.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const v = input[name];
      if (typeof v !== "string" || v.length === 0) throw usageError(`missing ${name}`);
      used.add(name);
      return encodeURIComponent(v);
    });
    for (const [k, v] of Object.entries(input)) if (!used.has(k) && v !== undefined) rest[k] = v;

    const url = new URL(`${this.origin}/api/v1${path}`);
    const headers: Record<string, string> = { accept: row.transport === "binary" ? "application/zip" : "application/json" };
    let body: string | undefined;
    if (row.method === "GET") {
      for (const key of row.query) {
        const v = rest[key];
        if (v === undefined || v === null) continue;
        url.searchParams.set(key, Array.isArray(v) ? v.join(",") : String(v));
      }
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(rest);
    }
    if (ownerCallable && !open) {
      if (this.#token === undefined) throw new CliError(EXIT.notSignedIn, "unauthenticated", "not signed in; run tealbrick login");
      headers.authorization = `Bearer ${this.#token}`;
    }
    if (row.idempotent) headers["idempotency-key"] = opts.idempotencyKey ?? randomUUID();

    const timeout = AbortSignal.timeout(TRANSPORTS[row.transport].timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    let res: Response;
    try {
      const init: RequestInit = { method: row.method, headers, signal };
      if (body !== undefined) init.body = body;
      res = await this.#fetch(url, init);
    } catch (e) {
      const reason = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "request timed out" : "network error";
      throw new CliError(EXIT.network, "upstream_timeout", `${reason} calling the Portal (${opId})`);
    }
    if (res.ok) return res;
    throw await errorFromResponse(res, opId);
  }
}

/** CORE section 8 envelope → CliError with the exit code mapping of CLI.md section 2.1. */
export async function errorFromResponse(res: Response, opId: string): Promise<CliError> {
  let code = "internal";
  let message = `${opId} failed with HTTP ${res.status}`;
  let requestId = res.headers.get("x-request-id") ?? "unknown";
  let details: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const e = parsed.error;
      if (typeof e.code === "string") code = e.code;
      if (typeof e.message === "string") message = e.message;
      if (typeof e.requestId === "string") requestId = e.requestId;
      if (isRecord(e.details)) details = e.details;
    }
  } catch {
    // not JSON (gateway or proxy page): keep the generic message
  }
  const extra: { requestId: string; details?: Record<string, unknown> } = { requestId };
  if (details) extra.details = details;
  return new CliError(exitForError(res.status, code), code, message, extra);
}
