'use strict';
// A pass by command says what the tracked files held when the command ran. The run passes only
// while the ticket branch's tip holds the same, so the commit that ships is the one that was
// checked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpDir, rmDir, ledger, settleDispatches, freezeRun, judge } = require('./helpers.js');

// C1 passes once the tracked feature.js says ok.
const FEATURE_OK = `node -e "process.exit(require('fs').readFileSync('feature.js','utf8').includes('ok')?0:1)"`;
const PASSES = 'node -e "process.exit(0)"';
const DRAFT =
  `# Done\n## Criteria\n- [ ] C1 (test): the feature answers ok | run: ${FEATURE_OK}\n` +
  `- [ ] C2 (analyzer): clean | run: ${PASSES}\n## Tokens\n- none\n## Out of scope\n- the offline banner\n`;

function git(root, args) {
  const res = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
}

// The ticket branch is checked out in the repo itself, with the run folder ignored as setup leaves it.
function frozenRunOnBranch(branch = 'ticket/T-1') {
  const root = mkTmpDir('tl-bind');
  spawnSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'ticket-loop.config.json'),
    JSON.stringify({ verify: { test: 'node tests.js', analyze: 'node lint.js' } })
  );
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/ticket-runs/\n');
  fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = "no";\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  git(root, ['checkout', '-q', '-b', branch]);
  const runDir = path.join(root, '.agents', 'ticket-runs', 'T-1');
  fs.mkdirSync(runDir, { recursive: true });
  assert.strictEqual(ledger(root, ['init', runDir]).status, 0);
  freezeRun(root, runDir, DRAFT);
  return { root, runDir };
}

const pass = (root, runDir, id) => {
  const res = ledger(root, ['check', runDir, id, 'PASS', '--by', 'command', '--cwd', root]);
  assert.strictEqual(res.status, 0, res.stderr);
};
const done = (root, runDir) => JSON.parse(ledger(root, ['verify', runDir]).stdout).completeness;
const atHead = (c, id) => c.criteria.find((x) => x.id === id).atHead;

function approve(root, runDir) {
  assert.strictEqual(judge(root, runDir).status, 0);
  settleDispatches(root, runDir);
}

test('a pass on uncommitted work counts once the branch tip holds that work', () => {
  const { root, runDir } = frozenRunOnBranch();
  try {
    fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = "ok";\n');
    pass(root, runDir, 'C1');
    pass(root, runDir, 'C2');
    approve(root, runDir);

    const before = done(root, runDir);
    assert.strictEqual(atHead(before, 'C1'), false, 'the tip does not hold what was checked yet');
    assert.strictEqual(before.passed, false, 'a pass that no commit holds is not a passed run');

    git(root, ['commit', '-qam', 'the feature']);
    const after = done(root, runDir);
    assert.strictEqual(atHead(after, 'C1'), true, 'the commit made from the checked files is the checked tree');
    assert.strictEqual(after.passed, true);
  } finally {
    rmDir(root);
  }
});

test('a new file staged before the check is part of what the check ran on', () => {
  const { root, runDir } = frozenRunOnBranch();
  try {
    fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = require("./helper.js"); // ok\n');
    fs.writeFileSync(path.join(root, 'helper.js'), 'module.exports = "ok";\n');
    git(root, ['add', 'helper.js']);
    pass(root, runDir, 'C1');
    pass(root, runDir, 'C2');
    approve(root, runDir);

    git(root, ['commit', '-qam', 'the feature and its helper']);
    assert.strictEqual(atHead(done(root, runDir), 'C1'), true, 'committing exactly what was checked, new file included, keeps the pass');
  } finally {
    rmDir(root);
  }
});

test('a commit after the pass leaves the pass behind until the check runs again', () => {
  const { root, runDir } = frozenRunOnBranch();
  try {
    fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = "ok";\n');
    git(root, ['commit', '-qam', 'the feature']);
    pass(root, runDir, 'C1');
    pass(root, runDir, 'C2');
    approve(root, runDir);
    assert.strictEqual(done(root, runDir).passed, true);

    fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = "ok"; // and one more thing\n');
    git(root, ['commit', '-qam', 'one more thing']);
    const stale = done(root, runDir);
    assert.strictEqual(stale.passed, false, 'the tip moved past what was checked');
    assert.strictEqual(atHead(stale, 'C1'), false);
    assert.strictEqual(atHead(stale, 'C2'), false);

    pass(root, runDir, 'C1');
    assert.strictEqual(done(root, runDir).passed, false, 'C2 still describes the older tree');
    pass(root, runDir, 'C2');
    assert.strictEqual(done(root, runDir).passed, true);
  } finally {
    rmDir(root);
  }
});

test('commits that leave the files as checked keep the pass', () => {
  const { root, runDir } = frozenRunOnBranch();
  try {
    fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = "ok";\n');
    git(root, ['commit', '-qam', 'wip: the feature']);
    pass(root, runDir, 'C1');
    pass(root, runDir, 'C2');
    approve(root, runDir);

    git(root, ['commit', '-q', '--allow-empty', '-m', 'verify green']);
    assert.strictEqual(done(root, runDir).passed, true, 'an empty commit holds the same files');
    git(root, ['reset', '-q', '--soft', 'HEAD~2']);
    git(root, ['commit', '-qm', 'fix: the feature, squashed']);
    assert.strictEqual(done(root, runDir).passed, true, 'a squash holds the same files');
  } finally {
    rmDir(root);
  }
});

test('a check leaves the index of the worktree it ran in alone', () => {
  const { root, runDir } = frozenRunOnBranch();
  try {
    fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = "ok";\n');
    pass(root, runDir, 'C1');
    const staged = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).stdout.trim();
    assert.strictEqual(staged, '', 'fingerprinting the files staged nothing');
  } finally {
    rmDir(root);
  }
});

test('with no ticket branch there is no tip to hold a pass against', () => {
  const { root, runDir } = frozenRunOnBranch('some/other-branch');
  try {
    fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = "ok";\n');
    pass(root, runDir, 'C1');
    pass(root, runDir, 'C2');
    approve(root, runDir);
    const c = done(root, runDir);
    assert.strictEqual(c.head, null);
    assert.strictEqual(atHead(c, 'C1'), undefined);
    assert.strictEqual(c.passed, true);
  } finally {
    rmDir(root);
  }
});
