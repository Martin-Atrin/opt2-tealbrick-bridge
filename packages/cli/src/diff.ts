/** Small unified-style line diff for `connect --write` previews (stderr). */

type Op = { t: " " | "-" | "+"; line: string };

function lines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [...a.map((line) => ({ t: "-" as const, line })), ...b.map((line) => ({ t: "+" as const, line }))];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? (dp[(i + 1) * w + j + 1] as number) + 1 : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] as string });
      i++;
      j++;
    } else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) {
      ops.push({ t: "-", line: a[i++] as string });
    } else {
      ops.push({ t: "+", line: b[j++] as string });
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++] as string });
  while (j < m) ops.push({ t: "+", line: b[j++] as string });
  return ops;
}

export function unifiedDiff(oldText: string, newText: string, name: string, context = 3): string {
  const ops = diffOps(lines(oldText), lines(newText));
  const out = [`--- ${name}`, `+++ ${name} (proposed)`];
  const changed: number[] = [];
  ops.forEach((o, i) => {
    if (o.t !== " ") changed.push(i);
  });
  if (changed.length === 0) return out.join("\n");
  let k = 0;
  while (k < changed.length) {
    let start = Math.max((changed[k] as number) - context, 0);
    let end = Math.min((changed[k] as number) + context + 1, ops.length);
    k++;
    while (k < changed.length && (changed[k] as number) - context <= end) {
      end = Math.min((changed[k] as number) + context + 1, ops.length);
      k++;
    }
    start = Math.max(start, 0);
    let oldLine = 1;
    let newLine = 1;
    for (let i = 0; i < start; i++) {
      if (ops[i]?.t !== "+") oldLine++;
      if (ops[i]?.t !== "-") newLine++;
    }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((o) => o.t !== "+").length;
    const newCount = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
  }
  return out.join("\n");
}
