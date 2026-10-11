import { test } from 'node:test';
import assert from 'node:assert/strict';
import { role } from '../src/index.ts';

test('bridge-server scaffold exports its role', () => {
  assert.equal(typeof role, 'string');
});
