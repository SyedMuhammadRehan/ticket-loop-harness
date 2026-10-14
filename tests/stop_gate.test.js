'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { HOOKS_DIR, mkTmpDir, rmDir, runScript, mkFakeRepo, ledger } = require('./helpers.js');

const SCRIPT = path.join(HOOKS_DIR, 'stop_gate.js');
const {
  parseWorktrees, mapTargets, batchTargets, looksLikeFlake, readState, spawnTimeoutMs, verdictOf, verifyTree,
  MIN_TEST_TIMEOUT_MS, HOOK_BUDGET_MS,
} = require(SCRIPT);

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

// --- unit: targets are batched under the command-line limit ---

test('batchTargets keeps every target once, in order, with each command under the limit', () => {
  const targets = Array.from({ length: 9 }, (_, i) => `test/area/file_${i}_test.dart`);
  const batches = batchTargets('flutter test {targets} --reporter compact', targets, 100);
  assert.ok(batches.length > 1, 'nine 25-char paths cannot fit one 100-char command');
  assert.deepStrictEqual(batches.flat(), targets);
  for (const b of batches) {
    assert.ok(`flutter test ${b.join(' ')} --reporter compact`.length <= 100, b.join(' '));
  }
  assert.deepStrictEqual(batchTargets('x {targets}', targets, 100000), [targets], 'a roomy limit is one command');
  assert.deepStrictEqual(batchTargets('x {targets}', ['a'.repeat(500)], 100), [['a'.repeat(500)]], 'an oversize single target still runs');
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

// Start a run the way the playbook does: an initialized run dir with its receipt chain under the
// repo's git dir. Several "not verified" paths only speak up during a run, because a Stop mid-run
// is a "done" claim and a Stop outside one is not.
function markRunActive(main) {
  const runDir = path.join(main, '.agents', 'ticket-runs', 'T-1');
  fs.mkdirSync(runDir, { recursive: true });
  const res = ledger(main, ['init', runDir, 'abc']);
  assert.strictEqual(res.status, 0, res.stderr);
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
  markRunActive(env.main);
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
  markRunActive(env.main);
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
  markRunActive(env.main);
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
  markRunActive(env.main);
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
  markRunActive(env.main);
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
  markRunActive(env.main);
  try {
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
    const res = gate(env.main);
    assert.strictEqual(res.status, 2, `timeoutMs:50 must not turn a red suite green:\n${res.stderr}`);
  } finally {
    teardown(env);
  }
});

// The floor and the ceiling are each a line of arithmetic a refactor can drop; a fast machine
// would not notice either through a real suite.
test('the test timeout is floored, so a tiny timeoutMs cannot disable the gate', () => {
  assert.strictEqual(spawnTimeoutMs(50, Infinity), MIN_TEST_TIMEOUT_MS);
  assert.strictEqual(spawnTimeoutMs(0, Infinity), 240000, 'an unset timeout is the default');
  assert.strictEqual(spawnTimeoutMs(Number.NaN, Infinity), 240000);
  assert.strictEqual(spawnTimeoutMs(100000, Infinity), 100000);
});

test('the test timeout never outlasts the hook\'s own deadline', () => {
  assert.ok(HOOK_BUDGET_MS < 600000, 'hooks.json kills the Stop hook at 600 s');
  assert.strictEqual(spawnTimeoutMs(900000, 540000), 540000);
  assert.strictEqual(spawnTimeoutMs(50, 1000), 1000, 'the deadline wins over the floor: a spent budget blocks');
  assert.strictEqual(spawnTimeoutMs(240000, -5), 0, 'a spent deadline is 0, never a negative or unlimited timeout');
});

// On Windows a timeout kills cmd.exe, not the node it started, which holds the tree open until it
// exits; the test waits it out before removing the tree.
const SLOW_SUITE_MS = 4000;
test('a suite slower than what is left of the hook\'s deadline blocks as not verified in time', async () => {
  const env = setupRepo();
  try {
    fs.writeFileSync(path.join(env.wt, 'slow.js'), `setTimeout(() => process.exit(0), ${SLOW_SUITE_MS});\n`);
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    const conf = { extensions: ['.py'], mode: 'full', baseRef: 'main', timeoutMs: 600000 };
    const soon = verifyTree(env.wt, conf, 'node slow.js', true, Date.now() + 1500);
    assert.strictEqual(soon.ok, false, 'a green suite that outruns the deadline is not a pass');
    assert.match(soon.tail, /time budget/);
    const spent = verifyTree(env.wt, conf, 'node check.js', true, Date.now() - 1);
    assert.strictEqual(spent.ok, false);
    assert.match(spent.tail, /time budget/);
  } finally {
    await new Promise((r) => setTimeout(r, SLOW_SUITE_MS));
    teardown(env);
  }
});

test('only the spawn or the shell\'s own exit code says a test command could not start', () => {
  assert.strictEqual(verdictOf({ status: 1, stdout: 'cat: fixture: No such file or directory' }), 'fail');
  assert.strictEqual(verdictOf({ status: 1, stderr: "'x' is not recognized as an internal or external command" }), 'fail');
  assert.strictEqual(verdictOf({ status: 127 }), 'unrunnable');
  assert.strictEqual(verdictOf({ status: 9009 }), 'unrunnable');
  assert.strictEqual(verdictOf({ status: null, error: Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }) }), 'unrunnable');
  assert.strictEqual(verdictOf({ status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }), 'timeout');
  assert.strictEqual(verdictOf({ status: null, capped: true, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }), 'budget');
  assert.strictEqual(verdictOf({ status: 0 }), 'pass');
});

