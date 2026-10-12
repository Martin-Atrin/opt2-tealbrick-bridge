/**
 * MCP tool list per agent (BRIDGE §7.2–§7.3): exactly the operations the agent's grants allow,
 * computed from the current table. Names `<product>__<op>`, charset ^[a-z0-9_-]+$, ≤ 64 chars.
 */
import { TOOL_NAME_RULE } from "@opt2-tealbrick/spec/bridge";
import type { AgentId, GrantClaims } from "@opt2-tealbrick/spec/credentials";
import { type DynamicCatalogEntry, EFFECTS, type JsonSchemaObject } from "@opt2-tealbrick/spec/manifest";
import type { OperationView } from "./api.ts";
import type { CallRouter } from "./calls.ts";
import type { BridgeContext } from "./context.ts";
import { type AppRuntime, agtRef, type Table } from "./table.ts";

export type ToolRoute =
  | { kind: "op"; app: AppRuntime; op: OperationView }
  | { kind: "dynamic_entry"; app: AppRuntime; op: OperationView; entry: string }
  | { kind: "dynamic_search"; app: AppRuntime; op: OperationView }
  | { kind: "dynamic_call"; app: AppRuntime; op: OperationView }
  | { kind: "hold_status"; app: AppRuntime; op: OperationView }
  | { kind: "skills"; app: AppRuntime };

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchemaObject;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export interface ToolIndex {
  rev: number;
  tools: ToolDef[];
  routes: Map<string, ToolRoute>;
}

const NAME_RE = new RegExp(TOOL_NAME_RULE.pattern);
const SEARCH_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: { query: { type: "string", minLength: 1, maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 50 } },
};
const CALL_SCHEMA: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["tool", "arguments"],
  properties: { tool: { type: "string", minLength: 1, maxLength: 200 }, arguments: { type: "object" } },
};
const HOLD_SCHEMA: JsonSchemaObject = { type: "object", additionalProperties: false, required: ["holdId"], properties: { holdId: { type: "string", minLength: 1, maxLength: 128 } } };
const SKILLS_SCHEMA: JsonSchemaObject = { type: "object", additionalProperties: false, properties: { skillId: { type: "string", maxLength: 64 } } };

function annotations(effect: string): ToolDef["annotations"] {
  return {
    readOnlyHint: effect === "read",
    destructiveHint: effect === "destructive",
    openWorldHint: effect === "outward" || effect === "money",
  };
}

const subset = (a: readonly string[], b: readonly string[]) => a.every((x) => b.includes(x));

/** Visible ops of one app for one grant (CORE §7 rules, without the signature check gate() does per call). */
export function visibleOps(app: AppRuntime, grant: GrantClaims): OperationView[] {
  const out: OperationView[] = [];
  for (const op of app.ops.values()) {
    if (op.audience !== "agent") continue;
    if (op.standard) continue; // tb.hold_status is added per product separately
    if (!subset(op.crud, grant.crud)) continue;
    if (op.scopeType && !app.scopeTypes.includes(op.scopeType)) continue;
    if (grant.mode === "bound" && !grant.wf.includes(op.id)) continue;
    out.push(op);
  }
  return out;
}

export function agentPausedOrEmpty(t: Table, agt: AgentId): boolean {
  return t.pausedWorkspace || t.pausedAgents.has(agt) || !t.agents.has(agt);
}

