'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');

const SCRIPT = path.join(SCRIPTS_DIR, 'freeze_done.js');

test('freezes draft into done.md + done.approved.md + additions file', () => {
  const dir = mkTmpDir('tl-freeze');
  try {
    fs.writeFileSync(path.join(dir, 'done.draft.md'), '# Done — T-1\n');
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'done.draft.md')));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'done.md'), 'utf8'), '# Done — T-1\n');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'done.approved.md'), 'utf8'), '# Done — T-1\n');
    assert.ok(fs.existsSync(path.join(dir, 'done-additions.md')));
  } finally {
    rmDir(dir);
  }
});

test('refuses to freeze twice', () => {
  const dir = mkTmpDir('tl-freeze');
  try {
    fs.writeFileSync(path.join(dir, 'done.draft.md'), 'v1\n');
    runScript(SCRIPT, [dir]);
    fs.writeFileSync(path.join(dir, 'done.draft.md'), 'v2 — goalpost move\n');
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('already frozen'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'done.md'), 'utf8'), 'v1\n');
  } finally {
    rmDir(dir);
  }
});

test('missing draft fails', () => {
  const dir = mkTmpDir('tl-freeze');
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('missing'));
  } finally {
    rmDir(dir);
  }
});
