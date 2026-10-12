import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';

test('version - VERSION comes from package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, process.env.APP_VERSION || pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});
