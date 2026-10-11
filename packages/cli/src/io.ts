import type { CredentialStore } from "./store.ts";

/** Everything the CLI touches in the outside world, injectable so tests can drive `run`. */
export interface TextSink {
  write(chunk: string): unknown;
}

export interface InputStream extends AsyncIterable<string | Uint8Array> {
  isTTY?: boolean;
  setEncoding?(encoding: BufferEncoding): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  pause?(): unknown;
  resume?(): unknown;
}

export interface Io {
  stdout: TextSink;
  stderr: TextSink;
  stdin: InputStream;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** Credential store; default is built from env (keychain, or file for agent items). */
  store?: CredentialStore;
  /** Test hooks; defaults are the real thing. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  cwd?: string;
  platform?: string;
  hostname?: string;
  openUrl?: (url: string) => Promise<void>;
}

/** Exit codes, CLI.md section 2.1. */
export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  notSignedIn: 3,
  wrongKind: 4,
  refused: 5,
  notFound: 6,
  conflict: 7,
  validation: 8,
  network: 9,
  deviceDenied: 10,
} as const;

/** A failure with an exit code and a CORE section 8 envelope code. */
export class CliError extends Error {
  exit: number;
  code: string;
  requestId: string;
  details: Record<string, unknown> | undefined;
  constructor(exit: number, code: string, message: string, extra?: { requestId?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = "CliError";
    this.exit = exit;
    this.code = code;
    this.requestId = extra?.requestId ?? "local";
    this.details = extra?.details;
  }
}

export function usageError(message: string): CliError {
  return new CliError(EXIT.usage, "bad_request", message);
}

export function envelope(err: CliError): { error: { code: string; message: string; requestId: string; details?: Record<string, unknown> } } {
  const error: { code: string; message: string; requestId: string; details?: Record<string, unknown> } = {
    code: err.code,
    message: err.message,
    requestId: err.requestId,
  };
  if (err.details) error.details = err.details;
  return { error };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
