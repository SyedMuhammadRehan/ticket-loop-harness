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
    assert.strictEqual(ledger(root, ['init', runDir]).status, 0);
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

test('doctor reports a verify command whose program is not on PATH, and skips shell builtins', () => {
  const root = repo(NODE_REPO);
  try {
    assert.strictEqual(run(INIT, root).status, 0);
    const file = path.join(root, '.agents', 'ticket-loop.config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.verify = { ...cfg.verify, test: 'tl-no-such-tool-7f3 --run', analyze: 'cd sub && node --version', pubGet: null };
    fs.writeFileSync(file, JSON.stringify(cfg));
    const res = run(DOCTOR, root, ['--json']);
    assert.strictEqual(res.status, 1, res.stdout);
    const problems = JSON.parse(res.stdout).findings.filter((f) => f.level === 'problem').map((f) => f.what);
    assert.ok(problems.some((p) => /verify\.test runs tl-no-such-tool-7f3, which is not on PATH/.test(p)), problems.join('\n'));
    assert.ok(!problems.some((p) => /verify\.analyze/.test(p)), problems.join('\n'));
  } finally {
    rmDir(root);
  }
});

test('init proposes pytest only when the repo names it, and no install for a dependency-free python repo', () => {
  const root = repo({ 'pyproject.toml': '[project]\nname = "svc"\n', 'tests/test_x.py': 'import unittest\n' });
  try {
    const res = run(INIT, root, ['--dry-run']);
    assert.strictEqual(res.status, 0, res.stderr);
    const profile = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'), res.stdout.lastIndexOf('}') + 1));
    assert.strictEqual(profile.verify.test, 'python -m unittest discover');
    assert.strictEqual(profile.verify.pubGet, null);
    assert.match(res.stdout, /verify\.test was inferred from the tests\/ folder/);
  } finally {
    rmDir(root);
  }
});

test('init proposes no npm ci without a lockfile, and doctor reports a profile that asks for one', () => {
  const pkg = { name: 'app', scripts: { test: 'node --test' } };
  const bare = repo({ 'package.json': JSON.stringify(pkg) });
  const withDeps = repo({ 'package.json': JSON.stringify({ ...pkg, dependencies: { leftpad: '1.0.0' } }) });
  try {
    const profileOf = (root) => {
      const res = run(INIT, root, ['--dry-run']);
      return { out: res.stdout, profile: JSON.parse(res.stdout.slice(res.stdout.indexOf('{'), res.stdout.lastIndexOf('}') + 1)) };
    };
    const none = profileOf(bare).profile;
    assert.strictEqual(none.verify.pubGet, null, 'nothing to install, so no install command');
    assert.deepStrictEqual(none.riskPaths, ['package.json']);
    assert.strictEqual(none.deps.lockfile, null);
    const some = profileOf(withDeps);
    assert.strictEqual(some.profile.verify.pubGet, 'npm install');
    assert.match(some.out, /no lockfile found/);

    assert.strictEqual(run(INIT, bare).status, 0);
    assert.strictEqual(run(DOCTOR, bare, ['--json']).status, 0);
    const file = path.join(bare, '.agents', 'ticket-loop.config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...cfg, verify: { ...cfg.verify, pubGet: 'npm ci' } }));
    const res = run(DOCTOR, bare, ['--json']);
    assert.strictEqual(res.status, 1, res.stdout);
    assert.ok(JSON.parse(res.stdout).findings.some((f) => f.level === 'problem' && /npm ci, but the repo has no package-lock\.json/.test(f.what)), res.stdout);
  } finally {
    rmDir(bare);
    rmDir(withDeps);
  }
});

test('doctor says when the profile is not committed on the base branch, until it is', () => {
  const root = repo(NODE_REPO);
  try {
    assert.strictEqual(run(INIT, root).status, 0);
    const uncommitted = (r) => r.findings.some((f) => f.level === 'note' && /the profile is not committed on main/.test(f.what));
    assert.ok(uncommitted(doctor(root)), JSON.stringify(doctor(root).findings));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'chore: ticket-loop profile');
    assert.ok(!uncommitted(doctor(root)));
  } finally {
    rmDir(root);
  }
});

// --- the gates, tried ---

