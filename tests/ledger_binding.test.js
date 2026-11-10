'use strict';
// The invariants under test bind a run to its own repo: the profile it is sealed under, the
// directory its criteria run in, the policy file that floors it, and the counters a restart
// may zero.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SCRIPTS_DIR, mkRun, mkTmpDir, rmDir, runScript, ledger, freezeRun, judge, settleDispatches } = require('./helpers.js');

const VERIFY = { test: 'node tests.js', analyze: 'node lint.js' };
const DRAFT =
  '# Done\n## Criteria\n- [ ] C1 (test): behaviour holds | run: node tests.js\n' +
  '- [ ] C2 (analyzer): clean | run: node lint.js\n' +
  '- [ ] C3 (runtime): the screen renders | run: playwright: open /profile\n' +
  '## Tokens\n- none\n## Out of scope\n- the offline banner\n';
const LEDGER = path.join(SCRIPTS_DIR, 'ledger.js');
const statusOf = (root, runDir, env) => JSON.parse(runScript(LEDGER, ['status', runDir], { cwd: root, env }).stdout);
const verifyOf = (root, runDir, env) => JSON.parse(runScript(LEDGER, ['verify', runDir], { cwd: root, env }).stdout);

function git(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function realRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dev@example.com']);
  git(dir, ['config', 'user.name', 'dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return git(dir, ['rev-parse', 'HEAD']);
}

test('init seals the profile of the repo that owns the run dir, whatever directory it is run from', () => {
  const { root, runDir } = mkRun({ verify: VERIFY, requireTestFirst: true, dispatchPolicy: { maxRunTokens: 1000 } });
  const lenient = mkTmpDir('tl-lenient');
  try {
    fs.mkdirSync(path.join(lenient, '.agents'));
    fs.writeFileSync(path.join(lenient, '.agents', 'ticket-loop.config.json'), JSON.stringify({ verify: VERIFY }));
    const init = runScript(LEDGER, ['init', runDir, 'base123'], { cwd: lenient });
    assert.strictEqual(init.status, 0, init.stderr);
    assert.strictEqual(statusOf(root, runDir).maxRunTokens, 1000, 'the ceiling is the owning repo\'s, not the one in the directory init ran from');
    const report = verifyOf(root, runDir);
    assert.strictEqual(report.completeness.requireTestFirst, true);
    assert.deepStrictEqual(report.problems, []);
  } finally {
    rmDir(root);
    rmDir(lenient);
  }
});

test('init refuses a run dir the hooks would never find', () => {
  const { root } = mkRun({ verify: VERIFY });
  try {
    const stray = path.join(root, 'runs', 'T-1');
    fs.mkdirSync(stray, { recursive: true });
    const res = ledger(root, ['init', stray, 'base123']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /\.agents\/ticket-runs\/<TICKET>/);
  } finally {
    rmDir(root);
  }
});

test('init refuses a ticket name that is not safe as a branch and in a pasted command', () => {
  const { root } = mkRun({ verify: VERIFY });
  try {
    for (const name of ['T-1;whoami', 'T 1', '-rf', '$(id)']) {
      const runDir = path.join(root, '.agents', 'ticket-runs', name);
      fs.mkdirSync(runDir, { recursive: true });
      const res = ledger(root, ['init', runDir, 'base123']);
      assert.strictEqual(res.status, 1, name);
      assert.match(res.stderr, /not a usable ticket name/);
    }
    for (const name of ['PROJ-128', '12', 'fix_login.v2']) {
      const runDir = path.join(root, '.agents', 'ticket-runs', name);
      fs.mkdirSync(runDir, { recursive: true });
      assert.strictEqual(ledger(root, ['init', runDir, 'base123']).status, 0, name);
    }
  } finally {
    rmDir(root);
  }
});

test('a profile saved with a byte-order mark governs the run like any other', () => {
  const { root, runDir } = mkRun({ verify: VERIFY });
  try {
    const file = path.join(root, '.agents', 'ticket-loop.config.json');
    const profile = { verify: VERIFY, dispatchPolicy: { maxRunTokens: 1000 }, hooks: { stopGate: { extensions: ['.js'], mode: 'full' } } };
    fs.writeFileSync(file, String.fromCharCode(0xfeff) + JSON.stringify(profile));
    const loaded = JSON.parse(runScript(path.join(SCRIPTS_DIR, 'load_config.js'), [], { cwd: root }).stdout);
    assert.strictEqual(loaded.verify.test, 'node tests.js', JSON.stringify(loaded._meta.warnings));
    assert.strictEqual(ledger(root, ['init', runDir, 'base123']).status, 0);
    assert.strictEqual(statusOf(root, runDir).maxRunTokens, 1000, 'the sealed profile is the one in the file');
    const hookLib = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'hooks', 'hook_lib.js'));
    assert.strictEqual(hookLib.loadConfig(root).found, true, 'the hooks read it too');
  } finally {
    rmDir(root);
  }
});

