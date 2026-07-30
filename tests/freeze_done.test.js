'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkRun, rmDir, runScript, ledger } = require('./helpers.js');

const FREEZE = path.join(SCRIPTS_DIR, 'freeze_done.js');
const VALIDATE = path.join(SCRIPTS_DIR, 'validate_done.js');

const CONFIG = { verify: { test: 'pytest -q', analyze: 'ruff check .' } };

const VALID_DRAFT = `# Done — T-1
## Criteria
- [ ] C1 (test): repo maps 404 to a typed error | run: pytest tests/test_repo.py
- [ ] C2 (analyzer): zero analyzer errors | run: ruff check .
## Out of scope
- offline banner
`;

function setup({ draft = VALID_DRAFT, init = true } = {}) {
  const { root, runDir } = mkRun(CONFIG);
  if (init) assert.strictEqual(ledger(root, ['init', runDir, 'abc123']).status, 0);
  fs.writeFileSync(path.join(runDir, 'done.draft.md'), draft);
  return { root, runDir };
}
const validate = (root, runDir) => runScript(VALIDATE, [runDir], { cwd: root });
const freeze = (root, runDir) => runScript(FREEZE, [runDir], { cwd: root });

test('freezes a validated draft into done.md + done.approved.md + additions file', () => {
  const { root, runDir } = setup();
  try {
    assert.strictEqual(validate(root, runDir).status, 0);
    const res = freeze(root, runDir);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(!fs.existsSync(path.join(runDir, 'done.draft.md')));
    assert.strictEqual(fs.readFileSync(path.join(runDir, 'done.md'), 'utf8'), VALID_DRAFT);
    assert.strictEqual(fs.readFileSync(path.join(runDir, 'done.approved.md'), 'utf8'), VALID_DRAFT);
    assert.ok(fs.existsSync(path.join(runDir, 'done-additions.md')));
  } finally {
    rmDir(root);
  }
});

// Validation must be a precondition of freezing, not advice: otherwise an unvalidated draft
// — no behavioural criterion, or every box pre-ticked — can become the frozen contract.
test('refuses to freeze a draft that was never validated', () => {
  const { root, runDir } = setup();
  try {
    const res = freeze(root, runDir);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('never been validated'), res.stderr);
    assert.ok(!fs.existsSync(path.join(runDir, 'done.md')));
  } finally {
    rmDir(root);
  }
});

// Validate-then-edit-then-freeze was the other half of the same hole.
test('refuses to freeze a draft that changed after validation', () => {
  const { root, runDir } = setup();
  try {
    assert.strictEqual(validate(root, runDir).status, 0);
    fs.writeFileSync(
      path.join(runDir, 'done.draft.md'),
      VALID_DRAFT.replace('- [ ] C1 (test): repo maps 404 to a typed error | run: pytest tests/test_repo.py\n', '')
    );
    const res = freeze(root, runDir);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('changed after it was validated'), res.stderr);
  } finally {
    rmDir(root);
  }
});

test('re-validating the edited draft makes the freeze legitimate again', () => {
  const { root, runDir } = setup();
  try {
    validate(root, runDir);
    fs.writeFileSync(path.join(runDir, 'done.draft.md'), VALID_DRAFT.replace('offline banner', 'offline banner and retries'));
    assert.strictEqual(freeze(root, runDir).status, 1);
    assert.strictEqual(validate(root, runDir).status, 0);
    assert.strictEqual(freeze(root, runDir).status, 0);
  } finally {
    rmDir(root);
  }
});

test('refuses to freeze without a receipt chain at all', () => {
  const { root, runDir } = setup({ init: false });
  try {
    const res = freeze(root, runDir);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('no receipt chain'), res.stderr);
  } finally {
    rmDir(root);
  }
});

test('refuses to freeze twice', () => {
  const { root, runDir } = setup();
  try {
    validate(root, runDir);
    assert.strictEqual(freeze(root, runDir).status, 0);
    fs.writeFileSync(path.join(runDir, 'done.draft.md'), 'v2 — goalpost move\n');
    const res = freeze(root, runDir);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('already frozen'));
    assert.strictEqual(fs.readFileSync(path.join(runDir, 'done.md'), 'utf8'), VALID_DRAFT);
  } finally {
    rmDir(root);
  }
});

test('missing draft fails', () => {
  const { root, runDir } = mkRun(CONFIG);
  try {
    ledger(root, ['init', runDir, 'abc']);
    const res = freeze(root, runDir);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('missing'));
  } finally {
    rmDir(root);
  }
});

test('the freeze seals the contract, so a later edit surfaces as TAMPERED', () => {
  const { root, runDir } = setup();
  try {
    validate(root, runDir);
    freeze(root, runDir);
    assert.strictEqual(ledger(root, ['verify', runDir]).status, 0);

    // Simulate a tamper that got past the hook and wrote BOTH copies — the case the old
    // self-reported `git diff --no-index done.approved.md done.md` check could never catch.
    const weakened = VALID_DRAFT.replace('C1 (test): repo maps 404 to a typed error', 'C1 (test): anything at all');
    fs.writeFileSync(path.join(runDir, 'done.md'), weakened);
    fs.writeFileSync(path.join(runDir, 'done.approved.md'), weakened);

    const res = ledger(root, ['verify', runDir]);
    assert.strictEqual(res.status, 4);
    assert.ok(res.stdout.includes('TAMPERED'), res.stdout);
  } finally {
    rmDir(root);
  }
});
