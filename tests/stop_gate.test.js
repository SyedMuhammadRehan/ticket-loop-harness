'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HOOKS_DIR, mkTmpDir, rmDir, runScript, mkFakeRepo } = require('./helpers.js');

const SCRIPT = path.join(HOOKS_DIR, 'stop_gate.js');
const { parseWorktrees, mapTargets, looksLikeFlake, readState } = require(SCRIPT);

// --- unit: worktree parsing ---

test('parseWorktrees reads `git worktree list --porcelain`, including detached trees', () => {
  const porcelain = [
    'worktree C:/dev/app',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree C:/dev/ticket-PROJ-128',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/ticket/PROJ-128',
    '',
    'worktree C:/dev/spike',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
  ].join('\n');
  const wts = parseWorktrees(porcelain);
  assert.strictEqual(wts.length, 3);
  assert.strictEqual(wts[1].path, 'C:/dev/ticket-PROJ-128');
  assert.strictEqual(wts[1].branch, 'refs/heads/ticket/PROJ-128');
  assert.strictEqual(wts[2].detached, true);
  assert.strictEqual(wts[2].branch, null);
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
    const conf = { testDir: 'test', testSuffix: '_test.dart', excludeTests: ['test/golden/'] };
    const { targets, unmatched } = mapTargets(
      tree,
      ['lib/ui/profile_screen.dart', 'test/other_test.dart', 'lib/untested.dart'],
      conf
    );
    assert.deepStrictEqual(targets.sort(), ['test/other_test.dart', 'test/ui/profile_screen_test.dart']);
    assert.deepStrictEqual(unmatched, ['lib/untested.dart']);
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

// --- unit: the escape valve is session-scoped ---

test('escape-valve state from another session does not carry over', () => {
  const root = mkTmpDir('tl-state');
  try {
    const p = path.join(root, '.claude', 'hooks', 'state', 'stop-state.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });

    fs.writeFileSync(p, JSON.stringify({ sessionId: 'session-A', consecutiveBlocks: 3 }));
    assert.strictEqual(readState(root, 'session-A').consecutiveBlocks, 3);
    assert.strictEqual(readState(root, 'session-B').consecutiveBlocks, 0, 'another session must start at 0');

    // A hand-seeded file with no session marker is not trusted.
    fs.writeFileSync(p, JSON.stringify({ consecutiveBlocks: 99 }));
    assert.strictEqual(readState(root, 'session-A').consecutiveBlocks, 0);
  } finally {
    rmDir(root);
  }
});

// --- integration: inert without config, but NOT inert mid-run ---

test('hook is inert with no config / no stopGate block when no run is active', () => {
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

// Mid-run, a missing or unparsable profile is indistinguishable from someone disarming the
// gate, so it must block rather than pass silently.
test('an active run with an unusable stopGate config BLOCKS instead of passing silently', () => {
  for (const config of [undefined, { stack: 'python' }, '{ not json']) {
    const root = mkFakeRepo(config);
    try {
      const runDir = path.join(root, '.agents', 'ticket-runs', 'T-1');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'budget.json'), '{}');
      const res = runScript(SCRIPT, [], { cwd: root, input: '{}' });
      assert.strictEqual(res.status, 2, `config ${JSON.stringify(config)} should block mid-run`);
      assert.ok(res.stderr.includes('ACTIVE'));
    } finally {
      rmDir(root);
    }
  }
});

// --- integration: real git repo + worktrees ---

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

// Mark a run ACTIVE the way the hooks detect it: an initialized run dir with no close marker.
// Several "not verified" paths only speak up during a run, because a Stop mid-run is a "done"
// claim and a Stop outside one is not.
function markRunActive(main) {
  const runDir = path.join(main, '.agents', 'ticket-runs', 'T-1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'budget.json'), '{"dispatches":1}');
  return runDir;
}

function setupRepo({ branch = 'ticket/T-1', stopGate } = {}) {
  const base = mkTmpDir('tl-sg');
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'test@test');
  git(main, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(main, 'src'));
  fs.writeFileSync(path.join(main, 'src', 'app.py'), 'x = 1\n');
  // verify.test: fails iff a FAIL marker file exists in the tree under test
  fs.writeFileSync(path.join(main, 'check.js'), "process.exit(require('fs').existsSync('FAIL') ? 1 : 0);\n");
  fs.mkdirSync(path.join(main, '.agents'));
  // Real installs gitignore run state (INSTALL.md step 2); without it the run dir shows up as
  // an untracked change and skews what the gate thinks the session touched.
  fs.writeFileSync(path.join(main, '.gitignore'), '.agents/ticket-runs/\n.claude/hooks/state/\n');
  fs.writeFileSync(
    path.join(main, '.agents', 'ticket-loop.config.json'),
    JSON.stringify({
      verify: { test: 'node check.js' },
      hooks: { stopGate: stopGate || { extensions: ['.py'], mode: 'full', baseRef: 'main' } },
    })
  );
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(base, 'ticket-T-1');
  git(main, 'worktree', 'add', '-q', wt, '-b', branch);
  return { base, main, wt };
}
function teardown({ base, main, wt }) {
  spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: main, encoding: 'utf8' });
  rmDir(base);
}
const gate = (cwd, input = {}) => runScript(SCRIPT, [], { cwd, input: JSON.stringify(input) });

test('verifies the ticket worktree, not just the cwd tree', () => {
  const env = setupRepo();
  try {
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    assert.strictEqual(gate(env.main).status, 0);

    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
    const res = gate(env.main);
    assert.strictEqual(res.status, 2);
    assert.ok(res.stderr.includes('ticket-T-1'), `stderr should name the worktree:\n${res.stderr}`);
  } finally {
    teardown(env);
  }
});

// The case the whole gate exists for: Stage 4 commits after every green slice, so a
// git-status-only check sees a clean tree and exits 0 without running a single test.
test('COMMITTED slice work is detected — a clean-but-ahead worktree is still verified', () => {
  const env = setupRepo();
  try {
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 999\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
    git(env.wt, 'add', '-A');
    git(env.wt, 'commit', '-q', '-m', 'wip(T-1): slice green');

    assert.strictEqual(spawnSync('git', ['status', '--porcelain'], { cwd: env.wt, encoding: 'utf8' }).stdout.trim(), '');

    const res = gate(env.main);
    assert.strictEqual(res.status, 2, `a committed change with a red suite must block:\n${res.stderr}`);
  } finally {
    teardown(env);
  }
});

test('a worktree on a non-ticket branch is still checked (worktrees defaults to all)', () => {
  const env = setupRepo({ branch: 'feature/T-1' });
  try {
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
    assert.strictEqual(gate(env.main).status, 2);
  } finally {
    teardown(env);
  }
});

test('a detached-HEAD worktree is still checked', () => {
  const env = setupRepo();
  try {
    git(env.wt, 'checkout', '-q', '--detach', git(env.wt, 'rev-parse', 'HEAD').trim());
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
    assert.strictEqual(gate(env.main).status, 2);
  } finally {
    teardown(env);
  }
});

test('worktrees: "cwd" narrows the scope back for repos that want it', () => {
  const env = setupRepo({ stopGate: { extensions: ['.py'], mode: 'full', baseRef: 'main', worktrees: 'cwd' } });
  try {
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
    assert.strictEqual(gate(env.main).status, 0, 'only the cwd tree is in scope');
  } finally {
    teardown(env);
  }
});

// Two independent defenses cover a tiny timeoutMs: the floor, and timeout-treated-as-RED.
// A red suite blocks under either, so it cannot tell them apart — only a GREEN suite isolates
// the floor: without it, 50ms kills the test command and an honest pass is reported as RED.
test('the timeout floor protects a green suite from a tiny timeoutMs', () => {
  const env = setupRepo({ stopGate: { extensions: ['.py'], mode: 'full', baseRef: 'main', timeoutMs: 50 } });
  try {
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    // No FAIL marker: the suite is green. It still costs a process spawn, which is well over
    // 50ms and well under the 30s floor.
    const res = gate(env.main);
    assert.strictEqual(
      res.status,
      0,
      `a green suite must pass; timeoutMs:50 must be floored, not applied:\n${res.stderr}`
    );
    assert.ok(!/exceeded|treated as RED/i.test(res.stderr || ''), `must not report a timeout:\n${res.stderr}`);
  } finally {
    teardown(env);
  }
});

// A tiny timeoutMs must not turn a RED suite green either — belt to the braces above.
test('a tiny timeoutMs cannot disable the gate (it is floored)', () => {
  const env = setupRepo({ stopGate: { extensions: ['.py'], mode: 'full', baseRef: 'main', timeoutMs: 50 } });
  try {
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
    const res = gate(env.main);
    assert.strictEqual(res.status, 2, `timeoutMs:50 must not turn a red suite green:\n${res.stderr}`);
  } finally {
    teardown(env);
  }
});

test('a missing test binary degrades honestly to NOT verified', () => {
  const env = setupRepo();
  try {
    fs.writeFileSync(
      path.join(env.main, '.agents', 'ticket-loop.config.json'),
      JSON.stringify({
        verify: { test: 'definitely-not-a-real-binary-xyz' },
        hooks: { stopGate: { extensions: ['.py'], mode: 'full', baseRef: 'main' } },
      })
    );
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    const res = gate(env.main);
    assert.strictEqual(res.status, 0);
    assert.ok(res.stderr.includes('NOT verified'), res.stderr);
  } finally {
    teardown(env);
  }
});

test('requireMatchingTest blocks source changes that no test covers', () => {
  const env = setupRepo({
    stopGate: {
      extensions: ['.py'],
      mode: 'targeted',
      baseRef: 'main',
      testDir: 'test',
      testSuffix: '_test.py',
      testCommand: 'node check.js',
      requireMatchingTest: true,
    },
  });
  try {
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    const res = gate(env.main);
    assert.strictEqual(res.status, 2);
    assert.ok(res.stderr.includes('NO matching test file'), res.stderr);
  } finally {
    teardown(env);
  }
});

test('clean trees pass without running anything; escape valve releases after 3 blocks', () => {
  const env = setupRepo();
  try {
    assert.strictEqual(gate(env.main).status, 0);

    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 3\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(gate(env.main, { session_id: 's1' }).status, 2);
    }
    const res = gate(env.main, { session_id: 's1', stop_hook_active: true });
    assert.strictEqual(res.status, 0);
    assert.ok(res.stderr.includes('NOT green'));
  } finally {
    teardown(env);
  }
});

