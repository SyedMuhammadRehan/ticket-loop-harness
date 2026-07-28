'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');

const SCRIPT = path.join(SCRIPTS_DIR, 'ledger.js');

function initRun(base) {
  const dir = path.join(mkTmpDir('tl-ledger'), 'T-1');
  const res = runScript(SCRIPT, ['init', dir, base || 'abc123']);
  assert.strictEqual(res.status, 0, res.stderr);
  return dir;
}

test('init writes budget.json and a ledger.md skeleton', () => {
  const dir = initRun('deadbeef');
  try {
    const budget = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8'));
    assert.deepStrictEqual(
      { d: budget.dispatches, r: budget.replans, md: budget.maxDispatches, mr: budget.maxReplans },
      { d: 0, r: 0, md: 25, mr: 2 }
    );
    const ledger = fs.readFileSync(path.join(dir, 'ledger.md'), 'utf8');
    assert.ok(ledger.includes('# Ledger — T-1'));
    assert.ok(ledger.includes('base: deadbeef'));
    assert.ok(ledger.includes('## Attempts'));
  } finally {
    rmDir(path.dirname(dir));
  }
});

test('init refuses to reset an existing budget (RESUME safety)', () => {
  const dir = initRun();
  try {
    runScript(SCRIPT, ['dispatch', dir, 'implementer: C1']);
    const res = runScript(SCRIPT, ['init', dir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('refusing to reset'));
    const budget = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8'));
    assert.strictEqual(budget.dispatches, 1); // count survived
  } finally {
    rmDir(path.dirname(dir));
  }
});

test('dispatch increments and records history, then trips the hard budget at the cap', () => {
  const dir = initRun();
  try {
    for (let i = 1; i <= 25; i++) {
      const res = runScript(SCRIPT, ['dispatch', dir, `implementer: C${i}`]);
      assert.strictEqual(res.status, 0, `dispatch ${i} failed: ${res.stderr}`);
      assert.ok(res.stdout.includes(`${i}/25`));
    }
    const blocked = runScript(SCRIPT, ['dispatch', dir, 'one too many']);
    assert.strictEqual(blocked.status, 2);
    assert.ok(blocked.stderr.includes('HARD BUDGET'));
    const budget = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8'));
    assert.strictEqual(budget.dispatches, 25); // the refused dispatch was not counted
    assert.strictEqual(budget.history.length, 25);
  } finally {
    rmDir(path.dirname(dir));
  }
});

test('replan trips the circuit breaker after MAX_REPLANS', () => {
  const dir = initRun();
  try {
    assert.strictEqual(runScript(SCRIPT, ['replan', dir]).status, 0);
    assert.strictEqual(runScript(SCRIPT, ['replan', dir]).status, 0);
    const blocked = runScript(SCRIPT, ['replan', dir]);
    assert.strictEqual(blocked.status, 2);
    assert.ok(blocked.stderr.includes('CIRCUIT BREAKER'));
  } finally {
    rmDir(path.dirname(dir));
  }
});

test('dispatch/status on an uninitialized run dir fails with guidance', () => {
  const dir = mkTmpDir('tl-ledger');
  try {
    const res = runScript(SCRIPT, ['dispatch', path.join(dir, 'nope')]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('init'));
  } finally {
    rmDir(dir);
  }
});

test('status prints the counters as JSON', () => {
  const dir = initRun();
  try {
    runScript(SCRIPT, ['dispatch', dir, 'qa']);
    const res = runScript(SCRIPT, ['status', dir]);
    assert.strictEqual(res.status, 0);
    const budget = JSON.parse(res.stdout);
    assert.strictEqual(budget.dispatches, 1);
  } finally {
    rmDir(path.dirname(dir));
  }
});