test('a gate accepts its artifact when the run dir is reached through a link', () => {
  const { root, runDir } = mkRun({ verify: VERIFY });
  const link = `${root}-link`;
  try {
    // A junction on Windows needs no privilege; elsewhere a directory symlink.
    fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedRun = path.join(link, '.agents', 'ticket-runs', 'T-1');
    assert.strictEqual(ledger(root, ['init', linkedRun, 'base123']).status, 0);
    fs.writeFileSync(path.join(runDir, 'ticket-brief.md'), '# T-1\n');
    const viaReal = ledger(root, ['gate', linkedRun, 'intake', '--evidence', path.join(runDir, 'ticket-brief.md')]);
    assert.strictEqual(viaReal.status, 0, viaReal.stderr);
    assert.deepStrictEqual(verifyOf(root, runDir).problems, [], 'and the same run verifies by its real path');
  } finally {
    fs.rmSync(link, { recursive: false, force: true });
    rmDir(root);
  }
});

test('the implement gate seals something, and edited mirror caps are reported', () => {
  const { root, runDir } = mkRun({ verify: VERIFY });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'base123']).status, 0);
    const bare = ledger(root, ['gate', runDir, 'implement']);
    assert.notStrictEqual(bare.status, 0, 'an implement receipt over nothing proves nothing was implemented');
    fs.writeFileSync(path.join(root, 'feature.js'), 'module.exports = 1;\n');
    assert.strictEqual(ledger(root, ['gate', runDir, 'implement', '--evidence', path.join(root, 'feature.js')]).status, 0);

    const mirror = path.join(runDir, 'budget.json');
    const budget = JSON.parse(fs.readFileSync(mirror, 'utf8'));
    fs.writeFileSync(mirror, JSON.stringify({ ...budget, maxDispatches: 999 }));
    assert.ok(verifyOf(root, runDir).problems.some((p) => /budget\.json caps were edited/.test(p)));
  } finally {
    rmDir(root);
  }
});

// The mark arrives well after the launch here, so "quiet since the launch" and "quiet since the
// last sign of life" give different answers at the moment the stall threshold passes.
test('a dispatch is stalled by time since its last sign of life, not since its launch', async () => {
  const { root, runDir } = mkRun({ verify: VERIFY, dispatchPolicy: { stallMinutes: 1 } });
  const { openDispatches } = require(LEDGER);
  const chainLib = require(path.join(SCRIPTS_DIR, 'chain.js'));
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'base123']).status, 0);
    assert.strictEqual(ledger(root, ['dispatch', runDir, 'implementer: C1', '--source', 'hook']).status, 0);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.strictEqual(ledger(root, ['returned', runDir, '--agent', 'bg1']).status, 0);
    const launchedAt = Date.parse(chainLib.last(runDir, 'dispatch').at);
    const justPastLaunchThreshold = launchedAt + 60000 + 500;
    const [open] = openDispatches(runDir, justPastLaunchThreshold);
    assert.strictEqual(open.stalled, false, 'a minute since launch, but under a minute since it was last seen');
    const [later] = openDispatches(runDir, launchedAt + 60000 + 5000);
    assert.strictEqual(later.stalled, true, 'a minute since it was last seen');
  } finally {
    rmDir(root);
  }
});