test('doctor --canary tries each gate in a throwaway repo and reports that they held', () => {
  const root = repo(NODE_REPO);
  try {
    assert.strictEqual(run(INIT, root).status, 0);
    const res = run(DOCTOR, root, ['--canary', '--json']);
    assert.strictEqual(res.status, 0, res.stdout);
    const tried = JSON.parse(res.stdout).findings.find((f) => /tried in a throwaway repo/.test(f.what));
    assert.ok(tried, res.stdout);
    assert.match(tried.what, /every gate held: an edit to a frozen contract, an edit under a risk path and a git push were each refused, .*a dispatch was counted.*a "done" claim over a failing suite was blocked/);
    assert.strictEqual(git(root, 'status', '--porcelain', '--', '.').includes('CANARY'), false, 'the trial run is nowhere in this repo');
    const summary = JSON.parse(res.stdout).findings.find((f) => /^the profile: /.test(f.what));
    assert.ok(summary, 'doctor says what the profile will make a run do');
    assert.match(summary.what, /node; tests run with "npm test", analysis with "npm run lint"; every role on the session model; a run publishes nothing/);
  } finally {
    rmDir(root);
  }
});

// --- the two choices that are the person's ---

const CHOOSE = path.join(SCRIPTS_DIR, 'choose.js');
const profileOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), 'utf8'));

test('choose writes the model and publishing choices and leaves the rest of the profile alone', () => {
  const root = repo(NODE_REPO);
  try {
    assert.strictEqual(run(INIT, root).status, 0);
    const before = profileOf(root);
    const shown = JSON.parse(run(CHOOSE, root, ['--show']).stdout);
    assert.deepStrictEqual(shown.models, { survey: 'inherit', implementer: 'inherit', fixer: 'inherit', qa: 'inherit' });
    assert.deepStrictEqual(shown.publish, []);

    assert.strictEqual(shown.remote, null, 'a repo with no origin has nowhere to publish to, and setup is told so');

    const res = run(CHOOSE, root, ['--model', 'survey=haiku', '--model', 'implementer=sonnet', '--publish', 'push,pr']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /each run still asks before it publishes/);
    assert.match(res.stdout, /no "origin" remote yet/);
    git(root, 'remote', 'add', 'origin', 'https://example.invalid/acme/app.git');
    assert.strictEqual(JSON.parse(run(CHOOSE, root, ['--show']).stdout).remote, 'https://example.invalid/acme/app.git');
    assert.doesNotMatch(run(CHOOSE, root, ['--publish', 'push,pr']).stdout, /no "origin" remote/);
    const after = profileOf(root);
    assert.deepStrictEqual(after.models, { survey: 'haiku', implementer: 'sonnet' });
    assert.deepStrictEqual(after.publish.allowed, ['push', 'pr']);
    for (const key of Object.keys(before)) {
      if (key !== 'models' && key !== 'publish') assert.deepStrictEqual(after[key], before[key], `${key} was not part of the choice`);
    }

    const cfg = JSON.parse(run(LOAD_CONFIG, root).stdout);
    assert.deepStrictEqual(cfg._meta.warnings, [], cfg._meta.warnings.join('\n'));
    assert.strictEqual(cfg.models.qa, 'inherit', 'a role nobody chose stays on the session model');
    const summary = doctor(root).findings.find((f) => /^the profile: /.test(f.what)).what;
    assert.match(summary, /survey on haiku, implementer on sonnet; a run may publish: push, pr/);

    assert.strictEqual(run(CHOOSE, root, ['--publish', 'none']).status, 0);
    assert.deepStrictEqual(profileOf(root).publish.allowed, []);
  } finally {
    rmDir(root);
  }
});

