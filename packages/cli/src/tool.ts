/**
 * `tealbrick tool list|call` (F65): call one Teal Brick tool as the agent, through the same in-process relay as
 * `agent serve`. Agent mode only: it reads the local agent item, never the person item. Read-only by default.
 */
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { connectMcp, type McpTool, type McpToolResult, manifestApi, startRelay } from "@opt2-tealbrick/bridge";
import type { Ctx, Handler } from "./ctx.ts";
import { requirePos, table } from "./ctx.ts";
import { CliError, EXIT, isRecord, usageError } from "./io.ts";
import { pickAgent } from "./lead.ts";
import type { AgentItem } from "./relay-main.ts";

/** Open the agent's MCP connection (the given item, else `--agent`), run `fn`, and always close it. */
export async function withAgentMcp<T>(ctx: Ctx, fn: (mcp: ReturnType<typeof connectMcp>, agent: string) => Promise<T>, given?: AgentItem): Promise<T> {
  const item = given ?? (await pickAgent(ctx));
  const api = manifestApi();
  const key = await api.importKeyPair(new Uint8Array(Buffer.from(item.privateKey, "base64url")));
  const toRelay = new PassThrough();
  const fromRelay = new PassThrough();
  const relay = startRelay({
    api,
    bridgeUrl: item.bridgeUrl,
    connection: { con: item.con, agt: item.agt, bridgeId: item.bridgeId },
    signer: {
      sign: async (input) => Buffer.from(await crypto.subtle.sign("Ed25519", key.privateKey, new TextEncoder().encode(input))).toString("base64url"),
      publicJwk: () => item.publicJwk,
    },
    stdin: toRelay,
    stdout: fromRelay,
  });
  const mcp = connectMcp({ streams: { input: fromRelay, output: toRelay } });
  try {
    await mcp.initialize("tealbrick-cli");
    return await fn(mcp, item.agt);
  } catch (e) {
    if (e instanceof CliError) throw e;
    const message = e instanceof Error ? e.message : "bridge call failed";
    throw new CliError(/connection (not active|revoked)/.test(message) ? EXIT.refused : EXIT.network, "bridge_unavailable", message);
  } finally {
    mcp.close();
    relay.stop();
  }
}

const isReadOnly = (t: McpTool): boolean => t.annotations?.readOnlyHint === true;

async function toolList(ctx: Ctx): Promise<void> {
  const { agent, tools } = await withAgentMcp(ctx, async (mcp, agent) => ({ agent, tools: await mcp.listTools() }));
  const rows = tools.map((t) => ({ name: t.name, readOnly: isReadOnly(t), title: t.title ?? null }));
  ctx.emit(
    { agent, tools: rows },
    rows.length ? table(rows.map((r) => [r.name, r.readOnly ? "read-only" : "write", r.title ?? ""])) : `agent ${agent} has no tools`,
  );
}

async function parseInput(raw: string | undefined): Promise<Record<string, unknown>> {
  if (raw === undefined) return {};
  let text = raw;
  if (raw.startsWith("@")) {
    try {
      text = await readFile(raw.slice(1), "utf8");
    } catch {
      throw new CliError(EXIT.validation, "input_invalid", `cannot read input file ${raw.slice(1)}`);
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError(EXIT.validation, "input_invalid", "--input is not valid JSON");
  }
  if (!isRecord(value)) throw new CliError(EXIT.validation, "input_invalid", "--input must be a JSON object");
  return value;
}

const textOf = (r: McpToolResult): string =>
  (r.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");

async function toolCall(ctx: Ctx): Promise<void> {
  const name = requirePos(ctx, 2, "tool name (tealbrick tool call <name>)");
  const args = await parseInput(ctx.v.input);
  const res = await withAgentMcp(ctx, async (mcp) => {
    const tools = await mcp.listTools();
    const found = tools.find((t) => t.name === name);
    if (!found) throw new CliError(EXIT.notFound, "unknown_tool", `no tool named ${name}; run tealbrick tool list`);
    if (!isReadOnly(found) && ctx.g.yes !== true) {
      throw new CliError(EXIT.refused, "confirmation_required", `${name} is not marked read-only: it can change data; pass --yes to run it`);
    }
    return mcp.callTool(name, args);
  });
  const result: unknown = res.structuredContent ?? textOf(res);
  if (res.isError === true) {
    const err = isRecord(res.structuredContent?.error) ? res.structuredContent.error : {};
    const code = typeof err.code === "string" ? err.code : "tool_error";
    const message = typeof err.message === "string" ? err.message : textOf(res) || `${name} returned an error`;
    throw new CliError(EXIT.refused, code, message, { details: { tool: name, isError: true, result } });
  }
  ctx.emit({ tool: name, isError: false, result }, typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

export const tool: Handler = async (ctx) => {
  const sub = ctx.pos[1];
  if (sub === "list") return toolList(ctx);
  if (sub === "call") return toolCall(ctx);
  throw usageError("tool needs a command: list | call <name> [--input <json|@file>] [--yes]");
};