test('a test command that cannot start blocks the "done" claim mid-run', () => {
  const env = setupRepo();
  markRunActive(env.main);
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
    assert.strictEqual(res.status, 2, 'a suite that never ran has verified nothing');
    assert.ok(res.stderr.includes('definitely-not-a-real-binary-xyz'), res.stderr);

    // cmd.exe exits 1 for a missing binary, so the shell's not-found code is driven directly.
    fs.writeFileSync(
      path.join(env.main, '.agents', 'ticket-loop.config.json'),
      JSON.stringify({
        verify: { test: 'node -e process.exit(127)' },
        hooks: { stopGate: { extensions: ['.py'], mode: 'full', baseRef: 'main' } },
      })
    );
    const notFound = gate(env.main);
    assert.strictEqual(notFound.status, 2, notFound.stderr);
    assert.match(notFound.stderr, /could not start/);
  } finally {
    teardown(env);
  }
});

test('a targeted test command whose binary is missing blocks too', () => {
  const env = targetedRepo({ testCommand: 'definitely-not-a-real-binary-xyz {targets}' });
  markRunActive(env.main);
  try {
    const res = gate(env.main);
    assert.strictEqual(res.status, 2, res.stderr);
    if (process.platform !== 'win32') assert.match(res.stderr, /could not start/);
  } finally {
    teardown(env);
  }
});

// A gate that hands the runner one command naming every mapped test file stops working at the
// exact size of change it exists to verify.
function targetedRepo(extra = {}) {
  const env = setupRepo({
    stopGate: {
      extensions: ['.py'],
      mode: 'targeted',
      baseRef: 'main',
      testDir: 'test',
      testSuffix: '_test.py',
      testCommand: 'node record.js {targets}',
      ...extra,
    },
  });
  fs.writeFileSync(
    path.join(env.wt, 'record.js'),
    "const fs = require('fs');\n" +
      "const args = process.argv.slice(2);\n" +
      "fs.appendFileSync('calls.log', args.join(' ') + '\\n');\n" +
      "process.exit(fs.existsSync('FAIL_M4') && args.some((a) => a.includes('m4_test')) ? 1 : 0);\n"
  );
  fs.mkdirSync(path.join(env.wt, 'test'), { recursive: true });
  for (let i = 1; i <= 6; i++) {
    fs.writeFileSync(path.join(env.wt, 'src', `m${i}.py`), `x = ${i}\n`);
    fs.writeFileSync(path.join(env.wt, 'test', `m${i}_test.py`), '');
  }
  return env;
}