test('choose refuses a choice that is not one, a pull request with no push, and any change mid-run', () => {
  const root = repo(NODE_REPO);
  try {
    assert.strictEqual(run(CHOOSE, root, ['--publish', 'push']).status, 1, 'no profile yet');
    assert.strictEqual(run(INIT, root).status, 0);
    const text = fs.readFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), 'utf8');
    for (const [args, why] of [
      [['--model', 'judge=opus'], /is not a role/],
      [['--model', 'qa=gpt-9'], /is not a model this can set/],
      [['--publish', 'pr'], /needs the branch pushed/],
      [['--publish', 'push,merge'], /--publish takes none, or a list of push, pr, ticket/],
      [['--verify', 'x'], /unknown argument/],
      [[], /nothing to change/],
    ]) {
      const res = run(CHOOSE, root, args);
      assert.strictEqual(res.status, 2, args.join(' '));
      assert.match(res.stderr, why);
    }
    assert.strictEqual(fs.readFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), 'utf8'), text, 'a refused choice writes nothing');

    const runDir = path.join(root, '.agents', 'ticket-runs', 'T-1');
    fs.mkdirSync(runDir, { recursive: true });
    assert.strictEqual(ledger(root, ['init', runDir]).status, 0);
    const midRun = run(CHOOSE, root, ['--publish', 'push']);
    assert.strictEqual(midRun.status, 1);
    assert.match(midRun.stderr, /the profile is frozen while a run is active/);
  } finally {
    rmDir(root);
  }
});

test('choose never writes past the org policy', () => {
  const root = repo(NODE_REPO);
  const policyDir = mkTmpDir('tl-policy');
  try {
    assert.strictEqual(run(INIT, root).status, 0);
    const policyFile = path.join(policyDir, 'policy.json');
    fs.writeFileSync(policyFile, JSON.stringify({ allowedModels: { qa: ['inherit', 'opus'] }, publish: { allowed: ['push'] } }));
    const under = (args) => runScript(CHOOSE, args, { cwd: root, env: { HOME: home, USERPROFILE: home, TICKET_LOOP_POLICY: policyFile } });

    const model = under(['--model', 'qa=haiku']);
    assert.strictEqual(model.status, 1);
    assert.match(model.stderr, /the org policy does not allow this/);
    const publish = under(['--publish', 'push,pr']);
    assert.strictEqual(publish.status, 1);
    assert.match(publish.stderr, /does not let this repo publish: pr/);
    assert.deepStrictEqual(profileOf(root).models, undefined, 'nothing was written');

    assert.strictEqual(under(['--model', 'qa=opus', '--publish', 'push']).status, 0);
    const shown = JSON.parse(under(['--show']).stdout);
    assert.deepStrictEqual(shown.orgPolicy.models, { qa: ['inherit', 'opus'] });
    assert.deepStrictEqual(shown.orgPolicy.publish, ['push']);
  } finally {
    rmDir(root);
    rmDir(policyDir);
  }
});

