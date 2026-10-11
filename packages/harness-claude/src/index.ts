/**
 * @opt2-tealbrick/harness-claude — Claude Agent SDK adapter (CLI.md §7, PRD §9).
 *
 * Builds the options for the SDK's `query()` so a session reaches Teal Brick apps only through the
 * bridge (local relay over stdio), runs isolated (no global Claude settings, no permission bypass),
 * with an allow-listed environment, and shows held calls as "waiting for owner approval".
 * It holds NO policy: every grant, pause and hook decision is the deployed bridge's.
 *
 * The SDK itself is injected (`ClaudeSdk`), so hosts (TBD, kits) pin their own SDK version.
 */
import type { HeldResult } from "@opt2-tealbrick/bridge";

/** The subset of `@anthropic-ai/claude-agent-sdk` this adapter uses. */
export interface ClaudeSdk {
  query(params: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }): AsyncIterable<SdkMessage> & { interrupt?(): Promise<unknown> };
}

export type SdkMessage = { type: string; subtype?: string; session_id?: string; message?: { content?: unknown }; result?: string; [k: string]: unknown };

/** Env names a session may inherit; everything else is dropped (CREDENTIALS §12: allow-listed env). */
export const SAFE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"] as const;

/** Never forwarded, even if a host lists them: Teal Brick credentials and person/owner material. */
const NEVER = /^(TB_|TEALBRICK_)|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CLERK|SESSION/i;

/** Builds the session environment: SAFE_ENV + host passthrough + the model key name the host chose. */
export function sessionEnv(source: NodeJS.ProcessEnv, opts: { passthrough?: readonly string[]; modelKeyEnv?: string } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...SAFE_ENV, ...(opts.passthrough ?? [])]) {
    const v = source[name];
    if (v !== undefined && !NEVER.test(name)) out[name] = v;
  }
  // the agent's own model key (e.g. ANTHROPIC_API_KEY) is the one explicit exception the host names
  if (opts.modelKeyEnv && source[opts.modelKeyEnv] !== undefined) out[opts.modelKeyEnv] = source[opts.modelKeyEnv] as string;
  return out;
}

export interface BridgeAttachment {
  /** agent card id; the relay picks the matching key connection item */
  agentId: string;
  /** relay command; default `tealbrick bridge serve --stdio --agent <agentId>` */
  command?: string;
  args?: string[];
}

/** MCP server entry for the relay (stdio only, CORE I5). */
export function bridgeMcpServer(a: BridgeAttachment): { type: "stdio"; command: string; args: string[] } {
  return { type: "stdio", command: a.command ?? "tealbrick", args: a.args ?? ["bridge", "serve", "--stdio", "--agent", a.agentId] };
}

export const BRIDGE_SERVER_NAME = "tealbrick";
export const BRIDGE_TOOL_PATTERN = `mcp__${BRIDGE_SERVER_NAME}__`;

export interface SessionOptions {
  bridge: BridgeAttachment;
  cwd: string;
  /** host env to filter (default process.env) */
  env?: NodeJS.ProcessEnv;
  passthroughEnv?: readonly string[];
  modelKeyEnv?: string;
  model?: string;
  /** appended to the Claude Code preset system prompt (e.g. TBD's companion instructions) */
  appendSystemPrompt?: string;
  /**
   * Built-in tools the host allows (default: none). Harness-local tools (e.g. TBD Companion timeline
   * tools) come as extra MCP servers the host owns; they are not Teal Brick operations (C5).
   */
  builtinTools?: readonly string[];
  extraMcpServers?: Record<string, unknown>;
  /** OS sandbox settings for shell tools, passed through to the SDK when Bash is allowed */
  sandbox?: Record<string, unknown>;
  onHeld?: (held: HeldResult & { tool: string }) => void;
  maxTurns?: number;
}

/** Text shown to the model next to a held result. */
export function heldGuidance(h: HeldResult): string {
  return `This call is waiting for the owner's approval in the app (hold ${h.holdId}, expires ${h.expiresAt}). Do not retry it with different input. Check it later with the tool ${h.checkWith} {"holdId":"${h.holdId}"}; when the status is "approved", repeat the exact same call once.`;
}

