'use strict';
// Tests first, as a receipt: the ledger runs a (test) criterion's frozen command before the
// implementation and seals it only if it fails, and a later PASS proves tests-first only when the
// worktree changed in between.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SCRIPTS_DIR, mkTmpDir, rmDir, ledger, settleDispatches, freezeRun, judge } = require('./helpers.js');
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

// C1 passes once feature.js exists in the directory it runs in, like a test of code not yet written.
const FEATURE_TEST = `node -e "process.exit(require('fs').existsSync('feature.js')?0:1)"`;
const PASSES = 'node -e "process.exit(0)"';

function draft(c1 = FEATURE_TEST, c2 = PASSES) {
  return (
    `# Done\n## Criteria\n- [ ] C1 (test): the feature exists | run: ${c1}\n` +
    `- [ ] C2 (analyzer): clean | run: ${c2}\n## Tokens\n- none\n## Out of scope\n- the offline banner\n`
  );
}

function git(root, args) {
  const res = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
}

// A real git repo, because tests-first is proven by the worktree changing between the red run and the pass.
function frozenRun(profile = {}, c1, c2, text) {
  const root = mkTmpDir('tl-red');
  spawnSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'ticket-loop.config.json'),
    JSON.stringify({ verify: { test: 'node tests.js', analyze: 'node lint.js' }, ...profile })
  );
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  const runDir = path.join(root, '.agents', 'ticket-runs', 'T-1');
  fs.mkdirSync(runDir, { recursive: true });
  assert.strictEqual(ledger(root, ['init', runDir]).status, 0);
  freezeRun(root, runDir, text || draft(c1, c2));
  return { root, runDir };
}

// Two test criteria and one with nothing a shell can run.
const THREE =
  `# Done\n## Criteria\n- [ ] C1 (test): the feature exists | run: ${FEATURE_TEST}\n` +
  `- [ ] C2 (analyzer): clean | run: ${PASSES}\n` +
  `- [ ] C3 (test): the feature is wired in | run: ${FEATURE_TEST}\n` +
  `- [ ] C4 (test): the screen shows it | run: playwright: open /feature\n` +
  `## Tokens\n- none\n## Out of scope\n- the offline banner\n`;

test('a red run proves tests-first for its own criterion and no other', () => {
  const { root, runDir } = frozenRun({}, undefined, undefined, THREE);
  try {
    assert.strictEqual(red(root, runDir, 'C1').status, 0);
    fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = 1;\n');
    assert.strictEqual(pass(root, runDir, 'C1').status, 0);
    assert.strictEqual(pass(root, runDir, 'C3').status, 0);
    assert.strictEqual(criterion(root, runDir, 'C1').testFirst, 'proven');
    assert.strictEqual(criterion(root, runDir, 'C3').testFirst, 'missing', 'C1 failing first says nothing about C3');
  } finally {
    rmDir(root);
  }
});

test('a red run that never finishes, or a test criterion with nothing to run, seals nothing', () => {
  const hang = 'node -e "setTimeout(() => {}, 20000)"';
  const { root, runDir } = frozenRun({}, hang, undefined, THREE.replace(FEATURE_TEST, hang));
  try {
    const slow = ledger(root, ['red', runDir, 'C1', '--cwd', root, '--timeout-ms', '700']);
    assert.strictEqual(slow.status, 1, 'a command that timed out showed no failure');
    assert.match(slow.stderr, /did not finish with an exit code/);
    const nothing = red(root, runDir, 'C4');
    assert.strictEqual(nothing.status, 1);
    assert.match(nothing.stderr, /no shell command to run/);
    assert.strictEqual(chain.ofKind(runDir, 'red').length, 0);
  } finally {
    rmDir(root);
  }
});

const red = (root, runDir, id = 'C1') => ledger(root, ['red', runDir, id, '--cwd', root]);
const pass = (root, runDir, id) => ledger(root, ['check', runDir, id, 'PASS', '--by', 'command', '--cwd', root]);
const criterion = (root, runDir, id) => JSON.parse(ledger(root, ['verify', runDir]).stdout).completeness.criteria.find((c) => c.id === id);

test('a red run is sealed only when the frozen command fails, with what it saw', () => {
  const { root, runDir } = frozenRun();
  try {
    const res = red(root, runDir);
    assert.strictEqual(res.status, 0, res.stderr);
    const rec = chain.last(runDir, 'red');
    assert.strictEqual(rec.payload.id, 'C1');
    assert.strictEqual(rec.payload.exitCode, 1);
    assert.ok(rec.payload.tree, 'the worktree it ran against is fingerprinted');
  } finally {
    rmDir(root);
  }
});

