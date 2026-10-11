/**
 * Guard against names that must not come back in v2 (PRD §13; PACKAGES-REPORT fault #2):
 * old product/org names, legacy headers and audiences, and product names inside the generic bridge.
 * The bridge routes any manifest app; it never names one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const banned: Array<[RegExp, string]> = [
  [/doppel/i, 'old product name'],
  [/kybernesis/i, 'old platform name'],
  [/\bhdda\b/i, 'old desktop idea'],
  [/x-eve-|\/eve\/v1|eve:<|['"`]eve:/i, 'Eve-era wire name'],
  [/marketplace_execute|tbkg_|tbag_/, 'v1 compat credential or operation'],
  [/portal\.tealbrick\.com/, 'hard-coded v1 production host'],
  [/taild2144d|\bfoxy\b|\bneuu\b|fed-main/i, 'home infrastructure name'],
];
// Product names may appear in harness docs, never in bridge code paths.
const productInCore = /\b(knowledge|connect|gbrain|composio)\b/i;

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
