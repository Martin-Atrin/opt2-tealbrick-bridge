import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeErrorCode, ErrorEnvelope } from "@opt2-tealbrick/spec/bridge";

/** A refusal or failure that maps to the one error envelope (CORE §8). */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode | (string & {});
  readonly status: number;
  constructor(code: BridgeErrorCode | (string & {}), status = 400, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

export const nowS = (): number => Math.floor(Date.now() / 1000);

export function envelope(code: string, message: string, requestId: string): ErrorEnvelope {
  return { error: { code, message, requestId } };
}

/** Default HTTP status per refuse code. */
export function statusFor(code: string): number {
  switch (code) {
    case "unauthenticated":
    case "invalid_token":
      return 401;
    case "paused":
    case "no_grant":
    case "grant_invalid":
    case "grant_expired":
    case "grant_revoked":
    case "crud_exceeds_grant":
    case "audience_not_agent":
    case "scope_type_unknown":
    case "not_in_workflow":
    case "hook_denied":
    case "key_not_declared":
    case "dynamic_ceiling_exceeded":
      return 403;
    case "unknown_tool":
    case "key_not_set":
    case "not_found":
      return 404;
    case "payload_too_large":
      return 413;
    case "rate_limited":
      return 429;
    case "config_expired":
    case "app_unavailable":
    case "hook_failed":
    case "after_failed":
    case "dynamic_resolve_failed":
      return 503;
    case "app_timeout":
      return 504;
    case "app_error":
      return 502;
    default:
      return 400;
  }
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * JSON-lines logger. Callers pass ids, codes and digests only (BRIDGE §12): never inputs, outputs,
 * tokens, tickets, codes or key values. Failures are deduplicated to one line per event+code per minute.
 */
export function jsonLogger(write: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Logger {
  const seen = new Map<string, number>();
  const emit = (level: string, event: string, fields: Record<string, unknown> = {}) => {
    try {
      if (level !== "info") {
        const key = `${event}|${String(fields.kind ?? "")}|${String(fields.code ?? "")}`;
        const last = seen.get(key) ?? 0;
        const now = Date.now();
        if (now - last < 60_000) return;
        if (seen.size > 1024) seen.clear();
        seen.set(key, now);
      }
      write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
    } catch {
      /* logging never changes an outcome */
    }
  };
  return {
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Reads a request body with a hard size cap. */
export async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > max) throw new BridgeError("payload_too_large", 413);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export function parseJson(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new BridgeError("input_invalid", 400, "body is not JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(body);
}

export function sendError(res: ServerResponse, err: unknown, requestId: string, headers: Record<string, string> = {}): void {
  const code = err instanceof BridgeError ? err.code : "app_error";
  const status = err instanceof BridgeError ? err.status : 500;
  const message = err instanceof BridgeError ? err.message : "internal error";
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, envelope(code, message, requestId), headers);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Origin check for URLs the bridge receives in config or enrolment (https, loopback http only in tests). */
export function assertOrigin(value: string, what: string): string {
  const u = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
  if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) || u.username || u.password || u.search || u.hash) {
    throw new BridgeError("input_invalid", 400, `${what} must be an https origin`);
  }
  return u.origin;
}

/** Simple fixed-window rate limiter keyed by a string (BRIDGE §6.3, §9.2). */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  take(key: string): boolean {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.limit;
  }
}

export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export function jitter(ms: number, fraction = 0.25): number {
  return Math.round(ms * (1 - fraction + Math.random() * fraction * 2));
}
