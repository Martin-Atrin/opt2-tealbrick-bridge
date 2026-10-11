import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Draft, DraftSubmitResult, DraftValidation, Recipe } from "@opt2-tealbrick/spec/routes";
import type { Ctx, Handler } from "./ctx.ts";
import { requirePos, table } from "./ctx.ts";
import type { DraftIssue, StepData } from "./draft.ts";
import { checkStep, checkSteps, moveStep, removeStep, withWorkspace } from "./draft.ts";
import { CliError, EXIT, isRecord, usageError } from "./io.ts";
import type { PortalClient } from "./portal.ts";
import type { Session } from "./session.ts";
import { getCurrentDraft, requireSession, resolveWorkspace, setCurrentDraft } from "./session.ts";

/** Drafts, recipes and bulk agent registration (CLI.md sections 3, 3.1, 3.2). */

const DRAFT_ID = /^drf_[A-Za-z0-9]+$/;
const MAX_AGENTS = 64;
const MAX_EDGES = 8;
const CRUD = ["create", "read", "update", "delete"];

function issuesError(issues: DraftIssue[], message: string, extra?: Record<string, unknown>): CliError {
  const exit = issues.some((i) => i.code === "draft_op_not_draftable") ? EXIT.refused : EXIT.validation;
  const code = issues[0]?.code ?? "draft_invalid";
  return new CliError(exit, code, message, { details: { issues, ...extra } });
}

function formatIssues(issues: DraftIssue[]): string {
  return issues.map((i) => `  step ${i.n ?? "-"}: ${i.code}: ${i.message}${i.pointer ? ` (${i.pointer})` : ""}`).join("\n");
}

async function draftIdFor(ctx: Ctx, session: Session, positional: string | undefined): Promise<string> {
  const id = positional ?? ctx.v.draft ?? (await getCurrentDraft(ctx, session.person.portal));
  if (!id) throw usageError("no draft selected; pass a draft id (or --draft) or run draft new first");
  if (!DRAFT_ID.test(id)) throw usageError("draft id must look like drf_…");
  return id;
}

function stepsOf(draft: Draft): StepData[] {
  return (Array.isArray(draft.steps) ? draft.steps : []).map((s) => ({ opId: String(s.opId), input: isRecord(s.input) ? s.input : {} }));
}

async function loadOpenDraft(client: PortalClient, drf: string): Promise<Draft> {
  const draft = await client.call<Draft>("drafts.get", { drf });
  if (draft.state !== "open") throw new CliError(EXIT.conflict, "draft_state", `draft ${drf} is ${draft.state}; only an open draft can be edited`);
  return draft;
}

async function saveSteps(client: PortalClient, draft: Draft, steps: StepData[]): Promise<Draft> {
  return client.call<Draft>("drafts.update", { drf: draft.id, revision: draft.revision, steps });
}

export function parseIndex(raw: string | undefined, what: string, length: number): number {
  const n = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n >= length) throw usageError(`${what} must be a step number from 0 to ${Math.max(length - 1, 0)}`);
  return n;
}