test('a change mapping to many test files runs them in batches, every file once', () => {
  const env = targetedRepo({ maxCommandChars: 60 });
  markRunActive(env.main);
  try {
    const res = gate(env.main);
    assert.strictEqual(res.status, 0, res.stderr);
    const calls = fs.readFileSync(path.join(env.wt, 'calls.log'), 'utf8').trim().split('\n');
    assert.ok(calls.length > 1, `expected several commands, got:\n${calls.join('\n')}`);
    const seen = calls.flatMap((c) => c.split(' ')).sort();
    assert.deepStrictEqual(seen, Array.from({ length: 6 }, (_, i) => `test/m${i + 1}_test.py`).sort());
    for (const c of calls) assert.ok(`node record.js ${c}`.length <= 60, c);
  } finally {
    teardown(env);
  }
});

test('a failing batch blocks like a failing suite', () => {
  const env = targetedRepo({ maxCommandChars: 60 });
  markRunActive(env.main);
  try {
    fs.writeFileSync(path.join(env.wt, 'FAIL_M4'), '');
    const res = gate(env.main);
    assert.strictEqual(res.status, 2, res.stderr);
    assert.ok(res.stderr.includes('tests FAILED'), res.stderr);
  } finally {
    teardown(env);
  }
});

// A red suite that prints a missing-file message must stay red: read from output text, "could
// not start" would turn every such failure into a pass.
test('a red suite whose output says "No such file or directory" still blocks', () => {
  for (const said of ['No such file or directory', 'The command line is too long.', 'command not found']) {
    const env = targetedRepo({ testCommand: 'node refuse.js {targets}' });
    markRunActive(env.main);
    try {
      fs.writeFileSync(path.join(env.wt, 'refuse.js'), `console.error(${JSON.stringify(said)}); process.exit(1);\n`);
      const res = gate(env.main);
      assert.strictEqual(res.status, 2, `"${said}" in a red suite's output passed the gate:\n${res.stderr}`);
      assert.ok(res.stderr.includes('tests FAILED'), res.stderr);
    } finally {
      teardown(env);
    }
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
  markRunActive(env.main);
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
  markRunActive(env.main);
  try {
    assert.strictEqual(gate(env.main).status, 0);

    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 3\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(gate(env.main, { session_id: 's1' }).status, 2);
    }
    const res = gate(env.main, { session_id: 's1', stop_hook_active: true });
    assert.strictEqual(res.status, 0);
    assert.ok(res.stderr.includes('NOT verified') && res.stderr.includes('NOT a pass'), res.stderr);
  } finally {
    teardown(env);
  }
});

// --- open dispatches -----------------------------------------------------------------------
//
// A Stop mid-run is a "done" claim. A dispatch whose result was never recorded is work the claim
// says nothing about, and it is what a stalled worker and a forgotten outcome both look like.

test('a turn may end while agents work, but a dispatch gone quiet past the threshold blocks it', () => {
  const env = setupRepo();
  try {
    const runDir = path.join(env.main, '.agents', 'ticket-runs', 'T-1');
    fs.mkdirSync(runDir, { recursive: true });
    assert.strictEqual(ledger(env.main, ['init', runDir, 'abc']).status, 0);
    assert.strictEqual(gate(env.main).status, 0, 'a run with no dispatches has nothing open');

    assert.strictEqual(ledger(env.main, ['dispatch', runDir, 'implementer: C1', '--source', 'hook']).status, 0);
    const waiting = gate(env.main);
    assert.strictEqual(waiting.status, 0, waiting.stderr);
    assert.match(waiting.stderr, /still out, no outcome yet/);

    // A run is governed by the profile it started under, so the stall is shown on a run that
    // began with a zero threshold.
    const profile = path.join(env.main, '.agents', 'ticket-loop.config.json');
    fs.writeFileSync(profile, JSON.stringify({ ...JSON.parse(fs.readFileSync(profile, 'utf8')), dispatchPolicy: { stallMinutes: 0 } }));
    const quiet = path.join(env.main, '.agents', 'ticket-runs', 'T-2');
    fs.mkdirSync(quiet, { recursive: true });
    assert.strictEqual(ledger(env.main, ['init', quiet, 'abc']).status, 0);
    assert.strictEqual(ledger(env.main, ['dispatch', quiet, 'implementer: C1', '--source', 'hook']).status, 0);
    const blocked = gate(env.main);
    assert.strictEqual(blocked.status, 2, blocked.stderr);
    assert.ok(blocked.stderr.includes('no sign of life') && blocked.stderr.includes('seq 2'), blocked.stderr);

    assert.strictEqual(ledger(env.main, ['outcome', quiet, '2', 'died', 'session limit']).status, 0);
    assert.strictEqual(gate(env.main).status, 0, 'a recorded death is an outcome');
  } finally {
    teardown(env);
  }
});

