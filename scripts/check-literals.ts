/**
 * Guard against names that must not come back in v2 (PRD §13; PACKAGES-REPORT fault #2):
 * old product/org names, legacy headers and audiences, and product names inside the generic bridge.
 * The bridge routes any manifest app; it never names one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Internal host names never sit in git. Extra forbidden names come from TB_EXTRA_DENY (comma list) and from
 * the git-ignored `.env.denylist` (or ~/.config/opt2-tealbrick/denylist.env, or $TB_DENYLIST_FILE): line `TB_EXTRA_DENY=a,b`.
 */
const extraDeny = (): RegExp[] => {
  const files = process.env.TB_DENYLIST_FILE ? [process.env.TB_DENYLIST_FILE] : ['.env.denylist', join(homedir(), '.config', 'opt2-tealbrick', 'denylist.env')];
  const lists = [process.env.TB_EXTRA_DENY ?? ''];
  for (const f of files) if (existsSync(f)) lists.push(/^TB_EXTRA_DENY=(.*)$/m.exec(readFileSync(f, 'utf8'))?.[1] ?? '');
  return lists.flatMap((l) => l.split(',')).map((w) => w.trim()).filter(Boolean)
    .map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
};

const banned: Array<[RegExp, string]> = [
  [/doppel/i, 'old product name'],
  [/kybernesis/i, 'old platform name'],
  [/\bhdda\b/i, 'old desktop idea'],
  [/x-eve-|\/eve\/v1|eve:<|['"`]eve:/i, 'Eve-era wire name'],
  [/marketplace_execute|tbkg_|tbag_/, 'v1 compat credential or operation'],
  [/portal\.tealbrick\.com/, 'hard-coded v1 production host'],
  [/taild[0-9a-f]{4,}|\.ts\.net\b/i, 'tailnet id or host name'],
  [/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/, 'tailnet IP'],
  ...extraDeny().map((re): [RegExp, string] => [re, 'internal name (local denylist)']),
];
// Product names may appear in harness docs, never in bridge code paths.
// (quoted product ids, upstream engine names; "connect" as an English verb is fine)
const productInCore = /["'`](knowledge|connect)["'`]|\b(gbrain|composio|open.?notebook|hindsight)\b/i;

const roots = ['packages'];
const problems: string[] = [];
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (!/\.(ts|tsx|json|md)$/.test(name)) continue;
    const text = readFileSync(path, 'utf8');
    for (const [re, why] of banned) if (re.test(text)) problems.push(`${path}: ${why} (${re})`);
    if (path.startsWith(join('packages', 'bridge', 'src')) && productInCore.test(text)) problems.push(`${path}: product name in bridge core`);
  }
};
for (const root of roots) walk(root);
if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log('check-literals: ok');