export async function buildToolIndex(ctx: BridgeContext, router: CallRouter, t: Table, agt: AgentId): Promise<ToolIndex> {
  const tools: ToolDef[] = [];
  const routes = new Map<string, ToolRoute>();
  if (agentPausedOrEmpty(t, agt)) return { rev: t.rev, tools, routes };
  const prefix = `${agtRef(agt)}|`;
  const add = (app: AppRuntime, def: ToolDef, route: ToolRoute) => {
    if (def.name.length > TOOL_NAME_RULE.maxLength || !NAME_RE.test(def.name)) {
      ctx.toolsOmitted.set(`${app.entry.ins}|${def.name}`, { ins: app.entry.ins, name: def.name.slice(0, 120), code: "tool_name_too_long" });
      return;
    }
    if (routes.has(def.name)) {
      ctx.toolsOmitted.set(`${app.entry.ins}|${def.name}`, { ins: app.entry.ins, name: def.name, code: "name_collision" });
      return;
    }
    routes.set(def.name, route);
    tools.push(def);
  };
  const entries = [...t.grants.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
  for (const [, g] of entries) {
    const ins = g.claims.aud.slice(7);
    const app = [...t.apps.values()].find((a) => a.entry.ins === ins);
    if (!app || app.down || t.pausedInstances.has(app.entry.ins)) continue;
    const product = app.entry.product;
    const ops = visibleOps(app, g.claims);
    let any = false;
    for (const op of ops) {
      if (op.standard) continue;
      if (op.dynamic?.mode === "list") {
        let catalog: DynamicCatalogEntry[] = [];
        const omitKey = `${app.entry.ins}|${op.id}`;
        try {
          catalog = await router.catalog(app, op.id);
          if (ctx.toolsOmitted.get(omitKey)?.code === "catalog_failed") ctx.toolsOmitted.delete(omitKey);
        } catch {
          // L3: the op's entries are missing — tell Core (status toolsOmitted), not only the log
          ctx.toolsOmitted.set(omitKey, { ins: app.entry.ins, name: op.id, code: "catalog_failed" });
          ctx.log.warn("bridge.catalog.failed", { ins: app.entry.ins, op: op.id, code: "dynamic_resolve_failed" });
        }
        const ceiling = EFFECTS.indexOf(op.dynamic.effectCeiling);
        for (const e of catalog) {
          if (!subset(e.crud, g.claims.crud) || !subset(e.crud, op.dynamic.crudCeiling) || EFFECTS.indexOf(e.effect) > ceiling) {
            ctx.toolsOmitted.set(`${app.entry.ins}|${e.name}`, { ins: app.entry.ins, name: e.name, code: "ceiling" });
            continue;
          }
          add(app, { name: `${product}__${e.name}`, title: e.title, description: e.description, inputSchema: e.inputSchema, annotations: annotations(e.effect) }, { kind: "dynamic_entry", app, op, entry: e.name });
          any = true;
        }
        continue;
      }
      if (op.dynamic?.mode === "search") {
        add(app, { name: `${product}__${op.id}${TOOL_NAME_RULE.searchSuffix}`, title: `${op.title}: search`, description: `Search the tools of "${op.title}". ${op.description}`, inputSchema: SEARCH_SCHEMA, annotations: { readOnlyHint: true } }, { kind: "dynamic_search", app, op });
        add(app, { name: `${product}__${op.id}${TOOL_NAME_RULE.callSuffix}`, title: `${op.title}: call`, description: `Call one tool found with ${product}__${op.id}${TOOL_NAME_RULE.searchSuffix}. ${op.description}`, inputSchema: CALL_SCHEMA, annotations: annotations(op.dynamic.effectCeiling) }, { kind: "dynamic_call", app, op });
        any = true;
        continue;
      }
      add(app, { name: `${product}__${op.id}`, title: op.title, description: op.description, inputSchema: op.input ?? { type: "object" }, annotations: annotations(op.effect) }, { kind: "op", app, op });
      any = true;
    }
    if (!any) continue;
    const hold = app.ops.get("tb.hold_status");
    if (hold) {
      add(app, { name: `${product}__${TOOL_NAME_RULE.holdStatusOp}`, title: "Hold status", description: `Check a call to ${app.manifest?.name ?? product} that is waiting for the owner's approval. Input: the holdId from the held result.`, inputSchema: HOLD_SCHEMA, annotations: { readOnlyHint: true } }, { kind: "hold_status", app, op: hold });
    }
    add(app, { name: `${product}__${TOOL_NAME_RULE.skillsOp}`, title: "Skills", description: `How to use ${app.manifest?.name ?? product}. Without skillId: the skill index. With skillId: that skill's text.`, inputSchema: SKILLS_SCHEMA, annotations: { readOnlyHint: true } }, { kind: "skills", app });
  }
  return { rev: t.rev, tools, routes };
}

/** Products the agent can reach (for skills resources). */
export function grantedProducts(t: Table, agt: AgentId): Set<string> {
  const out = new Set<string>();
  if (agentPausedOrEmpty(t, agt)) return out;
  for (const [k, g] of t.grants) {
    if (!k.startsWith(`${agtRef(agt)}|`)) continue;
    const app = t.apps.get(g.claims.aud.slice(7) as `ins_${string}`);
    if (app && !t.pausedInstances.has(app.entry.ins)) out.add(app.entry.product);
  }
  return out;
}
