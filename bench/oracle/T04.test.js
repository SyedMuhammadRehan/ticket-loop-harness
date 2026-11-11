'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = process.env.DEPOT_ROOT;
const { issue, verify } = require(path.join(ROOT, 'src', 'auth', 'tokens.js'));

const SECRET = 'oracle-secret';
const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

test('a token is valid for eight hours', () => {
  const token = issue(SECRET, 'u7', NOW);
  assert.strictEqual(verify(SECRET, token, NOW + 2 * HOUR), 'u7');
  assert.strictEqual(verify(SECRET, token, NOW + 8 * HOUR - 1), 'u7');
});

test('it stops being valid at exactly eight hours', () => {
  const token = issue(SECRET, 'u7', NOW);
  assert.strictEqual(verify(SECRET, token, NOW + 8 * HOUR), null);
  assert.strictEqual(verify(SECRET, token, NOW + 9 * HOUR), null);
});

test('nothing else about tokens changed', () => {
  const token = issue(SECRET, 'u7', NOW);
  assert.match(token, /^u7\.\d+\.[0-9a-f]{64}$/);
  assert.strictEqual(verify('another-secret', token, NOW), null);
  const [user, expires, sig] = token.split('.');
  assert.strictEqual(verify(SECRET, `${user}.${Number(expires) + HOUR}.${sig}`, NOW), null, 'a lifetime cannot be extended by editing the token');
  assert.strictEqual(verify(SECRET, 'garbage', NOW), null);
});
