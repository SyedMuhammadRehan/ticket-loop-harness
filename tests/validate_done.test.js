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

// --- approach.md contract (Stage 2.5) ---

const VALID_APPROACH = `# Approach — T-1
## Data
- profile: owned by the API; this change reads it
## Boundary
- change lives behind ProfileRepository; callers see the same interface
## Options
- A: map errors in the repository — keeps UI dumb
- B: map errors in the widget — fewer files touched, leaks transport details upward
## Chosen
- A: error semantics belong at the data boundary; B couples UI to dio exceptions
## Failure modes
- API returns 404/500 | covered-by: C1
- device offline | covered-by: out-of-scope (separate ticket)
## Slice order
- 1st: C1 error mapping — proves the repository boundary can express typed errors
`;

function writeDraftWithApproach(draftContent, approachContent) {
  const dir = writeDraft(draftContent);
  fs.writeFileSync(path.join(dir, 'approach.md'), approachContent);
  return dir;
}

test('valid draft + valid approach passes and reports the contract check', () => {
  const dir = writeDraftWithApproach(VALID_DRAFT, VALID_APPROACH);
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('approach contract checked'));
  } finally {
    rmDir(dir);
  }
});

test('failure mode without a covered-by tag fails', () => {
  const dir = writeDraftWithApproach(
    VALID_DRAFT,
    VALID_APPROACH.replace(' | covered-by: C1', '')
  );
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('covered-by'));
  } finally {
    rmDir(dir);
  }
});

test('failure mode pointing at a criterion that does not exist fails', () => {
  const dir = writeDraftWithApproach(
    VALID_DRAFT,
    VALID_APPROACH.replace('| covered-by: C1', '| covered-by: C9')
  );
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('no criterion C9'));
  } finally {
    rmDir(dir);
  }
});

test('a single option is a guess, not a decision — fails', () => {
  const dir = writeDraftWithApproach(
    VALID_DRAFT,
    VALID_APPROACH.replace('- B: map errors in the widget — fewer files touched, leaks transport details upward\n', '')
  );
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('>=2 options'));
  } finally {
    rmDir(dir);
  }
});

test('empty Chosen and empty Failure modes both fail', () => {
  const gutted = VALID_APPROACH
    .replace('- A: error semantics belong at the data boundary; B couples UI to dio exceptions\n', '')
    .replace(/- API returns 404\/500 \| covered-by: C1\n- device offline \| covered-by: out-of-scope \(separate ticket\)\n/, '');
  const dir = writeDraftWithApproach(VALID_DRAFT, gutted);
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('Chosen'));
    assert.ok(res.stderr.includes('Failure modes'));
  } finally {
    rmDir(dir);
  }
});

test('out-of-scope without a reason is a silent opt-out — fails', () => {
  const dir = writeDraftWithApproach(
    VALID_DRAFT,
    VALID_APPROACH.replace('| covered-by: out-of-scope (separate ticket)', '| covered-by: out-of-scope')
  );
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('out-of-scope (<reason>)'));
  } finally {
    rmDir(dir);
  }
});

test('a duplicated section heading cannot hide an unvalidated second block — fails', () => {
  const smuggled = VALID_APPROACH +
    '## Failure modes\n- newly discovered dangerous case, untagged\n';
  const dir = writeDraftWithApproach(VALID_DRAFT, smuggled);
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('duplicate'));
  } finally {
    rmDir(dir);
  }
});

test('heading match is case-insensitive (formatting drift must not false-fail)', () => {
  const dir = writeDraftWithApproach(VALID_DRAFT, VALID_APPROACH.replace('## Chosen', '## chosen'));
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 0, res.stderr);
  } finally {
    rmDir(dir);
  }
});

test('no approach.md means no approach checks (trivial tickets stay cheap)', () => {
  const dir = writeDraft(VALID_DRAFT);
  try {
    const res = runScript(SCRIPT, [dir]);
    assert.strictEqual(res.status, 0);
    assert.ok(!res.stdout.includes('approach'));
  } finally {
    rmDir(dir);
  }
});