test('a test that already passes before the implementation is refused as a red run', () => {
  const { root, runDir } = frozenRun();
  try {
    fs.writeFileSync(path.join(root, 'feature.js'), '');
    const res = red(root, runDir);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /already passes/);
    assert.strictEqual(chain.last(runDir, 'red'), null);
  } finally {
    rmDir(root);
  }
});

test('only a (test) criterion with a shell command takes a red run', () => {
  const { root, runDir } = frozenRun({}, undefined, 'node -e "process.exit(1)"');
  try {
    const analyzer = red(root, runDir, 'C2');
    assert.strictEqual(analyzer.status, 1, 'an analyzer criterion is not tests-first, even when its command fails');
    assert.match(analyzer.stderr, /\(analyzer\) criterion/);
    assert.strictEqual(red(root, runDir, 'C9').status, 1, 'an id outside the contract');
  } finally {
    rmDir(root);
  }
});

test('tests-first is proven by a red run, then a pass after the worktree changed', () => {
  const { root, runDir } = frozenRun();
  try {
    assert.strictEqual(red(root, runDir).status, 0);
    fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = 1;\n');
    assert.strictEqual(pass(root, runDir, 'C1').status, 0);
    assert.strictEqual(criterion(root, runDir, 'C1').testFirst, 'proven');
  } finally {
    rmDir(root);
  }
});

test('a pass with no red run before it, or with no change since, does not prove tests-first', () => {
  const unproven = frozenRun();
  const unchanged = frozenRun({}, PASSES);
  try {
    fs.writeFileSync(path.join(unproven.root, 'feature.js'), '');
    assert.strictEqual(pass(unproven.root, unproven.runDir, 'C1').status, 0);
    assert.strictEqual(criterion(unproven.root, unproven.runDir, 'C1').testFirst, 'missing');

    // A red at the very tree the pass ran against: the code cannot have changed in between.
    assert.strictEqual(pass(unchanged.root, unchanged.runDir, 'C1').status, 0);
    const rec = chain.last(unchanged.runDir, 'check');
    assert.ok(rec.payload.tree, 'a pass by command fingerprints its worktree');
    chain.append(unchanged.runDir, 'red', { id: 'C1', exitCode: 1, tree: rec.payload.tree });
    assert.strictEqual(pass(unchanged.root, unchanged.runDir, 'C1').status, 0);
    assert.strictEqual(criterion(unchanged.root, unchanged.runDir, 'C1').testFirst, 'missing', 'a red at the pass\'s own tree proves nothing');
  } finally {
    rmDir(unproven.root);
    rmDir(unchanged.root);
  }
});

function finished(profile) {
  const run = frozenRun(profile);
  fs.writeFileSync(path.join(run.root, 'feature.js'), '');
  assert.strictEqual(pass(run.root, run.runDir, 'C1').status, 0);
  assert.strictEqual(pass(run.root, run.runDir, 'C2').status, 0);
  assert.strictEqual(judge(run.root, run.runDir, 'APPROVE').status, 0);
  settleDispatches(run.root, run.runDir);
  return run;
}

test('with requireTestFirst, a run whose test criteria lack a red run has not passed', () => {
  const lax = finished({});
  const strict = finished({ requireTestFirst: true });
  try {
    const verdictOf = (r) => JSON.parse(ledger(r.root, ['verify', r.runDir]).stdout).completeness;
    assert.strictEqual(verdictOf(lax).passed, true, 'without the rule the record says, and passes');
    const c = verdictOf(strict);
    assert.strictEqual(c.passed, false);
    assert.strictEqual(c.requireTestFirst, true);
  } finally {
    rmDir(lax.root);
    rmDir(strict.root);
  }
});

test('a red run sealed after the pass proves nothing about the code that passed', () => {
  const { root, runDir } = frozenRun();
  try {
    fs.writeFileSync(path.join(root, 'feature.js'), '');
    assert.strictEqual(pass(root, runDir, 'C1').status, 0);
    fs.rmSync(path.join(root, 'feature.js'));
    assert.strictEqual(red(root, runDir).status, 0, 'the test fails again once the feature is gone');
    assert.strictEqual(criterion(root, runDir, 'C1').testFirst, 'missing');
  } finally {
    rmDir(root);
  }
});