test('a stop in a repo whose open run belongs to another session says whose it is and how to end it', () => {
  const env = setupRepo();
  try {
    const runDir = path.join(env.main, '.agents', 'ticket-runs', 'T-1');
    fs.mkdirSync(runDir, { recursive: true });
    assert.strictEqual(ledger(env.main, ['init', runDir, 'abc']).status, 0);
    assert.strictEqual(ledger(env.main, ['dispatch', runDir, 'implementer: C1', '--source', 'hook', '--session', 's1']).status, 0);
    assert.strictEqual(ledger(env.main, ['outcome', runDir, '2', 'ok']).status, 0);
    const own = gate(env.main, { session_id: 's1' });
    assert.strictEqual(own.status, 0, own.stderr);
    assert.ok(!own.stderr.includes('another session'), own.stderr);
    const other = gate(env.main, { session_id: 's2' });
    assert.strictEqual(other.status, 0, 'a clean tree still passes; the note is information');
    assert.ok(other.stderr.includes('another session') && other.stderr.includes('archive'), other.stderr);
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

// Dirty matching files with no run active is the common case, not an edge one: every ordinary
// session in a ticket-loop repo ends turns that way.
test('outside a run the gate runs nothing, even when changed files match', () => {
  const env = setupRepo();
  try {
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), ''); // the suite exits 1 if it is run at all
    const res = gate(env.main);
    assert.strictEqual(res.status, 0, `no ticket run means no "done" claim to police:\n${res.stderr}`);
    assert.strictEqual(res.stderr.trim(), '', 'an inert gate is silent');
  } finally {
    teardown(env);
  }
});

// The same tree mid-run must still be verified: run-scoping the gate must not disable it.
test('the identical situation mid-run still blocks on a red suite', () => {
  const env = setupRepo();
  try {
    markRunActive(env.main);
    fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 2\n');
    fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
    assert.strictEqual(gate(env.main).status, 2, 'mid-run a red suite must block the "done" claim');
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

// A green suite says nothing about a stray console.log or a committed credential. The gate reads
// the added lines too, so neither reaches a "done" claim on the strength of an exit code.
test('a green suite still blocks when the change adds a debug artefact', () => {
  const env = setupRepo({ stopGate: { extensions: ['.js'], mode: 'full', baseRef: 'main' } });
  try {
    markRunActive(env.main);
    fs.writeFileSync(path.join(env.wt, 'src', 'app.js'), 'const a = 1;\nconsole.log("left behind");\n');
    const res = gate(env.main);
    assert.strictEqual(res.status, 2, 'a debug artefact must block even with the suite green');
    assert.ok(/console\.log/.test(res.stderr), res.stderr);
    assert.ok(/src\/app\.js/.test(res.stderr), res.stderr);
  } finally {
    teardown(env);
  }
});

test('a green suite still blocks when the change adds an apparent secret, without echoing it', () => {
  const env = setupRepo({ stopGate: { extensions: ['.js'], mode: 'full', baseRef: 'main' } });
  try {
    markRunActive(env.main);
    fs.writeFileSync(path.join(env.wt, 'src', 'app.js'), 'const apiKey = "sk-live-9f2a7c41b8";\n');
    const res = gate(env.main);
    assert.strictEqual(res.status, 2, 'an apparent secret must block even with the suite green');
    assert.ok(/redacted/.test(res.stderr), res.stderr);
    assert.ok(!/sk-live-9f2a7c41b8/.test(res.stderr), 'the gate echoed the secret back into the session');
  } finally {
    teardown(env);
  }
});

test('the hygiene scan can be turned off by the profile', () => {
  const env = setupRepo({ stopGate: { extensions: ['.js'], mode: 'full', baseRef: 'main', hygiene: false } });
  try {
    markRunActive(env.main);
    fs.writeFileSync(path.join(env.wt, 'src', 'app.js'), 'console.log("allowed here");\n');
    assert.strictEqual(gate(env.main).status, 0, 'hygiene:false must leave the gate deciding on the suite alone');
  } finally {
    teardown(env);
  }
});

// The change that reformats a file is not the change that added the logging in it.
test('logging that was already there does not block a later change', () => {
  const env = setupRepo({ stopGate: { extensions: ['.js'], mode: 'full', baseRef: 'main' } });
  try {
    fs.writeFileSync(path.join(env.main, 'src', 'app.js'), 'console.log("pre-existing");\nconst a = 1\n');
    git(env.main, 'add', '-A');
    git(env.main, 'commit', '-q', '-m', 'pre-existing logging');
    git(env.wt, 'merge', '-q', 'main');
    markRunActive(env.main);
    fs.writeFileSync(path.join(env.wt, 'src', 'app.js'), 'console.log("pre-existing");\nconst a = 1;\n');
    assert.strictEqual(gate(env.main).status, 0, 'only the semicolon was added; the logging predates this change');
  } finally {
    teardown(env);
  }
});

// --- a repo cannot run code by shipping a run -------------------------------------------
//
// A budget.json is a file any repo can commit; a receipt chain lives under this machine's git dir,
// which no clone can write. Only a run with a chain may make the gate execute the profile.
test('a run dir the repo committed, with no receipt chain here, runs no profile command and blocks', () => {
  const env = setupRepo();
  try {
    fs.writeFileSync(
      path.join(env.main, '.agents', 'ticket-loop.config.json'),
      JSON.stringify({
        verify: { test: 'node pwn.js' },
        hooks: { stopGate: { extensions: ['.py'], mode: 'full', baseRef: 'main' } },
      })
    );
    fs.writeFileSync(path.join(env.main, 'pwn.js'), "require('fs').writeFileSync('PWNED', 'x');\n");
    const runDir = path.join(env.main, '.agents', 'ticket-runs', 'T-1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'budget.json'), '{"dispatches":0}');
    fs.writeFileSync(path.join(env.main, 'src', 'app.py'), 'x = 2\n');

    const res = gate(env.main);
    assert.ok(!fs.existsSync(path.join(env.main, 'PWNED')), 'the repo\'s verify.test ran on a run this machine never started');
    assert.strictEqual(res.status, 2, 'a run that cannot be verified is not a pass');
    assert.match(res.stderr, /no receipt chain/);
    assert.match(res.stderr, /NOT run/);
  } finally {
    teardown(env);
  }
});

function runAsync(script, { cwd, env = {}, input }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env } });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stderr }));
    child.stdin.end(input);
  });
}