test('the setup skill asks both questions and writes the answers through choose', () => {
  const skill = fs.readFileSync(path.join(SCRIPTS_DIR, '..', '..', 'setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /choose\.js --show/);
  assert.match(skill, /Which model does each kind of work run on\?/);
  assert.match(skill, /What may a finished run publish\?/);
  assert.match(skill, /every run still asks before each\s+act, and never merges/);
  assert.match(skill, /Never choose for them/);
  assert.match(skill, /"remote": null/, 'with nowhere to push to, the publishing question is skipped');
});

// A run that could not push was told "handoff.js prints the PR commands" and nothing else, so it
// could not run it: the script needs the worktree and somewhere to write the body.
test('the close stage gives the handoff command with every argument it requires', () => {
  const stage = fs.readFileSync(path.join(SCRIPTS_DIR, '..', 'stages', '11-report-and-close.md'), 'utf8');
  const usage = runScript(path.join(SCRIPTS_DIR, 'handoff.js'), [], {}).stderr;
  for (const flag of ['--worktree', '--out']) {
    assert.ok(usage.includes(flag), `handoff.js no longer takes ${flag}`);
    assert.match(stage, new RegExp(`handoff\\.js <runDir>[^\\n]*${flag}`), `the stage file runs handoff.js without ${flag}`);
  }
});

test('the canary reports a gate that refuses nothing', () => {
  const { runCanary } = require(path.join(SCRIPTS_DIR, 'canary.js'));
  const dir = mkTmpDir('tl-stub');
  try {
    const stub = path.join(dir, 'allow-everything.js');
    fs.writeFileSync(stub, 'process.exit(0);\n');
    for (const gate of ['freeze_guard', 'dispatch_guard', 'stop_gate']) {
      const result = runCanary({ hooks: { [gate]: stub } });
      assert.strictEqual(result.ran, true, result.problem);
      const failed = result.checks.filter((c) => !c.ok).map((c) => c.name);
      const expected = { freeze_guard: 'write guard', dispatch_guard: 'dispatch count', stop_gate: 'stop gate' }[gate];
      assert.deepStrictEqual(failed, [expected], `a ${gate} that allows everything`);
    }
    const missing = runCanary({ hooks: { stop_gate: path.join(dir, 'not-there.js') } });
    assert.strictEqual(missing.ran, false);
    assert.match(missing.problem, /stop_gate missing/);

    // And doctor turns either into a problem, never a note.
    const { diagnose } = require(DOCTOR);
    const problems = (opts) => diagnose(dir, { canary: opts }).findings.filter((f) => f.level === 'problem').map((f) => f.what);
    assert.ok(problems({ hooks: { freeze_guard: stub } }).some((p) => /the write guard did not hold in a trial run/.test(p)));
    assert.ok(problems({ hooks: { stop_gate: path.join(dir, 'not-there.js') } }).some((p) => /the gates could not be tried/.test(p)));
  } finally {
    rmDir(dir);
  }
});

// The setup skill tells the model to run one command and expect a refusal. If the guard let
// that command through, the skill would report a working install as broken.
test('the setup skill\'s live canary is a command the write guard refuses with no run open', () => {
  const skill = fs.readFileSync(path.join(SCRIPTS_DIR, '..', '..', 'setup', 'SKILL.md'), 'utf8');
  const command = (/^`(echo canary > [^`]+)`$/m.exec(skill) || [])[1];
  assert.ok(command, 'the skill names its canary command on a line of its own');
  assert.match(skill, /doctor\.js --canary/);
  const root = repo(NODE_REPO);
  try {
    const guard = path.join(SCRIPTS_DIR, '..', '..', '..', 'hooks', 'freeze_guard.js');
    const res = runScript(guard, [], { cwd: root, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root, session_id: 's' }) });
    assert.strictEqual(res.status, 2, res.stderr);
    assert.match(res.stderr, /^BLOCKED:/);
    assert.ok(!fs.existsSync(path.join(root, '.agents', 'ticket-runs')), 'and it wrote nothing');
  } finally {
    rmDir(root);
  }
});

test('init --help and an unknown flag print usage and write nothing', () => {
  const root = repo(NODE_REPO);
  try {
    const help = run(INIT, root, ['--help']);
    assert.strictEqual(help.status, 0, help.stderr);
    assert.match(help.stdout, /usage: init\.js/);
    const bad = run(INIT, root, ['--force']);
    assert.strictEqual(bad.status, 2);
    assert.match(bad.stderr, /usage: init\.js/);
    assert.ok(!fs.existsSync(path.join(root, '.agents')), 'nothing written');
    assert.strictEqual(git(root, 'status', '--porcelain'), '');
  } finally {
    rmDir(root);
  }
});

test('doctor always ends with a count of problems and notes', () => {
  const root = repo(NODE_REPO);
  try {
    assert.strictEqual(run(INIT, root).status, 0);
    const res = run(DOCTOR, root);
    assert.strictEqual(res.status, 0, res.stdout);
    assert.match(res.stdout.trim().split(/\r?\n/).pop(), /^\s*ok: 0 problems, \d+ notes?$/);
  } finally {
    rmDir(root);
  }
});

test('init proposes the install a python repo declares: requirements, poetry, or its own dependencies', () => {
  for (const [files, pubGet] of [
    [{ 'requirements.txt': 'requests\n' }, 'pip install -r requirements.txt'],
    [{ 'pyproject.toml': '[tool.poetry]\nname = "svc"\n[tool.poetry.dependencies]\npython = "^3.11"\n' }, 'poetry install'],
    [{ 'pyproject.toml': '[project]\nname = "svc"\ndependencies = [\n  "httpx",\n]\n' }, 'pip install -e .'],
  ]) {
    const root = repo(files);
    try {
      const res = run(INIT, root, ['--dry-run']);
      const profile = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'), res.stdout.lastIndexOf('}') + 1));
      assert.strictEqual(profile.verify.pubGet, pubGet, JSON.stringify(files));
    } finally {
      rmDir(root);
    }
  }
});