test('an addition is one criterion on one line', () => {
  const { root, runDir } = mkRun({ verify: VERIFY });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'base123']).status, 0);
    freezeRun(root, runDir, DRAFT);
    const before = fs.readFileSync(path.join(runDir, 'done-additions.md'), 'utf8');
    const smuggled = '- [ ] C9 (test): a real one | run: node tests.js\n- [x] C1 (test): already done | run: exit 0';
    const res = ledger(root, ['addition', runDir, smuggled]);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /one criterion, on one line/);
    assert.strictEqual(fs.readFileSync(path.join(runDir, 'done-additions.md'), 'utf8'), before);
  } finally {
    rmDir(root);
  }
});

test('init refuses a base commit the repo does not have', () => {
  const parent = mkTmpDir('tl-base');
  try {
    const repo = path.join(parent, 'repo');
    const base = realRepo(repo, { 'a.txt': 'a\n' });
    const other = realRepo(path.join(parent, 'other'), { 'b.txt': 'b\n' });
    const runDir = path.join(repo, '.agents', 'ticket-runs', 'T-1');
    fs.mkdirSync(runDir, { recursive: true });
    const foreign = ledger(repo, ['init', runDir, other]);
    assert.strictEqual(foreign.status, 1);
    assert.match(foreign.stderr, /is not a commit of the repo/);
    assert.strictEqual(ledger(repo, ['init', runDir, base]).status, 0);
  } finally {
    rmDir(parent);
  }
});