async function readJsonArg(ctx: Ctx, raw: string | undefined, what: string): Promise<unknown> {
  if (raw === undefined) return undefined;
  let text = raw;
  if (raw.startsWith("@")) {
    try {
      text = await readFile(resolve(ctx.cwd(), raw.slice(1)), "utf8");
    } catch {
      throw usageError(`cannot read ${what} file`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(EXIT.validation, "validation_failed", `${what} is not valid JSON`);
  }
}

function describeDraft(d: Draft): string {
  const head = `${d.id}  ${d.title}  [${d.state}, revision ${d.revision}${d.requiresPurchase ? ", requires purchase" : ""}]`;
  const rows = (d.steps ?? []).map((s, i) => [String(i), s.opId, s.effect, s.confirm ? "confirm" : "", s.summary]);
  return rows.length ? `${head}\n${table(rows)}` : head;
}

export const draft: Handler = async (ctx) => {
  const sub = requirePos(ctx, 1, "command (new | add | rm | move | show | list | validate | submit)");
  const session = await requireSession(ctx);
  const { client, person } = session;

  switch (sub) {
    case "new": {
      const title = ctx.v.title;
      if (!title) throw usageError("draft new needs --title <title>");
      const ws = await resolveWorkspace(ctx, client);
      const d = await client.call<Draft>("drafts.create", { ws, title, steps: [] });
      await setCurrentDraft(ctx, person.portal, d.id);
      ctx.emit(d, `${d.id}`);
      return;
    }
    case "add": {
      const opId = requirePos(ctx, 2, "op id");
      const input = await readJsonArg(ctx, ctx.v.input, "--input");
      if (input !== undefined && !isRecord(input)) throw new CliError(EXIT.validation, "validation_failed", "--input must be a JSON object");
      const drf = await draftIdFor(ctx, session, undefined);
      const d = await loadOpenDraft(client, drf);
      const steps = stepsOf(d);
      const step = withWorkspace({ opId, input: (input as Record<string, unknown> | undefined) ?? {} }, d.ws);
      const issues = checkStep(step, steps.length, d.ws);
      if (issues.length) throw issuesError(issues, `step rejected locally:\n${formatIssues(issues)}`);
      const updated = await saveSteps(client, d, [...steps, step]);
      ctx.emit(updated, `added step ${steps.length} (${opId}) to ${updated.id}, revision ${updated.revision}`);
      return;
    }
    case "rm": {
      const drf = await draftIdFor(ctx, session, undefined);
      const d = await loadOpenDraft(client, drf);
      const steps = stepsOf(d);
      const n = parseIndex(ctx.pos[2], "step", steps.length);
      const r = removeStep(steps, n);
      if (r.dangling) {
        throw new CliError(EXIT.validation, "draft_ref_invalid", `step ${r.dangling.step} references step ${n}; remove or change that step first`, {
          details: { issues: [{ n: r.dangling.step, code: "draft_ref_invalid", message: `references removed step ${n}`, pointer: null }] },
        });
      }
      const updated = await saveSteps(client, d, r.steps);
      ctx.emit(updated, `removed step ${n} from ${updated.id}, revision ${updated.revision}`);
      return;
    }
    case "move": {
      const drf = await draftIdFor(ctx, session, undefined);
      const d = await loadOpenDraft(client, drf);
      const steps = stepsOf(d);
      const from = parseIndex(ctx.pos[2], "step", steps.length);
      const to = parseIndex(ctx.pos[3], "target position", steps.length);
      const moved = moveStep(steps, from, to);
      const issues = checkSteps(moved, d.ws);
      if (issues.length) throw issuesError(issues, `move rejected locally:\n${formatIssues(issues)}`);
      const updated = await saveSteps(client, d, moved);
      ctx.emit(updated, `moved step ${from} to ${to} in ${updated.id}, revision ${updated.revision}`);
      return;
    }
    case "show": {
      const d = await client.call<Draft>("drafts.get", { drf: await draftIdFor(ctx, session, ctx.pos[2]) });
      ctx.emit(d, describeDraft(d));
      return;
    }
    case "list": {
      const input: Record<string, unknown> = {};
      if (ctx.g.ws) input.ws = ctx.g.ws;
      if (ctx.v.state !== undefined) input.state = ctx.v.state;
      if (ctx.v.limit !== undefined) input.limit = Number(ctx.v.limit);
      if (ctx.v.cursor !== undefined) input.cursor = ctx.v.cursor;
      const res = await client.call<{ items?: Record<string, unknown>[] }>("drafts.list", input);
      ctx.emit(res, table((res.items ?? []).map((s) => [String(s.id), String(s.state), String(s.stepCount), String(s.title)])));
      return;
    }
    case "validate": {
      const drf = await draftIdFor(ctx, session, ctx.pos[2]);
      const d = await client.call<Draft>("drafts.get", { drf });
      const local = checkSteps(stepsOf(d), d.ws);
      if (local.length) throw issuesError(local, `draft is invalid (local check):\n${formatIssues(local)}`, { revision: d.revision });
      const res = await client.call<DraftValidation>("drafts.validate", { drf });
      if (!res.valid) {
        const issues = res.issues ?? [];
        throw issuesError(issues, `draft is invalid:\n${formatIssues(issues)}`, { revision: res.revision });
      }
      ctx.emit(res, `${drf} is valid (revision ${res.revision})`);
      return;
    }
    case "submit": {
      const drf = await draftIdFor(ctx, session, ctx.pos[2]);
      const res = await client.call<DraftSubmitResult>("drafts.submit", { drf });
      ctx.say("Submitted. Nothing is applied until you review and confirm once in the browser.");
      ctx.emit(res, `${res.id} submitted. Review and apply here:\n${res.reviewUrl}`);
      return;
    }
    default:
      throw usageError(`unknown command: draft ${sub}`);
  }
};

// ───────────────────────────── recipes ─────────────────────────────

export const recipe: Handler = async (ctx) => {
  const sub = requirePos(ctx, 1, "command (export | import)");
  const session = await requireSession(ctx);
  const { client, person } = session;
  if (sub === "export") {
    const drf = await draftIdFor(ctx, session, ctx.pos[2]);
    const rec = await client.call<Recipe>("drafts.export", { drf });
    if (ctx.v.output) {
      const file = resolve(ctx.cwd(), ctx.v.output);
      await writeFile(file, `${JSON.stringify(rec, null, 2)}\n`);
      ctx.emit({ file, steps: rec.steps?.length ?? 0 }, `wrote ${file}`);
    } else {
      ctx.emit(rec, JSON.stringify(rec, null, 2));
    }
    return;
  }
  if (sub === "import") {
    const path = requirePos(ctx, 2, "recipe file");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(resolve(ctx.cwd(), path), "utf8"));
    } catch {
      throw new CliError(EXIT.validation, "validation_failed", "recipe file is missing or not valid JSON");
    }
    if (!isRecord(parsed) || parsed.format !== "tealbrick.recipe/1" || typeof parsed.title !== "string" || !Array.isArray(parsed.steps)) {
      throw new CliError(EXIT.validation, "validation_failed", 'recipe must be {"format":"tealbrick.recipe/1","title":…,"steps":[…]}');
    }
    const issues = checkSteps(parsed.steps, null);
    if (issues.length) throw issuesError(issues, `recipe rejected locally:\n${formatIssues(issues)}`);
    const input: Record<string, unknown> = { recipe: parsed };
    if (ctx.g.ws) input.ws = ctx.g.ws;
    const d = await client.call<Draft>("drafts.import", input);
    await setCurrentDraft(ctx, person.portal, d.id);
    ctx.emit(d, `${d.id} created from the recipe (${d.steps?.length ?? 0} steps)`);
    return;
  }
  throw usageError(`unknown command: recipe ${sub}`);
};

