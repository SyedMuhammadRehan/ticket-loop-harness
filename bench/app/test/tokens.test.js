'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { issue, verify, SESSION_TTL_MS } = require('../src/auth/tokens.js');

const SECRET = 'test-secret';
const NOW = 1_700_000_000_000;

test('a fresh token verifies as the user it was issued to', () => {
  assert.strictEqual(verify(SECRET, issue(SECRET, 'u42', NOW), NOW + 1000), 'u42');
});

test('a token stops verifying when its lifetime is up', () => {
  const token = issue(SECRET, 'u42', NOW);
  assert.strictEqual(verify(SECRET, token, NOW + SESSION_TTL_MS - 1), 'u42');
  assert.strictEqual(verify(SECRET, token, NOW + SESSION_TTL_MS), null);
});

test('a token signed with another secret, or altered, does not verify', () => {
  const token = issue(SECRET, 'u42', NOW);
  assert.strictEqual(verify('other-secret', token, NOW), null);
  const [user, expires, sig] = token.split('.');
  assert.strictEqual(verify(SECRET, `admin.${expires}.${sig}`, NOW), null);
  assert.strictEqual(verify(SECRET, `${user}.${Number(expires) + 1}.${sig}`, NOW), null);
});

test('malformed tokens are refused, never thrown on', () => {
  for (const bad of [undefined, '', 'a.b', 'a.b.c.d', 'u42.notanumber.sig']) {
    assert.strictEqual(verify(SECRET, bad, NOW), null, String(bad));
  }
});
