import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

test('hardhat installs tolerate historical package engine constraints', () => {
  assert.match(source, /execCommand\("yarn", \["install", "--ignore-engines"\]/);
  assert.match(source, /execCommand\("npm", \["install", "--engine-strict=false"\]/);
});