// --- the default-branch blind spot -------------------------------------------------------
//
// The gate diffs merge-base(HEAD, baseRef)..HEAD. When HEAD *is* the branch point — a session
// committing straight to the default branch rather than a ticket branch — that diff is empty
// and the tree is clean, which is the same clean-tree-passes-nothing failure as a
// working-tree-only check, one topology to the left.
test('committed work on the default branch is not passed on an empty diff', () => {
  const env = setupRepo();
  try {
    markRunActive(env.main);
    fs.writeFileSync(path.join(env.main, 'src', 'app.py'), 'x = 2\n');
    fs.writeFileSync(path.join(env.main, 'FAIL'), '');
    git(env.main, 'add', '-A');
    git(env.main, 'commit', '-q', '-m', 'work committed straight to main');
    assert.strictEqual(git(env.main, 'status', '--porcelain').trim(), '', 'tree must be clean');

    const res = gate(env.main);
    assert.strictEqual(res.status, 2, `a red suite must block even with no visible branch point:\n${res.stderr}`);
    assert.ok(res.stderr.includes('HEAD IS the branch point'), res.stderr);
  } finally {
    teardown(env);
  }
});

test('the same situation with a green suite passes, but says what it could not see', () => {
  const env = setupRepo();
  try {
    markRunActive(env.main);
    fs.writeFileSync(path.join(env.main, 'src', 'app.py'), 'x = 2\n');
    git(env.main, 'add', '-A');
    git(env.main, 'commit', '-q', '-m', 'green work on main');

    const res = gate(env.main);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.stderr.includes('no visible branch point'), res.stderr);
  } finally {
    teardown(env);
  }
});

