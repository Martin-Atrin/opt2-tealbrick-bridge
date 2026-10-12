/**
 * C45: run the REAL conformance suite against the real builds of this repo.
 *   - bridge: `tb-conformance bridge --cmd "node packages/bridge-server/dist/server.js"` (the suite starts the process
 *     with its own fake Portal, apps and agents)
 *   - relay:  `tb-conformance relay` with the real CLI (`tealbrick bridge serve --stdio`, `tealbrick agent login`)
 * Fails on any failing check, except the exact waivers in scripts/conformance-waivers.json (id + status).
 * Requires `npm run build` first. Reports go to .tb-ci/conformance/ (git-ignored).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Check {
  id: string;
  status: string;
  asserted: string;
  ms?: number;
}
interface Report {
  ok: boolean;
  notes?: string[];
  checks: Check[];
  payloadScan?: { findings: string[] };
}
interface Waiver {
  target: string;
  id: string;
  status: string;
  /** optional: the waiver applies only when the observed text matches (environment waivers) */
  assertedMatch?: string;
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = fileURLToPath(import.meta.resolve("@opt2-tealbrick/conformance").replace(/index\.js$/, "cli.js"));
const out = join(root, ".tb-ci", "conformance");
mkdirSync(out, { recursive: true });
const waivers = (JSON.parse(readFileSync(join(root, "scripts", "conformance-waivers.json"), "utf8")) as { waivers: Waiver[] }).waivers;
const FAILING = new Set(["fail", "not_run", "not_implemented"]);
const node = process.execPath;
const server = join(root, "packages", "bridge-server", "dist", "server.js");
const tealbrick = join(root, "packages", "cli", "dist", "main.js");

function run(target: string, args: string[], env: NodeJS.ProcessEnv = process.env): Report {
  const base = join(out, target);
  const r = spawnSync(node, [cli, target, ...args, "--report", base], { stdio: ["ignore", "ignore", "inherit"], env, cwd: root });
  if (r.error) throw r.error;
  return JSON.parse(readFileSync(`${base}.json`, "utf8")) as Report;
}

function judge(target: string, rep: Report): string[] {
  const problems: string[] = [];
  for (const c of rep.checks) {
    if (!FAILING.has(c.status)) continue;
    const w = waivers.find((x) => x.target === target && x.id === c.id && x.status === c.status && (!x.assertedMatch || new RegExp(x.assertedMatch).test(c.asserted)));
    if (w) {
      console.log(`${target}: WAIVED ${c.id} (${c.status}) — see scripts/conformance-waivers.json`);
      continue;
    }
    problems.push(`${target}: ${c.status} ${c.id} — ${c.asserted.slice(0, 300)}`);
  }
  for (const f of rep.payloadScan?.findings ?? []) problems.push(`${target}: payload scan finding ${f}`);
  if (problems.length) {
    for (const n of rep.notes ?? []) console.error(`${target} note: ${n.slice(0, 600)}`);
    for (const c of rep.checks) console.error(`${target} timing: ${c.id} ${c.status} ${c.ms ?? "?"} ms`);
  }
  const counts = rep.checks.reduce<Record<string, number>>((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {});
  console.log(`${target}: ${JSON.stringify(counts)}`);
  return problems;
}

const problems: string[] = [];
problems.push(...judge("bridge", run("bridge", ["--cmd", `"${node}" "${server}"`, "--timeout", "15000"])));

const home = mkdtempSync(join(tmpdir(), "tb-relay-conf-"));
try {
  const relayEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TB_CREDENTIAL_STORE: "file" };
  problems.push(
    ...judge(
      "relay",
      run("relay", ["--cmd", `"${node}" "${tealbrick}" bridge serve --stdio`, "--login-cmd", `"${node}" "${tealbrick}" agent login --create --harness generic --label conformance`, "--timeout", "15000"], relayEnv),
    ),
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`conformance: ${problems.length} failing check(s); reports in .tb-ci/conformance/`);
  process.exit(1);
}
console.log("conformance: bridge + relay pass (waivers listed above, if any)");