test('a criterion command is refused in a directory that is not the run\'s repo, or not its top', () => {
  const { root, runDir } = mkRun({ verify: VERIFY });
  const elsewhere = mkTmpDir('tl-elsewhere');
  try {
    fs.writeFileSync(path.join(root, 'tests.js'), 'process.exit(1);\n');
    fs.writeFileSync(path.join(elsewhere, 'tests.js'), 'process.exit(0);\n');
    fs.mkdirSync(path.join(root, 'green'));
    fs.writeFileSync(path.join(root, 'green', 'tests.js'), 'process.exit(0);\n');
    assert.strictEqual(ledger(root, ['init', runDir, 'base123']).status, 0);
    freezeRun(root, runDir, DRAFT);

    const away = ledger(root, ['check', runDir, 'C1', 'PASS', '--by', 'command', '--cwd', elsewhere, 'green']);
    assert.strictEqual(away.status, 1, 'a green suite in another directory says nothing about this repo');
    assert.match(away.stderr, /is not the run's repo/);
    const inside = ledger(root, ['check', runDir, 'C1', 'PASS', '--by', 'command', '--cwd', path.join(root, 'green'), 'green']);
    assert.strictEqual(inside.status, 1, 'nor does one in a subfolder that carries its own tests.js');
    const red = ledger(root, ['red', runDir, 'C1', '--cwd', elsewhere]);
    assert.strictEqual(red.status, 1);
    assert.match(red.stderr, /is not the run's repo/);

    const real = ledger(root, ['check', runDir, 'C1', 'FAIL', '--by', 'command', '--cwd', root, 'red']);
    assert.strictEqual(real.status, 0, real.stderr);
    assert.deepStrictEqual(verifyOf(root, runDir).completeness.criteria.find((c) => c.id === 'C1').result, 'FAIL');
  } finally {
    rmDir(root);
    rmDir(elsewhere);
  }
});

test('in a real repo the command runs at the top of the main checkout or a worktree of it, nowhere else', () => {
  const parent = mkTmpDir('tl-checkout');
  try {
    const repo = path.join(parent, 'repo');
    const files = { 'tests.js': 'process.exit(0);\n', 'lint.js': 'process.exit(0);\n', 'sub/tests.js': 'process.exit(0);\n' };
    const base = realRepo(repo, { ...files, '.agents/ticket-loop.config.json': JSON.stringify({ verify: VERIFY }) });
    const wt = path.join(parent, 'wt');
    git(repo, ['worktree', 'add', '-q', wt, '-b', 'ticket/T-1', base]);
    const other = path.join(parent, 'other');
    realRepo(other, files);
    const runDir = path.join(repo, '.agents', 'ticket-runs', 'T-1');
    fs.mkdirSync(runDir, { recursive: true });
    assert.strictEqual(ledger(repo, ['init', runDir, base]).status, 0);
    freezeRun(repo, runDir, DRAFT);

    const check = (cwd) => ledger(repo, ['check', runDir, 'C1', 'PASS', '--by', 'command', '--cwd', cwd, 'green']);
    assert.strictEqual(check(wt).status, 0, check(wt).stderr);
    assert.strictEqual(check(repo).status, 0);
    const foreign = check(other);
    assert.strictEqual(foreign.status, 1);
    assert.match(foreign.stderr, /not a checkout of the run's repo/);
    const sub = check(path.join(wt, 'sub'));
    assert.strictEqual(sub.status, 1);
    assert.match(sub.stderr, /not its top/);
  } finally {
    rmDir(parent);
  }
});

test('a criterion with a frozen command passes only by that command', () => {
  const { root, runDir } = mkRun({ verify: VERIFY });
  try {
    fs.writeFileSync(path.join(root, 'tests.js'), 'process.exit(1);\n');
    fs.writeFileSync(path.join(root, 'lint.js'), 'process.exit(1);\n');
    assert.strictEqual(ledger(root, ['init', runDir, 'base123']).status, 0);
    freezeRun(root, runDir, DRAFT);

    for (const by of ['observed', 'human']) {
      const res = ledger(root, ['check', runDir, 'C2', 'PASS', '--by', by, 'looked fine']);
      assert.strictEqual(res.status, 1, `PASS --by ${by} over a red command`);
      assert.match(res.stderr, /passes --by command/);
    }
    assert.strictEqual(ledger(root, ['check', runDir, 'C2', 'FAIL', '--by', 'observed', 'saw it break']).status, 0, 'a failure may be observed');
    assert.strictEqual(ledger(root, ['check', runDir, 'C3', 'PASS', '--by', 'observed', 'drove the screen']).status, 0, 'a criterion with no shell command is still observed');

    const j = judge(root, runDir, 'APPROVE');
    assert.strictEqual(j.status, 0, j.stderr);
    settleDispatches(root, runDir);
    assert.strictEqual(verifyOf(root, runDir).completeness.passed, false, 'a red suite and a red linter are not a passed run');
  } finally {
    rmDir(root);
  }
});

test('an approved run with a criterion nobody checked has not passed', () => {
  const { root, runDir } = mkRun({ verify: VERIFY });
  try {
    fs.writeFileSync(path.join(root, 'tests.js'), 'process.exit(0);\n');
    assert.strictEqual(ledger(root, ['init', runDir, 'base123']).status, 0);
    freezeRun(root, runDir, DRAFT);
    assert.strictEqual(ledger(root, ['check', runDir, 'C1', 'PASS', '--by', 'command', '--cwd', root]).status, 0);
    // C3 passes too, so the unchecked C2 is the only thing standing between this run and a pass.
    assert.strictEqual(ledger(root, ['check', runDir, 'C3', 'PASS', '--by', 'observed', 'drove the screen']).status, 0);
    assert.strictEqual(judge(root, runDir, 'APPROVE').status, 0);
    settleDispatches(root, runDir);
    const done = verifyOf(root, runDir).completeness;
    assert.strictEqual(done.criteria.find((c) => c.id === 'C2').result, 'unchecked');
    assert.strictEqual(done.passed, false, 'two passes and one criterion nobody checked is not a pass');
  } finally {
    rmDir(root);
  }
});

test('a judge dispatched before the contract was frozen cannot seal a verdict over it', () => {
  const { root, runDir } = mkRun({ verify: VERIFY });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'base123']).status, 0);
    assert.strictEqual(ledger(root, ['dispatch', runDir, 'ticket-loop:ticket-loop-qa: contract [full]', '--source', 'hook']).status, 0);
    freezeRun(root, runDir, DRAFT);
    const inputs = ['done.approved.md', 'done-additions.md'].flatMap((f) => ['--inputs', path.join(runDir, f)]);
    const early = ledger(root, ['verdict', runDir, 'APPROVE', ...inputs]);
    assert.notStrictEqual(early.status, 0, 'that judge was launched before there was a contract to judge');
    assert.strictEqual(verifyOf(root, runDir).completeness.verdict, null);
    assert.strictEqual(judge(root, runDir, 'APPROVE').status, 0, 'a judge dispatched after the freeze seals as usual');
  } finally {
    rmDir(root);
  }
});