// --- silent skips ------------------------------------------------------------------------
//
// extensions/exclude that match nothing produced NO output at all, so Stage 7's "say plainly
// what was NOT verified" had nothing to report and the run read as verified.
test('a profile whose filters match nothing says so instead of passing quietly', () => {
  const env = setupRepo({ stopGate: { extensions: ['.nope'], mode: 'full', baseRef: 'main' } });
  try {
    markRunActive(env.main);
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');

    const res = gate(env.main);
    assert.strictEqual(res.status, 0, 'narrow filters are the repo owner\'s call, so this does not block');
    assert.ok(res.stderr.includes('NONE matched'), res.stderr);
    assert.ok(res.stderr.includes('NOTHING was verified'), res.stderr);
  } finally {
    teardown(env);
  }
});

test('exclude that swallows every changed file is reported too', () => {
  const env = setupRepo({ stopGate: { extensions: ['.py'], exclude: '.*', mode: 'full', baseRef: 'main' } });
  try {
    markRunActive(env.main);
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');

    const res = gate(env.main);
    assert.strictEqual(res.status, 0);
    assert.ok(res.stderr.includes('NONE matched'), res.stderr);
  } finally {
    teardown(env);
  }
});

test('outside a run the gate stays quiet and cheap', () => {
  const env = setupRepo({ stopGate: { extensions: ['.nope'], mode: 'full', baseRef: 'main' } });
  try {
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    const res = gate(env.main);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stderr.trim(), '', 'no ticket run means no "done" claim to police');
  } finally {
    teardown(env);
  }
});
