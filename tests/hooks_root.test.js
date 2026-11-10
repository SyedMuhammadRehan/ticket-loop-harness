'use strict';
// The invariant under test: the gates are armed by the run, not by where the session happens to
// be. A real repo with a linked ticket worktree and an open run is driven from the repo root,
// from the worktree, from deep inside the repo and from the folder above it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HOOKS_DIR, SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');
const lib = require(path.join(HOOKS_DIR, 'hook_lib.js'));

const PROFILE = {
  verify: { test: 'node tests.js', analyze: 'node lint.js' },
  riskPaths: ['lib/auth/**'],
  hooks: { stopGate: { extensions: ['.js'], mode: 'full' } },
};
const DEEP = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

function git(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// parent/repo is the main checkout, parent/wt its ticket worktree with one committed slice.
function openRun() {
  const parent = mkTmpDir('tl-root');
  const repo = path.join(parent, 'repo');
  const wt = path.join(parent, 'wt');
  fs.mkdirSync(path.join(repo, 'lib', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.agents'));
  fs.mkdirSync(path.join(repo, ...DEEP), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'dev@example.com']);
  git(repo, ['config', 'user.name', 'dev']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, '.agents', 'ticket-loop.config.json'), JSON.stringify(PROFILE));
  fs.writeFileSync(path.join(repo, 'tests.js'), 'process.exit(1);\n');
  fs.writeFileSync(path.join(repo, 'lib', 'auth', 'token.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, ...DEEP, 'keep.txt'), '');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['worktree', 'add', '-q', wt, '-b', 'ticket/T-1', base]);
  fs.writeFileSync(path.join(wt, 'feature.js'), 'module.exports = 2;\n');
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-qm', 'slice']);
  const runDir = path.join(repo, '.agents', 'ticket-runs', 'T-1');
  fs.mkdirSync(runDir, { recursive: true });
  const init = runScript(path.join(SCRIPTS_DIR, 'ledger.js'), ['init', runDir, base], { cwd: repo });
  assert.strictEqual(init.status, 0, init.stderr);
  return { parent, repo, wt, runDir, deep: path.join(repo, ...DEEP) };
}

const hook = (name, payload) => runScript(path.join(HOOKS_DIR, name), [], { input: JSON.stringify(payload), cwd: payload.cwd });
const guard = (cwd, tool, toolInput) => hook('freeze_guard.js', { tool_name: tool, tool_input: toolInput, cwd, session_id: 's1' });
const dispatches = (r) => JSON.parse(runScript(path.join(SCRIPTS_DIR, 'ledger.js'), ['status', r.runDir], { cwd: r.repo }).stdout).dispatches;

test('a linked worktree, a deep subfolder and the repo root all resolve to the main checkout', () => {
  const r = openRun();
  try {
    for (const start of [r.repo, r.wt, r.deep]) {
      // Git records the worktree's main checkout by its long name; the temp dir may be a short one.
      assert.strictEqual(fs.realpathSync.native(lib.findRepoRoot(start)), fs.realpathSync.native(r.repo), start);
    }
    assert.strictEqual(lib.findRepoRoot(r.parent), r.parent, 'outside a repo the start is returned as before');
  } finally {
    rmDir(r.parent);
  }
});

test('the write guard is armed from the ticket worktree and from deep inside the repo', () => {
  const r = openRun();
  try {
    for (const cwd of [r.wt, r.deep]) {
      const risk = guard(cwd, 'Edit', { file_path: path.join(r.wt, 'lib', 'auth', 'token.js') });
      assert.strictEqual(risk.status, 2, `risk path from ${cwd}: ${risk.stderr}`);
      assert.match(risk.stderr, /risk-tier path/);
      const profile = guard(cwd, 'Edit', { file_path: path.join(r.repo, '.agents', 'ticket-loop.config.json') });
      assert.strictEqual(profile.status, 2, `profile from ${cwd}`);
      assert.match(profile.stderr, /control plane/);
      const push = guard(cwd, 'Bash', { command: 'git push origin ticket/T-1' });
      assert.strictEqual(push.status, 2, `push from ${cwd}`);
      assert.match(push.stderr, /git push/);
      assert.strictEqual(guard(cwd, 'Bash', { command: 'git status' }).status, 0, 'an ordinary read still passes');
    }
    const shellWrite = guard(r.wt, 'Bash', { command: 'echo x > lib/auth/token.js' });
    assert.strictEqual(shellWrite.status, 2, shellWrite.stderr);
  } finally {
    rmDir(r.parent);
  }
});

test('from the folder above the repo, an edit or a command that names the repo is still judged by its run', () => {
  const r = openRun();
  try {
    const profile = guard(r.parent, 'Edit', { file_path: path.join(r.repo, '.agents', 'ticket-loop.config.json') });
    assert.strictEqual(profile.status, 2, profile.stderr);
    const risk = guard(r.parent, 'Write', { file_path: path.join(r.wt, 'lib', 'auth', 'new.js') });
    assert.strictEqual(risk.status, 2, risk.stderr);
    const push = guard(r.parent, 'Bash', { command: `git -C ${r.repo.replace(/\\/g, '/')} push origin main` });
    assert.strictEqual(push.status, 2, push.stderr);
    const relative = guard(r.parent, 'Bash', { command: 'cd repo && git push origin main' });
    assert.strictEqual(relative.status, 2, relative.stderr);
    const elsewhere = guard(r.parent, 'Edit', { file_path: path.join(r.parent, 'notes.md') });
    assert.strictEqual(elsewhere.status, 0, 'a file outside every repo is nobody\'s control plane');
  } finally {
    rmDir(r.parent);
  }
});

test('a dispatch is counted, and a red suite blocks the stop, from the worktree as from the root', () => {
  const r = openRun();
  try {
    const agent = { subagent_type: 'general-purpose', description: 'slice', prompt: 'implement the slice' };
    for (const cwd of [r.repo, r.wt, r.deep]) {
      const d = hook('dispatch_guard.js', { tool_name: 'Agent', tool_input: agent, cwd, session_id: 's1' });
      assert.strictEqual(d.status, 0, d.stderr);
    }
    assert.strictEqual(dispatches(r), 3, 'every dispatch reached the chain, wherever the session sat');

    for (const o of JSON.parse(runScript(path.join(SCRIPTS_DIR, 'ledger.js'), ['status', r.runDir], { cwd: r.repo }).stdout).open) {
      runScript(path.join(SCRIPTS_DIR, 'ledger.js'), ['outcome', r.runDir, String(o.seqs[0]), 'ok'], { cwd: r.repo });
    }
    for (const cwd of [r.repo, r.wt]) {
      const stop = hook('stop_gate.js', { cwd, session_id: `s-${path.basename(cwd)}`, hook_event_name: 'Stop' });
      assert.strictEqual(stop.status, 2, `stop from ${cwd} must run the red suite: ${stop.stderr}`);
      assert.match(stop.stderr, /tests FAILED/);
    }
  } finally {
    rmDir(r.parent);
  }
});

test('the session project dir locates the run when the working directory is outside the repo', () => {
  const r = openRun();
  try {
    const agent = { subagent_type: 'general-purpose', description: 'slice', prompt: 'implement the slice' };
    const payload = { tool_name: 'Agent', tool_input: agent, cwd: r.parent, session_id: 's1' };
    const blind = runScript(path.join(HOOKS_DIR, 'dispatch_guard.js'), [], { input: JSON.stringify(payload), cwd: r.parent });
    assert.strictEqual(blind.status, 0);
    assert.strictEqual(dispatches(r), 0, 'with nothing naming the repo there is no run to find');
    const seen = runScript(path.join(HOOKS_DIR, 'dispatch_guard.js'), [], {
      input: JSON.stringify(payload),
      cwd: r.parent,
      env: { CLAUDE_PROJECT_DIR: r.repo },
    });
    assert.strictEqual(seen.status, 0, seen.stderr);
    assert.strictEqual(dispatches(r), 1);
  } finally {
    rmDir(r.parent);
  }
});