function homeWithPolicy(policy) {
  const home = mkTmpDir('tl-home');
  fs.mkdirSync(path.join(home, '.claude', 'ticket-loop'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'ticket-loop', 'policy.json'), JSON.stringify(policy));
  return home;
}

test('the machine\'s policy file cannot be displaced through the environment at init', () => {
  const { root, runDir } = mkRun({ verify: VERIFY, dispatchPolicy: { maxRunTokens: 5000000 } });
  const home = homeWithPolicy({ requireTestFirst: true, dispatchPolicy: { maxRunTokens: 1000 } });
  const machine = { HOME: home, USERPROFILE: home };
  try {
    const dodge = runScript(LEDGER, ['init', runDir, 'base123'], { cwd: root, env: { ...machine, TICKET_LOOP_POLICY: path.join(os.tmpdir(), 'no-such-policy.json') } });
    assert.strictEqual(dodge.status, 1, 'a missing file named by the environment must not start a run with no floor');
    assert.match(dodge.stderr, /the machine's policy governs/);

    const env = { ...machine, TICKET_LOOP_POLICY: '' };
    const init = runScript(LEDGER, ['init', runDir, 'base123'], { cwd: root, env });
    assert.strictEqual(init.status, 0, init.stderr);
    assert.strictEqual(statusOf(root, runDir, env).maxRunTokens, 1000);
    assert.strictEqual(verifyOf(root, runDir, env).completeness.requireTestFirst, true);
  } finally {
    rmDir(root);
    rmDir(home);
  }
});

test('a raise lifts the profile ceiling up to the org cap and never past it', () => {
  const { root, runDir } = mkRun({ verify: VERIFY, dispatchPolicy: { maxRunTokens: 600 } });
  const policyFile = path.join(mkTmpDir('tl-policy'), 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({ dispatchPolicy: { maxRunTokens: 1000 } }));
  const env = { TICKET_LOOP_POLICY: policyFile };
  const run = (args) => runScript(LEDGER, args, { cwd: root, env });
  try {
    assert.strictEqual(run(['init', runDir, 'base123']).status, 0);
    assert.strictEqual(statusOf(root, runDir, env).maxRunTokens, 600);
    const over = run(['raise', runDir, '--tokens', '999999999', 'need more']);
    assert.strictEqual(over.status, 1);
    assert.match(over.stderr, /org policy caps a run at 1000/);
    assert.strictEqual(run(['raise', runDir, '--tokens', '400', 'agreed with the lead']).status, 0);
    assert.strictEqual(statusOf(root, runDir, env).maxRunTokens, 1000);
    assert.strictEqual(run(['raise', runDir, '--tokens', '1', 'one more']).status, 1);
    assert.strictEqual(statusOf(root, runDir, env).maxRunTokens, 1000);
  } finally {
    rmDir(root);
    rmDir(path.dirname(policyFile));
  }
});

test('a restart is refused until the run is archived, and verify names the restart', () => {
  const { root, runDir } = mkRun({ verify: VERIFY });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'base123']).status, 0);
    for (let i = 0; i < 5; i++) ledger(root, ['dispatch', runDir, `slice ${i}`]);
    settleDispatches(root, runDir);
    assert.strictEqual(verifyOf(root, runDir).restartedFrom, null, 'a first run is not a restart');

    const live = ledger(root, ['init', runDir, 'base123', '--restart']);
    assert.strictEqual(live.status, 1, 'restarting over a live run dir would zero a run still in flight');
    assert.match(live.stderr, /archive/);
    assert.strictEqual(statusOf(root, runDir).dispatches, 5);

    assert.strictEqual(ledger(root, ['archive', runDir]).status, 0);
    fs.mkdirSync(runDir, { recursive: true });
    assert.strictEqual(ledger(root, ['init', runDir, 'base123', '--restart']).status, 0);
    const report = verifyOf(root, runDir);
    assert.strictEqual(report.counters.dispatches, 0);
    assert.strictEqual(report.restartedFrom.retired, 'chain.1.jsonl');
    assert.ok(report.restartedFrom.retiredRecords > 5, JSON.stringify(report.restartedFrom));
  } finally {
    rmDir(root);
  }
});