// ───────────────────────────── register agents (J3) ─────────────────────────────

export interface AgentsFile {
  format: "tealbrick.agents/1";
  agents: {
    name: string;
    purpose: string;
    harness: string;
    endpointLabel?: string | null;
    edges?: { product: string; crud: string[] }[];
  }[];
}

/** Structural check of the input file; returns issues (empty = ok). */
export function checkAgentsFile(file: unknown, existingNames: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (!isRecord(file) || file.format !== "tealbrick.agents/1" || !Array.isArray(file.agents)) {
    return ['file must be {"format":"tealbrick.agents/1","agents":[…]}'];
  }
  if (file.agents.length === 0) problems.push("agents is empty");
  if (file.agents.length > MAX_AGENTS) problems.push(`at most ${MAX_AGENTS} agents per file (got ${file.agents.length})`);
  const seen = new Set<string>();
  file.agents.forEach((a: unknown, i: number) => {
    const at = `agents[${i}]`;
    if (!isRecord(a)) {
      problems.push(`${at} must be an object`);
      return;
    }
    if (typeof a.name !== "string" || a.name.trim().length === 0) problems.push(`${at}.name must be a non-empty string`);
    else if (seen.has(a.name)) problems.push(`${at}.name "${a.name}" appears twice in the file`);
    else {
      seen.add(a.name);
      if (existingNames.has(a.name)) problems.push(`${at}.name "${a.name}" already exists in the workspace`);
    }
    if (typeof a.purpose !== "string") problems.push(`${at}.purpose must be a string`);
    if (typeof a.harness !== "string" || a.harness.length === 0) problems.push(`${at}.harness must be a harness option id`);
    if (a.endpointLabel !== undefined && a.endpointLabel !== null && typeof a.endpointLabel !== "string") problems.push(`${at}.endpointLabel must be a string or null`);
    const edges = a.edges ?? [];
    if (!Array.isArray(edges)) {
      problems.push(`${at}.edges must be an array`);
      return;
    }
    if (edges.length > MAX_EDGES) problems.push(`${at} has ${edges.length} edges; at most ${MAX_EDGES}`);
    edges.forEach((e: unknown, j: number) => {
      if (!isRecord(e) || typeof e.product !== "string" || e.product.length === 0) {
        problems.push(`${at}.edges[${j}].product must be a product id`);
      } else if (!Array.isArray(e.crud) || e.crud.length === 0 || !e.crud.every((c: unknown) => typeof c === "string" && CRUD.includes(c))) {
        problems.push(`${at}.edges[${j}].crud must be a non-empty list of ${CRUD.join("|")}`);
      }
    });
  });
  return problems;
}

