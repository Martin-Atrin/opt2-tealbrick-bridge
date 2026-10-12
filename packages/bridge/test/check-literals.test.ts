// The literal guard must still catch internal names after the denylist moved out of git:
// generic patterns always, and any name from the local extra list (TB_EXTRA_DENY / .env.denylist).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = new URL('../../../scripts/check-literals.ts', import.meta.url).pathname;
// Built at runtime so no network identifier sits in this file.
const tailnetId = 'tail' + 'd' + '1a2b3c';
const tailnetIp = ['100', '101', '2', '3'].join('.');
const plantedHost = 'zork' + '-host';

function run(content: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tb-literals-'));
  try {
    mkdirSync(join(dir, 'packages', 'x'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'x', 'a.ts'), content);
    const base = { ...process.env, TB_EXTRA_DENY: '', TB_DENYLIST_FILE: join(dir, 'none.env') };
    return spawnSync(process.execPath, [script], { cwd: dir, env: { ...base, ...env }, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('clean tree passes', () => {
  assert.equal(run('export const a = 1;\n').status, 0);
});

test('tailnet id, host name and tailnet IP are caught without any local list', () => {
  for (const bad of [`const u = "${tailnetId}";`, 'const u = "box.example.ts' + '.net";', `const ip = "${tailnetIp}";`]) {
    const r = run(bad + '\n');
    assert.equal(r.status, 1, bad);
  }
});

test('a name from the local extra list is caught; without the list it is not', () => {
  const src = `const h = "${plantedHost}";\n`;
  assert.equal(run(src).status, 0);
  const r = run(src, { TB_EXTRA_DENY: `other, ${plantedHost}` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /internal name/);
});

test('a name from the local denylist file is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-denylist-'));
  try {
    const file = join(dir, 'denylist.env');
    writeFileSync(file, `TB_EXTRA_DENY=${plantedHost}\n`);
    assert.equal(run(`const h = "${plantedHost}";\n`, { TB_DENYLIST_FILE: file }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
