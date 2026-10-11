/**
 * @opt2-tealbrick/harness-eve — connects an Eve agent to the bridge over MCP (CLI.md §7, REPOS §2).
 * One MCP connection to the local relay; every bridge tool becomes an Eve tool. No policy, no
 * generated mounts, no management channel. `defineTool` from `eve/tools` is injected by the host.
 */
import { connectMcp, heldOf, type McpClient, type McpTool, type StdioTarget } from "@opt2-tealbrick/bridge";

export interface EveToolDef {
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (input: Record<string, unknown>, context: { abortSignal?: AbortSignal }) => Promise<unknown>;
}

export interface EveBridgeOptions {
  agentId: string;
  /** default: `tealbrick bridge serve --stdio --agent <agentId>` */
  relay?: StdioTarget;
  /** `defineTool` from `eve/tools` */
  defineTool: (def: EveToolDef) => unknown;
  /** called when a call is held for the owner (show "waiting for owner approval") */
  onHeld?: (tool: string, holdId: string, checkWith: string) => void;
}

export interface EveBridge {
  /** Eve tools keyed by MCP tool name; refresh with `reload()` after `onChange` fires */
  tools: Record<string, unknown>;
  instructions: string | undefined;
  reload(): Promise<void>;
  onChange(fn: () => void): void;
  close(): void;
}

function toEveTool(client: McpClient, t: McpTool, o: EveBridgeOptions): unknown {
  return o.defineTool({
    description: t.description ?? t.title ?? t.name,
    inputSchema: t.inputSchema,
    execute: async (input) => {
      const r = await client.callTool(t.name, input);
      const held = heldOf(r);
      if (held) {
        o.onHeld?.(t.name, held.holdId, held.checkWith);
        return { ...held, note: `Waiting for the owner's approval. Check with ${held.checkWith} later; when approved, repeat the exact same call.` };
      }
      if (r.isError) return { error: r.structuredContent?.error ?? r.content?.[0]?.text ?? "error" };
      return r.structuredContent ?? r.content?.map((c) => c.text).join("\n");
    },
  });
}

export async function connectEveToBridge(o: EveBridgeOptions): Promise<EveBridge> {
  const client = connectMcp(o.relay ?? { command: "tealbrick", args: ["bridge", "serve", "--stdio", "--agent", o.agentId] });
  const init = await client.initialize("eve");
  const bridge: EveBridge = {
    tools: {},
    instructions: init.instructions,
    async reload() {
      const list = await client.listTools();
      bridge.tools = Object.fromEntries(list.map((t) => [t.name, toEveTool(client, t, o)]));
    },
    onChange(fn) {
      client.onToolsChanged(fn);
    },
    close() {
      client.close();
    },
  };
  await bridge.reload();
  return bridge;
}

export const HARNESS_ID = "eve";