/** Steps for a checked file: agents.create per agent, then edges.create with a $ref to that agent's output. */
export function buildAgentSteps(file: AgentsFile, ws: string, offset: number): StepData[] {
  const steps: StepData[] = [];
  for (const a of file.agents) {
    const at = offset + steps.length;
    const create: Record<string, unknown> = { ws, name: a.name, purpose: a.purpose, harnessOptionId: a.harness };
    if (typeof a.endpointLabel === "string") create.endpointLabel = a.endpointLabel;
    steps.push({ opId: "agents.create", input: create });
    for (const e of a.edges ?? []) {
      steps.push({ opId: "edges.create", input: { ws, agt: { $ref: `#/steps/${at}/output/id` }, product: e.product, crud: e.crud } });
    }
  }
  return steps;
}

async function existingAgentNames(client: PortalClient, ws: string): Promise<Set<string>> {
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await client.call<{ items?: { name?: string }[]; nextCursor?: string | null }>("agents.list", { ws, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const a of res.items ?? []) if (typeof a.name === "string") names.add(a.name);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return names;
}

export const register: Handler = async (ctx) => {
  if (requirePos(ctx, 1, "command (agents)") !== "agents") throw usageError(`unknown command: register ${ctx.pos[1]}`);
  const path = ctx.v.file;
  if (!path) throw usageError("register agents needs --file <agents.json>");
  if (/\.ya?ml$/i.test(path)) throw new CliError(EXIT.validation, "validation_failed", "YAML input is not supported in this build; convert the file to JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(ctx.cwd(), path), "utf8"));
  } catch {
    throw new CliError(EXIT.validation, "validation_failed", "agents file is missing or not valid JSON");
  }
  const session = await requireSession(ctx);
  const { client, person } = session;
  const ws = await resolveWorkspace(ctx, client);

  let target: Draft | null = null;
  if (ctx.v.draft !== undefined) {
    if (!DRAFT_ID.test(ctx.v.draft)) throw usageError("draft id must look like drf_…");
    target = await loadOpenDraft(client, ctx.v.draft);
    if (target.ws !== null && target.ws !== ws) throw new CliError(EXIT.validation, "draft_invalid", `draft workspace ${target.ws} differs from ${ws}`);
  }

  const problems = checkAgentsFile(parsed, await existingAgentNames(client, ws));
  if (problems.length) {
    throw new CliError(EXIT.validation, "validation_failed", `agents file rejected:\n${problems.map((p) => `  ${p}`).join("\n")}`, { details: { problems } });
  }
  const file = parsed as AgentsFile;

  const existing = target ? stepsOf(target) : [];
  const added = buildAgentSteps(file, ws, existing.length);
  const issues = checkSteps([...existing, ...added], ws);
  if (issues.length) throw issuesError(issues, `generated steps rejected locally:\n${formatIssues(issues)}`);

  const d = target
    ? await saveSteps(client, target, [...existing, ...added])
    : await client.call<Draft>("drafts.create", { ws, title: ctx.v.title ?? "Register agents", steps: added });
  await setCurrentDraft(ctx, person.portal, d.id);
  ctx.emit(
    { draft: d, agents: file.agents.length, steps: added.length },
    `${d.id}: ${file.agents.length} agent(s), ${added.length} step(s) added. Submit with: tealbrick draft submit`,
  );
};
