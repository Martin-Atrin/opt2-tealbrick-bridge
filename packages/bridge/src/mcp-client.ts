/**
 * Minimal MCP client over stdio for harness adapters (Eve, hold polling in harness-claude). It talks
 * to the local relay (`tealbrick bridge serve --stdio`); it holds no policy and no credentials.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpClient {
  initialize(clientName: string): Promise<{ instructions?: string; protocolVersion: string }>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<McpToolResult>;
  onToolsChanged(fn: () => void): void;
  close(): void;
}

export interface StdioTarget {
  /** spawn this command (e.g. `tealbrick bridge serve --stdio --agent <agt>`) … */
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** … or use existing streams (tests, in-process relay) */
  streams?: { input: Readable; output: Writable };
  /** per-call timeout (default {@link MCP_CALL_TIMEOUT_MS}) */
  callTimeoutMs?: number;
}

/** F26: default per-call timeout (above the relay's own 120 s upstream limit) */
export const MCP_CALL_TIMEOUT_MS = 150_000;

export class McpTimeoutError extends Error {
  readonly code = "mcp_timeout";
  constructor(method: string, ms: number) {
    super(`mcp ${method}: no answer within ${Math.round(ms / 1000)} s`);
  }
}

export function connectMcp(target: StdioTarget): McpClient {
  let child: ChildProcess | undefined;
  let input: Readable;
  let output: Writable;
  if (target.streams) {
    input = target.streams.input;
    output = target.streams.output;
  } else {
    if (!target.command) throw new Error("connectMcp needs a command or streams");
    child = spawn(target.command, target.args ?? [], { stdio: ["pipe", "pipe", "inherit"], env: target.env ?? process.env });
    input = child.stdout as Readable;
    output = child.stdin as Writable;
  }
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const changed = new Set<() => void>();
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => {
    let m: { id?: number; result?: unknown; error?: { message?: string }; method?: string };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method === "notifications/tools/list_changed") for (const f of changed) f();
    if (typeof m.id !== "number") return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message ?? "mcp error"));
    else p.resolve(m.result);
  });
  rl.on("close", () => {
    for (const p of pending.values()) p.reject(new Error("mcp connection closed"));
    pending.clear();
  });
  const timeoutMs = target.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
  const request = <T>(method: string, params?: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      // F26: a call never waits forever (a lost answer after a bridge restart): it fails after `timeoutMs`
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new McpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  const notify = (method: string) => output.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  return {
    async initialize(clientName) {
      const r = await request<{ instructions?: string; protocolVersion: string }>("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: clientName, version: "0.1.0" },
      });
      notify("notifications/initialized");
      return r;
    },
    async listTools() {
      const r = await request<{ tools: McpTool[] }>("tools/list");
      return r.tools;
    },
    callTool(name, args, meta) {
      return request<McpToolResult>("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    },
    onToolsChanged(fn) {
      changed.add(fn);
    },
    close() {
      rl.close();
      output.end();
      child?.kill("SIGTERM");
    },
  };
}

/** `structuredContent` of a held result (BRIDGE §8.1 step 13). */
export interface HeldResult {
  status: "held";
  holdId: string;
  expiresAt: string;
  checkWith: string;
}

export function heldOf(result: McpToolResult | undefined): HeldResult | undefined {
  const s = result?.structuredContent;
  if (!result || result.isError || !s || s.status !== "held") return undefined;
  if (typeof s.holdId !== "string" || typeof s.checkWith !== "string" || typeof s.expiresAt !== "string") return undefined;
  return s as unknown as HeldResult;
}

/**
 * Polls `checkWith` (≥ 10 s) until the owner decides or the hold expires (CLI.md §7). Never approves,
 * never changes the input. On `approved` the caller repeats the exact same call.
 */
export async function pollHold(
  callTool: McpClient["callTool"],
  held: HeldResult,
  opts: { intervalMs?: number; signal?: AbortSignal; onTick?: (status: string) => void } = {},
): Promise<"approved" | "denied" | "expired"> {
  const interval = Math.max(opts.intervalMs ?? 10_000, 10_000);
  const expires = Date.parse(held.expiresAt);
  while (!opts.signal?.aborted) {
    if (Number.isFinite(expires) && Date.now() > expires) return "expired";
    await new Promise((r) => setTimeout(r, interval));
    const r = await callTool(held.checkWith, { holdId: held.holdId }).catch(() => undefined);
    const status = typeof r?.structuredContent?.status === "string" ? (r.structuredContent.status as string) : "unknown";
    opts.onTick?.(status);
    if (status === "approved") return "approved";
    if (status === "denied" || status === "declined") return "denied";
    if (status === "expired") return "expired";
  }
  return "expired";
}
