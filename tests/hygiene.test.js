'use strict';
// A green suite proves nothing about a stray console.log or a committed credential, so the stop
// gate checks the diff as well as the exit code. These cases are the ones that decide whether
// the check is worth having: what it catches, and what it must not.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { HOOKS_DIR } = require('./helpers.js');

const { scanDiff, addedLines } = require(path.join(HOOKS_DIR, 'hygiene.js'));

function diff(file, added, removed = []) {
  const body = [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n');
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${removed.length || 1} +1,${added.length} @@\n${body}`;
}

test('a console.log on an added line is reported', () => {
  const found = scanDiff(diff('src/app.js', ['console.log("here");']));
  assert.strictEqual(found.length, 1, JSON.stringify(found));
  assert.strictEqual(found[0].kind, 'debug');
  assert.strictEqual(found[0].file, 'src/app.js');
});

test('a debugger statement on an added line is reported', () => {
  const found = scanDiff(diff('src/app.js', ['  debugger;']));
  assert.strictEqual(found.length, 1, JSON.stringify(found));
  assert.strictEqual(found[0].kind, 'debug');
});

// The whole point of reading the diff rather than the file: reformatting a file that already
// had logging must not blame the change that reformatted it.
test('pre-existing logging on an untouched line is not reported', () => {
  const unified =
    'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n' +
    '@@ -1,3 +1,3 @@\n console.log("old");\n-const a = 1\n+const a = 1;\n';
  assert.deepStrictEqual(scanDiff(unified), []);
});

test('a removed console.log is not reported', () => {
  const found = scanDiff(diff('src/app.js', ['const a = 1;'], ['console.log("gone");']));
  assert.deepStrictEqual(found, []);
});

test('a credential-shaped assignment is reported, without echoing the value', () => {
  const found = scanDiff(diff('src/auth.js', ['const apiKey = "sk-live-9f2a7c41b8";']));
  assert.strictEqual(found.length, 1, JSON.stringify(found));
  assert.strictEqual(found[0].kind, 'secret');
  assert.ok(found[0].text.includes('<redacted>'), found[0].text);
  assert.ok(!found[0].text.includes('sk-live-9f2a7c41b8'), 'the value was echoed back into the session');
});

// Fixtures need credential-shaped strings to test credential handling.
test('a credential-shaped assignment in a test file is not reported', () => {
  for (const file of ['tests/auth.test.js', 'e2e/login.spec.js', 'src/__tests__/token.js']) {
    assert.deepStrictEqual(scanDiff(diff(file, ['const password = "hunter2hunter2";'])), [], file);
  }
});

test('an obvious placeholder is not reported as a secret', () => {
  for (const value of ['xxxxxxxxxxxx', 'change-me-please', 'your-token-here', '${TOKEN_FROM_ENV}']) {
    assert.deepStrictEqual(scanDiff(diff('src/config.js', [`const token = "${value}";`])), [], value);
  }
});

test('a short value is not reported as a secret', () => {
  assert.deepStrictEqual(scanDiff(diff('src/config.js', ['const token = "abc";'])), []);
});

test('the extensions filter bounds which files are scanned', () => {
  const unified = diff('docs/notes.md', ['console.log("in prose");']);
  assert.strictEqual(scanDiff(unified).length, 1, 'unfiltered, every added line is in scope');
  assert.deepStrictEqual(scanDiff(unified, { extensions: ['.js'] }), []);
});

test('added lines carry the new-file line number', () => {
  const unified =
    'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n' +
    '@@ -10,2 +10,3 @@\n const a = 1;\n+console.log("two");\n const b = 2;\n';
  const found = scanDiff(unified);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].line, 11);
});

test('a new file is scanned and a deleted file contributes nothing', () => {
  const created =
    'diff --git a/src/new.js b/src/new.js\n--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1,1 @@\n+console.log("new");\n';
  assert.strictEqual(scanDiff(created).length, 1);
  const deleted =
    'diff --git a/src/old.js b/src/old.js\n--- a/src/old.js\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-console.log("old");\n';
  assert.deepStrictEqual(scanDiff(deleted), []);
});

test('malformed or empty input yields nothing rather than throwing', () => {
  for (const input of ['', null, undefined, 'not a diff at all', '@@ garbage @@\n+console.log("x");']) {
    assert.deepStrictEqual(scanDiff(input), [], JSON.stringify(input));
  }
  assert.deepStrictEqual(addedLines(null), []);
});