test('the escape valve tells the person the run is not verified, once', async (t) => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const env = setupRepo();
  t.after(() => teardown(env));
  const notifyFile = path.join(env.base, 'notify.json');
  fs.writeFileSync(notifyFile, JSON.stringify({ channels: [{ type: 'webhook', url: `http://127.0.0.1:${server.address().port}/hook` }] }));
  markRunActive(env.main);
  fs.writeFileSync(path.join(env.wt, 'src', 'app.py'), 'x = 3\n');
  fs.writeFileSync(path.join(env.wt, 'FAIL'), '');
  const stop = (extra) =>
    runAsync(SCRIPT, {
      cwd: env.main,
      env: { TICKET_LOOP_NOTIFY: notifyFile, CLAUDE_PLUGIN_ROOT: '', TICKET_LOOP_POLICY: path.join(env.base, 'no-policy.json') },
      input: JSON.stringify({ session_id: 's1', ...extra }),
    });
  for (let i = 0; i < 3; i++) assert.strictEqual((await stop({})).status, 2);
  assert.strictEqual(bodies.length, 0, 'a block is not news');
  const released = await stop({ stop_hook_active: true });
  assert.strictEqual(released.status, 0);
  assert.strictEqual(bodies.length, 1, released.stderr);
  assert.match(JSON.parse(bodies[0]).text, /NOT verified/);
  assert.match(JSON.parse(bodies[0]).text, /NOT a pass/);
});
