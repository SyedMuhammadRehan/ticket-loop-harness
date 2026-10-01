'use strict';
// init writes a profile the preflight accepts and refuses to overwrite or to run mid-run; doctor
// finds what broke a field repo for weeks — no profile, run state not ignored, stale pre-plugin
// hook copies, an abandoned run, leftover worktrees — and changes nothing while it looks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SCRIPTS_DIR, mkTmpDir, rmDir, runScript, ledger } = require('./helpers.js');

const INIT = path.join(SCRIPTS_DIR, 'init.js');
const DOCTOR = path.join(SCRIPTS_DIR, 'doctor.js');
const LOAD_CONFIG = path.join(SCRIPTS_DIR, 'load_config.js');

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function repo(files) {
  const root = mkTmpDir('tl-setup');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base', '--allow-empty');
  return root;
}

const NODE_REPO = { 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'node --test', lint: 'eslint .' } }), 'package-lock.json': '{}' };
const home = mkTmpDir('tl-home');
const run = (script, root, args = []) => runScript(script, args, { cwd: root, env: { HOME: home, USERPROFILE: home } });
const doctor = (root) => JSON.parse(run(DOCTOR, root, ['--json']).stdout);

test('init writes a profile the preflight accepts, with run state gitignored', () => {
  const root = repo(NODE_REPO);
  try {
    const res = run(INIT, root);
    assert.strictEqual(res.status, 0, res.stderr);
    const cfg = JSON.parse(run(LOAD_CONFIG, root).stdout);
    assert.strictEqual(cfg._meta.configFound, true);
    assert.deepStrictEqual(cfg._meta.warnings, [], cfg._meta.warnings.join('\n'));
    assert.strictEqual(cfg.stack, 'node');
    assert.strictEqual(cfg.verify.test, 'npm test');
    assert.strictEqual(cfg.hooks.stopGate.baseRef, 'main');
    assert.ok(cfg.riskPaths.includes('package.json'));
    assert.strictEqual(spawnSync('git', ['-C', root, 'check-ignore', '-q', '.agents/ticket-runs/x']).status, 0);
    assert.ok(res.stdout.includes('review before the first run'));
  } finally {
    rmDir(root);
  }
});

test('init detects flutter, python and go from their manifests', () => {
  for (const [files, stack, testCmd] of [
    [{ 'pubspec.yaml': 'name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n' }, 'flutter', 'flutter test'],
    [{ 'pyproject.toml': '[tool.pytest]\n[tool.ruff]\n' }, 'python', 'pytest -q'],
    [{ 'go.mod': 'module example.com/x\n' }, 'go', 'go test ./...'],
  ]) {
    const root = repo(files);
    try {
      const res = run(INIT, root, ['--dry-run']);
      assert.strictEqual(res.status, 0, res.stderr);
      assert.ok(!fs.existsSync(path.join(root, '.agents', 'ticket-loop.config.json')), '--dry-run writes nothing');
      const profile = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'), res.stdout.lastIndexOf('}') + 1));
      assert.strictEqual(profile.stack, stack);
      assert.strictEqual(profile.verify.test, testCmd);
    } finally {
      rmDir(root);
    }
  }
});

test('init never overwrites a profile and never runs while a run is open', () => {
  const root = repo(NODE_REPO);
  try {
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), '{"verify":{"test":"mine"}}');
    const again = run(INIT, root);
    assert.strictEqual(again.status, 1);
    assert.ok(again.stderr.includes('already exists'), again.stderr);
    assert.strictEqual(fs.readFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), 'utf8'), '{"verify":{"test":"mine"}}');

    fs.rmSync(path.join(root, '.agents', 'ticket-loop.config.json'));
    const runDir = path.join(root, '.agents', 'ticket-runs', 'T-1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'budget.json'), '{}');
    const midRun = run(INIT, root);
    assert.strictEqual(midRun.status, 1);
    assert.ok(midRun.stderr.includes('is open'), midRun.stderr);
    assert.ok(!fs.existsSync(path.join(root, '.agents', 'ticket-loop.config.json')));
  } finally {
    rmDir(root);
  }
});

test('doctor reports a repo with no profile and unignored run state as problems', () => {
  const root = repo(NODE_REPO);
  try {
    const res = run(DOCTOR, root, ['--json']);
    assert.strictEqual(res.status, 1);
    const report = JSON.parse(res.stdout);
    assert.ok(report.findings.some((f) => f.level === 'problem' && /no profile/.test(f.what)), res.stdout);
    assert.ok(report.findings.some((f) => f.level === 'problem' && /ticket-runs\/ is not gitignored/.test(f.what)), res.stdout);
  } finally {
    rmDir(root);
  }
});

test('doctor passes a freshly initialised repo, then finds stale copies, an abandoned run and a leftover worktree', () => {
  const root = repo(NODE_REPO);
  const wt = `${root}-wt`;
  try {
    assert.strictEqual(run(INIT, root).status, 0);
    const healthy = run(DOCTOR, root, ['--json']);
    assert.strictEqual(healthy.status, 0, healthy.stdout);

    fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'hooks', 'freeze_guard.js'), '');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), 'utf8'));
    fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify({ ...cfg, staleRunHours: 0 }));
    const runDir = path.join(root, '.agents', 'ticket-runs', 'T-9');
    fs.mkdirSync(runDir, { recursive: true });
    assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
    git(root, 'worktree', 'add', '-q', wt, '-b', 'ticket/OLD-1');

    const before = fs.readdirSync(path.join(root, '.claude', 'hooks'));
    const report = doctor(root);
    const problems = report.findings.filter((f) => f.level === 'problem').map((f) => f.what);
    assert.ok(problems.some((p) => /stale pre-plugin copy: .*freeze_guard\.js/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /run T-9 has been open and idle/.test(p)), problems.join('\n'));
    assert.ok(report.findings.some((f) => /worktree .*ticket\/OLD-1.*no open run/.test(f.what) && /git worktree remove/.test(f.fix)), JSON.stringify(report.findings));
    assert.deepStrictEqual(fs.readdirSync(path.join(root, '.claude', 'hooks')), before, 'doctor changes nothing');
    assert.ok(fs.existsSync(wt), 'doctor removes nothing');
  } finally {
    spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', wt]);
    rmDir(root);
    rmDir(wt);
  }
});

test.after(() => rmDir(home));