function heldFromToolResponse(resp: unknown): HeldResult | undefined {
  const r = resp as { structuredContent?: Record<string, unknown>; isError?: boolean } | undefined;
  const s = r?.structuredContent;
  if (!s || r?.isError || s.status !== "held" || typeof s.holdId !== "string" || typeof s.checkWith !== "string") return undefined;
  return s as unknown as HeldResult;
}

/**
 * Options for `sdk.query()`. Isolation (PRD §9): `settingSources: []` (no user/project Claude
 * settings or CLAUDE.md are read), `strictMcpConfig`, never `bypassPermissions`.
 */
export function buildOptions(o: SessionOptions): Record<string, unknown> {
  const builtins = [...(o.builtinTools ?? [])];
  const mcpServers = { ...(o.extraMcpServers ?? {}), [BRIDGE_SERVER_NAME]: bridgeMcpServer(o.bridge) };
  if (o.extraMcpServers && Object.hasOwn(o.extraMcpServers, BRIDGE_SERVER_NAME)) throw new Error(`extra MCP server may not be named ${BRIDGE_SERVER_NAME}`);
  return {
    cwd: o.cwd,
    env: sessionEnv(o.env ?? process.env, { ...(o.passthroughEnv ? { passthrough: o.passthroughEnv } : {}), ...(o.modelKeyEnv ? { modelKeyEnv: o.modelKeyEnv } : {}) }),
    ...(o.model ? { model: o.model } : {}),
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: "default",
    mcpServers,
    allowedTools: [...builtins, `${BRIDGE_TOOL_PATTERN}*`, ...Object.keys(o.extraMcpServers ?? {}).map((s) => `mcp__${s}__*`)],
    ...(builtins.includes("Bash") && o.sandbox ? { sandbox: o.sandbox } : {}),
    systemPrompt: { type: "preset", preset: "claude_code", ...(o.appendSystemPrompt ? { append: o.appendSystemPrompt } : {}) },
    ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
    hooks: {
      PostToolUse: [
        {
          matcher: `${BRIDGE_TOOL_PATTERN}.*`,
          hooks: [
            async (input: { tool_name?: string; tool_response?: unknown }) => {
              const held = heldFromToolResponse(input.tool_response);
              if (!held) return {};
              o.onHeld?.({ ...held, tool: String(input.tool_name ?? "") });
              return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: heldGuidance(held) } };
            },
          ],
        },
      ],
    },
  };
}

export type HarnessEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "held"; tool: string; holdId: string; checkWith: string; expiresAt: string }
  | { type: "result"; ok: boolean; text?: string }
  | { type: "error"; code: string };

/** Runs one turn and maps SDK messages to a small event stream for the host UI (TBD chat). */
export async function runTurn(sdk: ClaudeSdk, prompt: string, o: SessionOptions & { resume?: string }, onEvent: (e: HarnessEvent) => void): Promise<void> {
  const options = buildOptions({ ...o, onHeld: (h) => onEvent({ type: "held", tool: h.tool, holdId: h.holdId, checkWith: h.checkWith, expiresAt: h.expiresAt }) });
  if (o.resume) options.resume = o.resume;
  try {
    for await (const m of sdk.query({ prompt, options })) {
      if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") onEvent({ type: "session", sessionId: m.session_id });
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const block of m.message.content as { type: string; text?: string; name?: string }[]) {
          if (block.type === "text" && block.text) onEvent({ type: "text", text: block.text });
          if (block.type === "tool_use" && block.name) onEvent({ type: "tool", name: block.name });
        }
      }
      if (m.type === "result") onEvent({ type: "result", ok: m.subtype === "success", ...(typeof m.result === "string" ? { text: m.result } : {}) });
    }
  } catch (e) {
    onEvent({ type: "error", code: e instanceof Error ? e.name : "error" });
  }
}

/** Claude Desktop / Claude Code / Codex connection assets live in `tealbrick connect` (CLI) and connect/*.md. */
export const HARNESS_ID = "claude_agent_sdk";
