/**
 * C62: untrusted JSON is depth-checked before anything recursive (JCS digest, schema validation, redact) sees it.
 * The manifest digest recurses per level, so a 10 000-deep body overflowed the stack on smaller stacks (CI) → 500.
 */
export const MAX_JSON_DEPTH = 128;

/** Iterative: true when `value` nests deeper than `max` arrays/objects. */
export function tooDeep(value: unknown, max = MAX_JSON_DEPTH): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop() as [unknown, number];
    if (v === null || typeof v !== "object") continue;
    if (d >= max) return true;
    for (const c of Array.isArray(v) ? v : Object.values(v)) if (c !== null && typeof c === "object") stack.push([c, d + 1]);
  }
  return false;
}

/** JSON-RPC 2.0 §4: a request id is a string, a number or null. Bounded so it is safe to echo. */
export function validRpcId(id: unknown): boolean {
  return id === undefined || id === null || (typeof id === "string" && id.length <= 256) || (typeof id === "number" && Number.isFinite(id));
}
