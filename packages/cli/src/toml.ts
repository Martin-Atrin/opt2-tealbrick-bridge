/**
 * Minimal TOML handling for `connect codex --write`: a structural sanity scan (no full parser exists in
 * the Node standard library) and replace-or-append of exactly one table, `[mcp_servers.tealbrick]`.
 */

interface Stmt {
  kind: "header" | "kv";
  line: number;
  /** Header: the table path. Key/value: the table path + the key path. */
  path: string[];
  array: boolean;
  /** Key/value only: the table the key sits in. */
  table: string[];
}

export class TomlError extends Error {}

function splitKey(src: string, lineNo: number): string[] {
  const parts: string[] = [];
  let i = 0;
  const s = src.trim();
  while (i < s.length) {
    while (s[i] === " " || s[i] === "\t") i++;
    const c = s[i];
    if (c === '"' || c === "'") {
      const close = s.indexOf(c, i + 1);
      if (close < 0) throw new TomlError(`line ${lineNo}: unterminated quoted key`);
      parts.push(s.slice(i + 1, close));
      i = close + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) throw new TomlError(`line ${lineNo}: invalid key`);
      parts.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === " " || s[i] === "\t") i++;
    if (i < s.length) {
      if (s[i] !== ".") throw new TomlError(`line ${lineNo}: invalid key`);
      i++;
    }
  }
  if (parts.length === 0) throw new TomlError(`line ${lineNo}: empty key`);
  return parts;
}

interface ValueState {
  multi: string | null;
  depth: number;
}

/** Walk the value text of one line; keeps multi-line string and bracket state across lines. */
function scanValue(text: string, st: ValueState, lineNo: number): void {
  let i = 0;
  while (i < text.length) {
    if (st.multi) {
      const end = text.indexOf(st.multi, i);
      if (end < 0) return;
      i = end + 3;
      st.multi = null;
      continue;
    }
    const c = text[i] as string;
    if (c === "#") return;
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      st.multi = text.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= text.length) throw new TomlError(`line ${lineNo}: unterminated string`);
        if (text[i] === "\\") i += 2;
        else if (text[i] === '"') break;
        else i++;
      }
      i++;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) throw new TomlError(`line ${lineNo}: unterminated string`);
      i = close + 1;
      continue;
    }
    if (c === "[" || c === "{") st.depth++;
    if (c === "]" || c === "}") {
      st.depth--;
      if (st.depth < 0) throw new TomlError(`line ${lineNo}: unbalanced bracket`);
    }
    i++;
  }
}

export function scanToml(text: string): Stmt[] {
  const stmts: Stmt[] = [];
  const rows = text.split(/\r?\n/);
  let table: string[] = [];
  const st: ValueState = { multi: null, depth: 0 };
  for (let n = 0; n < rows.length; n++) {
    const raw = rows[n] as string;
    const lineNo = n + 1;
    if (st.multi || st.depth > 0) {
      scanValue(raw, st, lineNo);
      continue;
    }
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const m = /^\[(\[)?\s*(.+?)\s*\](\])?\s*(#.*)?$/.exec(line);
      if (!m || Boolean(m[1]) !== Boolean(m[3])) throw new TomlError(`line ${lineNo}: invalid table header`);
      table = splitKey(m[2] as string, lineNo);
      stmts.push({ kind: "header", line: n, path: table, array: Boolean(m[1]), table: [] });
      continue;
    }
    // key = value; find the '=' outside quotes
    let eq = -1;
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i] as string;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "=") {
        eq = i;
        break;
      }
    }
    if (eq < 0) throw new TomlError(`line ${lineNo}: expected key = value`);
    const key = splitKey(line.slice(0, eq), lineNo);
    const value = line.slice(eq + 1).trim();
    if (value === "" || value.startsWith("#")) throw new TomlError(`line ${lineNo}: missing value`);
    scanValue(value, st, lineNo);
    stmts.push({ kind: "kv", line: n, path: [...table, ...key], array: false, table });
  }
  if (st.multi || st.depth > 0) throw new TomlError("unterminated string or array at end of file");
  return stmts;
}

const TABLE = ["mcp_servers", "tealbrick"];
const startsWith = (path: string[], prefix: string[]): boolean => prefix.every((p, i) => path[i] === p);
const sameLength = (path: string[], other: string[]): boolean => path.length === other.length && startsWith(path, other);

/** Replace `[mcp_servers.tealbrick]` with `bodyLines`, or append it. Throws TomlError when it cannot be done cleanly. */
export function upsertMcpTable(text: string, bodyLines: string[]): string {
  const stmts = scanToml(text);
  const headers = stmts.filter((s) => s.kind === "header");
  const main = headers.filter((h) => !h.array && sameLength(h.path, TABLE));
  for (const s of stmts) {
    if (s.kind === "header" && s.array && startsWith(s.path, TABLE)) throw new TomlError("an array of tables named mcp_servers.tealbrick exists");
    if (s.kind === "header" && !s.array && startsWith(s.path, TABLE) && s.path.length > TABLE.length) {
      throw new TomlError(`a sub-table [${s.path.join(".")}] exists; edit it by hand`);
    }
    if (s.kind === "kv" && startsWith(s.path, TABLE) && !startsWith(s.table, TABLE)) {
      throw new TomlError("mcp_servers.tealbrick is defined with dotted or inline keys; edit it by hand");
    }
    if (s.kind === "kv" && s.table.length === 0 && s.path[0] === "mcp_servers") {
      throw new TomlError("mcp_servers is defined with dotted or inline keys at the top level; edit it by hand");
    }
    if (s.kind === "kv" && sameLength(s.table, ["mcp_servers"]) && s.path[1] === "tealbrick") {
      throw new TomlError("mcp_servers.tealbrick is defined inside [mcp_servers]; edit it by hand");
    }
  }
  if (main.length > 1) throw new TomlError("[mcp_servers.tealbrick] appears more than once");

  const rows = text.length === 0 ? [] : text.split("\n");
  const header = ["[mcp_servers.tealbrick]", ...bodyLines];
  const found = main[0];
  if (!found) {
    const base = text.length === 0 ? [] : text.endsWith("\n") ? rows.slice(0, -1) : rows;
    const sep = base.length > 0 && base[base.length - 1]?.trim() !== "" ? [""] : [];
    return `${[...base, ...sep, ...header].join("\n")}\n`;
  }
  const next = headers.find((h) => h.line > found.line);
  const sectionEnd = next ? next.line : rows.length;
  let bodyEnd = sectionEnd;
  while (bodyEnd > found.line + 1 && (rows[bodyEnd - 1] ?? "").trim() === "") bodyEnd--;
  const out = [...rows.slice(0, found.line), ...header, ...rows.slice(bodyEnd)];
  const joined = out.join("\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

export function tomlString(s: string): string {
  return JSON.stringify(s);
}
