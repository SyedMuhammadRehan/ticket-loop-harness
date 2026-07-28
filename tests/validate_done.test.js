'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');

const SCRIPT = path.join(SCRIPTS_DIR, 'validate_done.js');

const VALID_DRAFT = `# Done — T-1
## Criteria
- [ ] C1 (test): repo maps 404 | run: pytest tests/test_repo.py
- [ ] C2 (analyzer): zero analyzer errors | run: ruff check .
- [ ] C3 (manual): eyeball the empty state
## Tokens
- errorColor: #B00020 (source: design-spec.md#colors)
## Out of scope
- offline banner
`;

function writeDraft(content) {
  const dir = mkTmpDir('tl-done');
  fs.writeFileSync(path.join(dir, 'done.draft.md'), content);
  return dir;
}

test('valid draft passes', () => {
  const dir = writeDraft(VALID_DRAFT);
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 0, res.stderr);
  } finally {
    rmDir(dir);
  }
});

test('fewer than 2 non-manual criteria fails', () => {
  const dir = writeDraft(VALID_DRAFT.replace('- [ ] C2 (analyzer): zero analyzer errors | run: ruff check .\n', ''));
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('need >=2 non-manual'));
  } finally {
    rmDir(dir);
  }
});

test('non-manual criterion without a run: command fails', () => {
  const dir = writeDraft(VALID_DRAFT.replace(' | run: pytest tests/test_repo.py', ''));
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('missing "| run:"'));
  } finally {
    rmDir(dir);
  }
});

test('more than one manual criterion fails', () => {
  const dir = writeDraft(VALID_DRAFT.replace('## Tokens', '- [ ] C4 (manual): second eyeball\n## Tokens'));
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('max 1 manual'));
  } finally {
    rmDir(dir);
  }
});

test('token without a design-spec source fails', () => {
  const dir = writeDraft(VALID_DRAFT.replace(' (source: design-spec.md#colors)', ''));
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('token without design-spec source'));
  } finally {
    rmDir(dir);
  }
});

test('empty out-of-scope section fails', () => {
  const dir = writeDraft(VALID_DRAFT.replace('- offline banner\n', ''));
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('Out of scope'));
  } finally {
    rmDir(dir);
  }
});
