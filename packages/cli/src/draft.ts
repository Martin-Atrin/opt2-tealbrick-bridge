import { isRecord } from "./io.ts";
import { isDraftableOp, routeRow } from "./portal.ts";

/** Local draft validation (CLI.md section 3.1) and step edits. Core stays authoritative. */

export interface StepData {
  opId: string;
  input: Record<string, unknown>;
}

export interface DraftIssue {
  n: number | null;
  code: string;
  message: string;
  pointer: string | null;
}

const REF_RE = /^#\/steps\/(0|[1-9][0-9]*)\/output((?:\/(?:[^~/]|~[01])*)*)$/;
const SECRET_KEY = /^(token|secret|password|passphrase|private_?key|api_?key|access_token|refresh_token|device_code|user_code|code|ticket|session_token)$/i;

export interface RefInfo {
  pointer: string;
  ref: string;
  step: number;
}

/** Collect every `{"$ref": …}` object of a value, reporting malformed ones as issues. */
function walk(value: unknown, pointer: string, found: RefInfo[], bad: { pointer: string; message: string }[]): void {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walk(v, `${pointer}/${i}`, found, bad);
    return;
  }
  if (!isRecord(value)) return;
  if ("$ref" in value) {
    const keys = Object.keys(value);
    const ref = value.$ref;
    if (keys.length !== 1) {
      bad.push({ pointer, message: "a $ref object must have no other keys" });
    } else if (typeof ref !== "string") {
      bad.push({ pointer, message: "$ref must be a string" });
    } else {
      const m = REF_RE.exec(ref);
      if (!m) {
        bad.push({ pointer, message: '$ref must look like "#/steps/<n>/output/<pointer>"' });
      } else {
        found.push({ pointer, ref, step: Number(m[1]) });
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) walk(v, `${pointer}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`, found, bad);
}

export function collectRefs(input: unknown): { refs: RefInfo[]; bad: { pointer: string; message: string }[] } {
  const refs: RefInfo[] = [];
  const bad: { pointer: string; message: string }[] = [];
  walk(input, "", refs, bad);
  return { refs, bad };
}

/** Check one step at position `index` of a draft whose workspace is `ws` (null = unknown). */
export function checkStep(step: unknown, index: number, ws: string | null): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const add = (code: string, message: string, pointer: string | null) => issues.push({ n: index, code, message, pointer });
  if (!isRecord(step) || typeof step.opId !== "string" || !isRecord(step.input)) {
    add("draft_invalid", "a step needs opId (string) and input (object)", null);
    return issues;
  }
  const opId = step.opId;
  const input = step.input;
  let known = true;
  try {
    routeRow(opId);
  } catch {
    known = false;
  }
  if (!known) {
    add("draft_invalid", `unknown op ${opId}`, "/opId");
    return issues;
  }
  if (!isDraftableOp(opId)) add("draft_op_not_draftable", `${opId} is not a draftable op`, "/opId");

  for (const key of Object.keys(input)) {
    if (SECRET_KEY.test(key)) add("draft_invalid", `step input must not carry a secret field (${key})`, `/input/${key}`);
  }
  const { refs, bad } = collectRefs(input);
  for (const b of bad) add("draft_ref_invalid", b.message, `/input${b.pointer}`);
  for (const r of refs) {
    if (r.step >= index) add("draft_ref_invalid", `$ref points to step ${r.step}, which is not an earlier step`, `/input${r.pointer}/$ref`);
  }
  if ("ws" in input) {
    const v = input.ws;
    if (typeof v !== "string") add("draft_invalid", "ws must be a plain workspace id", "/input/ws");
    else if (ws !== null && v !== ws) add("draft_invalid", `ws ${v} differs from the draft workspace ${ws}`, "/input/ws");
  }
  return issues;
}

export function checkSteps(steps: readonly unknown[], ws: string | null): DraftIssue[] {
  return steps.flatMap((s, i) => checkStep(s, i, ws));
}

/** Add `ws` from the draft when the op's path needs it and the input has none. */
export function withWorkspace(step: StepData, ws: string | null): StepData {
  if (ws === null || "ws" in step.input) return step;
  let needs = false;
  try {
    needs = routeRow(step.opId).path.includes("{ws}");
  } catch {
    needs = false;
  }
  return needs ? { opId: step.opId, input: { ws, ...step.input } } : step;
}

/** Rewrite every `$ref` step number through `map` (null = the target is gone). Returns the first dangling ref. */
export function renumberRefs(
  steps: readonly StepData[],
  map: (oldIndex: number) => number | null,
): { steps: StepData[]; dangling: { step: number; target: number } | null } {
  let dangling: { step: number; target: number } | null = null;
  const rewrite = (value: unknown, stepIndex: number): unknown => {
    if (Array.isArray(value)) return value.map((v) => rewrite(v, stepIndex));
    if (!isRecord(value)) return value;
    if (typeof value.$ref === "string" && Object.keys(value).length === 1) {
      const m = REF_RE.exec(value.$ref);
      if (!m) return value;
      const target = Number(m[1]);
      const next = map(target);
      if (next === null) {
        dangling ??= { step: stepIndex, target };
        return value;
      }
      return { $ref: `#/steps/${next}/output${m[2] ?? ""}` };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, stepIndex);
    return out;
  };
  const out = steps.map((s, i) => ({ opId: s.opId, input: rewrite(s.input, i) as Record<string, unknown> }));
  return { steps: out, dangling };
}

export function removeStep(steps: readonly StepData[], n: number): { steps: StepData[]; dangling: { step: number; target: number } | null } {
  const kept = steps.filter((_s, i) => i !== n);
  const r = renumberRefs(kept, (old) => (old === n ? null : old > n ? old - 1 : old));
  // dangling.step is an index in the kept list; report it in the original numbering
  if (r.dangling) r.dangling = { step: r.dangling.step >= n ? r.dangling.step + 1 : r.dangling.step, target: r.dangling.target };
  return r;
}

export function moveStep(steps: readonly StepData[], from: number, to: number): StepData[] {
  const order = steps.map((_s, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved as number);
  const newIndexOf = new Map(order.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  const moved2 = order.map((oldIdx) => steps[oldIdx] as StepData);
  return renumberRefs(moved2, (old) => newIndexOf.get(old) ?? null).steps;
}
