'use strict';
// Three things CON-1420 tripped on: a judge that sealed its verdict still read as a stalled
// dispatch; `cost` read the main checkout and reported an empty diff for a 75-file change; and a
// (token) criterion could not get a failing-first receipt, so its proof was made by hand outside
// the record.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpDir, rmDir, ledger, freezeRun, judge } = require('./helpers.js');

const CHANGED = `node -e "process.exit(require('fs').existsSync('feature.js')?0:1)"`;
const PASSES = 'node -e "process.exit(0)"';

function git(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  return res.stdout.trim();
}

// A real repo with a run frozen on `criteria`, and the run's worktree beside it on ticket/T-1.
function runWithWorktree(criteria) {
  const base = mkTmpDir('tl-rela');
  const root = path.join(base, 'main');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify({ verify: { test: 'node tests.js', analyze: 'node lint.js' } }));
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/ticket-runs/\n');
  fs.writeFileSync(path.join(root, 'a.txt'), '1\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  const runDir = path.join(root, '.agents', 'ticket-runs', 'T-1');
  fs.mkdirSync(runDir, { recursive: true });
  assert.strictEqual(ledger(root, ['init', runDir, git(root, ['rev-parse', 'HEAD'])]).status, 0);
  freezeRun(root, runDir, `# Done\n## Criteria\n${criteria}## Tokens\n- none\n## Out of scope\n- the offline banner\n`);
  const wt = path.join(base, 'wt-T-1');
  git(root, ['worktree', 'add', '-q', wt, '-b', 'ticket/T-1']);
  return { base, root, runDir, wt };
}

test('a judge that sealed its verdict leaves no dispatch open or stalled', () => {
  const env = runWithWorktree(`- [ ] C1 (test): holds | run: ${PASSES}\n- [ ] C2 (analyzer): clean | run: ${PASSES}\n`);
  try {
    assert.strictEqual(judge(env.root, env.runDir, 'APPROVE').status, 0);
    const status = JSON.parse(ledger(env.root, ['status', env.runDir]).stdout);
    assert.deepStrictEqual(status.open, [], 'the verdict is the judge\'s outcome');
    const other = ledger(env.root, ['dispatch', env.runDir, 'implementer: C1', '--source', 'hook']);
    assert.strictEqual(other.status, 0);
    assert.strictEqual(JSON.parse(ledger(env.root, ['status', env.runDir]).stdout).open.length, 1, 'an implementer with no outcome is still open');
  } finally {
    spawnSync('git', ['-C', env.root, 'worktree', 'remove', '--force', env.wt]);
    rmDir(env.base);
  }
});

test('cost reads the run worktree when none is named', () => {
  const env = runWithWorktree(`- [ ] C1 (test): holds | run: ${PASSES}\n- [ ] C2 (analyzer): clean | run: ${PASSES}\n`);
  try {
    fs.writeFileSync(path.join(env.wt, 'feature.js'), 'module.exports = 1;\nmodule.exports.b = 2;\n');
    git(env.wt, ['add', '-A']);
    git(env.wt, ['commit', '-qm', 'the change']);
    const cost = JSON.parse(ledger(env.root, ['cost', env.runDir]).stdout);
    assert.deepStrictEqual(cost.diffVsBase, { files: 1, added: 2, removed: 0, net: 2 });
  } finally {
    spawnSync('git', ['-C', env.root, 'worktree', 'remove', '--force', env.wt]);
    rmDir(env.base);
  }
});

test('a (token) criterion gets a failing-first receipt like a (test) one', () => {
  const env = runWithWorktree(
    `- [ ] C1 (token): the badge uses the kit colour | run: ${CHANGED}\n- [ ] C2 (analyzer): clean | run: ${PASSES}\n` +
      `- [ ] C3 (test): the badge shows | run: ${CHANGED}\n`
  );
  try {
    const red = ledger(env.root, ['red', env.runDir, 'C1', '--cwd', env.wt]);
    assert.strictEqual(red.status, 0, red.stderr);
    fs.writeFileSync(path.join(env.wt, 'feature.js'), 'module.exports = 1;\n');
    git(env.wt, ['add', '-A']);
    git(env.wt, ['commit', '-qm', 'the change']);
    assert.strictEqual(ledger(env.root, ['check', env.runDir, 'C1', 'PASS', '--by', 'command', '--cwd', env.wt]).status, 0);
    const c1 = JSON.parse(ledger(env.root, ['verify', env.runDir]).stdout).completeness.criteria.find((c) => c.id === 'C1');
    assert.strictEqual(c1.testFirst, 'proven');
    const analyzer = ledger(env.root, ['red', env.runDir, 'C2', '--cwd', env.wt]);
    assert.strictEqual(analyzer.status, 1, 'an analyzer criterion still has no red run');
  } finally {
    spawnSync('git', ['-C', env.root, 'worktree', 'remove', '--force', env.wt]);
    rmDir(env.base);
  }
});
