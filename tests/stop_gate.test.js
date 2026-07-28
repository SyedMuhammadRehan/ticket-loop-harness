'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HOOKS_DIR, mkTmpDir, rmDir, runScript, mkFakeRepo } = require('./helpers.js');

const SCRIPT = path.join(HOOKS_DIR, 'stop_gate.js');
const { parseWorktrees, mapTargets, looksLikeFlake } = require(SCRIPT);

// --- unit: worktree parsing ---

test('parseWorktrees reads `git worktree list --porcelain` output', () => {
  const porcelain = [
    'worktree C:/dev/app',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree C:/dev/ticket-PROJ-128',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/ticket/PROJ-128',
    '',
  ].join('\n');
  const wts = parseWorktrees(porcelain);
  assert.strictEqual(wts.length, 2);
  assert.strictEqual(wts[1].path, 'C:/dev/ticket-PROJ-128');
  assert.strictEqual(wts[1].branch, 'refs/heads/ticket/PROJ-128');
});

// --- unit: targeted-mode test mapping ---

test('mapTargets maps changed sources to matching test files and honors excludes', () => {
  const tree = mkTmpDir('tl-map');
  try {
    fs.mkdirSync(path.join(tree, 'test', 'ui'), { recursive: true });
    fs.mkdirSync(path.join(tree, 'test', 'golden'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'test', 'ui', 'profile_screen_test.dart'), '');
    fs.writeFileSync(path.join(tree, 'test', 'golden', 'profile_screen_test.dart'), '');
    fs.writeFileSync(path.join(tree, 'test', 'other_test.dart'), '');
    const conf = {
      testDir: 'test',
      testSuffix: '_test.dart',
      excludeTests: ['test/golden/'],
    };
    const { targets } = mapTargets(tree, ['lib/ui/profile_screen.dart', 'test/other_test.dart'], conf);
    assert.deepStrictEqual(targets.sort(), ['test/other_test.dart', 'test/ui/profile_screen_test.dart']);
  } finally {
    rmDir(tree);
  }
});

test('looksLikeFlake requires a signature and no real-failure marker', () => {
  const conf = { flakeSignatures: ['errno = 183'], failureMarkers: ['Expected:'] };
  assert.strictEqual(looksLikeFlake('boom errno = 183', conf), true);
  assert.strictEqual(looksLikeFlake('errno = 183\nExpected: <blue>', conf), false);
  assert.strictEqual(looksLikeFlake('anything', { flakeSignatures: [] }), false);
});

// --- integration: inert without config ---

test('hook is inert with no config / no stopGate block', () => {
  const bare = mkFakeRepo();
  const noBlock = mkFakeRepo({ stack: 'python' });
  try {
    assert.strictEqual(runScript(SCRIPT, [], { cwd: bare, input: '{}' }).status, 0);
    assert.strictEqual(runScript(SCRIPT, [], { cwd: noBlock, input: '{}' }).status, 0);
  } finally {
    rmDir(bare);
    rmDir(noBlock);
  }
});

// --- integration: real git repo + ticket worktree ---

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function setupRepoWithWorktree() {
  const base = mkTmpDir('tl-sg');
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'test@test');
  git(main, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(main, 'src'));
  fs.writeFileSync(path.join(main, 'src', 'app.py'), 'x = 1\n');
  // verify.test: fails iff a FAIL marker file exists in the tree under test
  fs.writeFileSync(path.join(main, 'check.js'), "process.exit(require('fs').existsSync('FAIL') ? 1 : 0);\n");
  fs.mkdirSync(path.join(main, '.agents'));
  fs.writeFileSync(
    path.join(main, '.agents', 'ticket-loop.config.json'),
    JSON.stringify({
      verify: { test: 'node check.js' },
      hooks: { stopGate: { extensions: ['.py'], mode: 'full' } },
    })
  );
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', path.join(base, 'ticket-T-1'), '-b', 'ticket/T-1');
  return { base, main, worktree: path.join(base, 'ticket-T-1') };
}

test('verifies the ticket worktree, not just the cwd tree', () => {
  const { base, main, worktree } = setupRepoWithWorktree();
  try {
    // Dirty ONLY the worktree — the old cwd-only gate would have seen nothing.
    fs.writeFileSync(path.join(worktree, 'src', 'app.py'), 'x = 2\n');

    let res = runScript(SCRIPT, [], { cwd: main, input: '{}' });
    assert.strictEqual(res.status, 0, res.stderr); // worktree checked, tests green

    fs.writeFileSync(path.join(worktree, 'FAIL'), ''); // make the worktree suite red
    res = runScript(SCRIPT, [], { cwd: main, input: '{}' });
    assert.strictEqual(res.status, 2);
    assert.ok(res.stderr.includes('ticket-T-1'), `stderr should name the worktree:\n${res.stderr}`);
  } finally {
    // remove worktree before deleting, so git doesn't leave dangling metadata
    spawnSync('git', ['worktree', 'remove', '--force', path.join(base, 'ticket-T-1')], { cwd: path.join(base, 'main'), encoding: 'utf8' });
    rmDir(base);
  }
});

test('clean trees pass without running anything; escape valve releases after 3 blocks', () => {
  const { base, main, worktree } = setupRepoWithWorktree();
  try {
    let res = runScript(SCRIPT, [], { cwd: main, input: '{}' });
    assert.strictEqual(res.status, 0); // nothing changed anywhere

    fs.writeFileSync(path.join(worktree, 'src', 'app.py'), 'x = 3\n');
    fs.writeFileSync(path.join(worktree, 'FAIL'), '');
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(runScript(SCRIPT, [], { cwd: main, input: '{}' }).status, 2);
    }
    // 3 consecutive blocks + stop_hook_active -> allow stop (loudly), so a red suite
    // can't trap the session forever.
    res = runScript(SCRIPT, [], { cwd: main, input: JSON.stringify({ stop_hook_active: true }) });
    assert.strictEqual(res.status, 0);
    assert.ok(res.stderr.includes('NOT green'));
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', path.join(base, 'ticket-T-1')], { cwd: path.join(base, 'main'), encoding: 'utf8' });
    rmDir(base);
  }
});
