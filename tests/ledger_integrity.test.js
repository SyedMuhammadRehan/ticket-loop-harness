'use strict';
// What binds a run's claims to the chain rather than to the orchestrator's word: the verdict to a
// judge the hook dispatched, a command result to a command the ledger ran, the close to a chain
// record, the cap and the ceiling to counts that hold under parallel dispatch, and verify's
// answer to the run rather than to the directory it was asked from.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  mkRun,
  mkTmpDir,
  rmDir,
  ledger,
  runScript,
  settleDispatches,
  SCRIPTS_DIR,
  RUNNABLE_CONFIG,
  PASSES,
  FAILS,
  draftOf,
  freezeRun,
  judge,
} = require('./helpers.js');
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

const LEDGER = path.join(SCRIPTS_DIR, 'ledger.js');
const JUDGE = 'ticket-loop:ticket-loop-qa: contract [full]';

function frozen(config = RUNNABLE_CONFIG, draft = draftOf()) {
  const { root, runDir } = mkRun(config);
  assert.strictEqual(ledger(root, ['init', runDir, 'base1']).status, 0);
  freezeRun(root, runDir, draft);
  const inputs = ['done.approved.md', 'done-additions.md'].flatMap((f) => ['--inputs', path.join(runDir, f)]);
  return { root, runDir, inputs };
}

function ok(root, args) {
  const res = ledger(root, args);
  assert.strictEqual(res.status, 0, `ledger ${args.slice(0, 3).join(' ')}: ${res.stderr}`);
  return res;
}

// A run taken to its report gate with the given check results, then closed.
function closedWith(checks, draft = draftOf()) {
  const run = frozen(RUNNABLE_CONFIG, draft);
  for (const [id, result, by] of checks) ok(run.root, ['check', run.runDir, id, result, '--by', by, '--cwd', run.root]);
  assert.strictEqual(judge(run.root, run.runDir, 'APPROVE').status, 0);
  fs.writeFileSync(path.join(run.runDir, 'report.md'), '# Report\n');
  ok(run.root, ['gate', run.runDir, 'report', '--evidence', path.join(run.runDir, 'report.md')]);
  settleDispatches(run.root, run.runDir);
  ok(run.root, ['close', run.runDir]);
  return run;
}

// --- the verdict is bound to the judge ---

test('a verdict is backed only by an open QA judge the hook dispatched after the freeze', () => {
  const { root, runDir, inputs } = frozen();
  try {
    const verdict = () => ledger(root, ['verdict', runDir, 'APPROVE', ...inputs]);
    ok(root, ['dispatch', runDir, 'general-purpose: tidy', '--source', 'hook']);
    assert.strictEqual(verdict().status, 3, 'another agent the hook counted is not a judge');
    ok(root, ['dispatch', runDir, JUDGE]);
    assert.strictEqual(verdict().status, 3, 'a judge dispatch the orchestrator typed itself is not one the hook saw');

    ok(root, ['dispatch', runDir, JUDGE, '--source', 'hook']);
    const judgeSeq = chain.last(runDir, 'dispatch').seq;
    ok(root, ['outcome', runDir, String(judgeSeq), 'ok']);
    const afterOutcome = verdict();
    assert.strictEqual(afterOutcome.status, 1, 'a judge that has returned can no longer seal');
    assert.strictEqual(chain.ofKind(runDir, 'verdict').length, 0);

    ok(root, ['dispatch', runDir, JUDGE, '--source', 'hook']);
    const open = chain.last(runDir, 'dispatch').seq;
    ok(root, ['dispatch', runDir, 'general-purpose: fix C2', '--source', 'hook']);
    assert.strictEqual(verdict().status, 0);
    assert.strictEqual(chain.last(runDir, 'verdict').payload.dispatchSeq, open, 'bound to the judge, not to the latest dispatch');
  } finally {
    rmDir(root);
  }
});

// --- a command result is a command the ledger ran ---

test('check --by command runs the frozen command, seals its exit, and refuses a result it contradicts', () => {
  const noisy = `node -e "for(let i=1;i<=50;i++)console.log('line'+i);process.exit(1)"`;
  const { root, runDir } = frozen(RUNNABLE_CONFIG, draftOf(FAILS, noisy));
  try {
    const check = (...args) => ledger(root, ['check', runDir, ...args]);
    const lie = check('C1', 'PASS', '--by', 'command', '--cwd', root);
    assert.strictEqual(lie.status, 1, lie.stderr);
    assert.match(lie.stderr, /exited 1, which is not a PASS/);
    assert.strictEqual(chain.ofKind(runDir, 'check').length, 0, 'a contradicted claim seals nothing');

    assert.strictEqual(check('C2', 'FAIL', '--by', 'command', '--cwd', root).status, 0);
    const sealed = chain.last(runDir, 'check').payload;
    assert.strictEqual(sealed.command, noisy);
    assert.strictEqual(sealed.exitCode, 1);
    assert.ok(Number.isInteger(sealed.ms));
    const tail = sealed.outputTail.split('\n');
    assert.strictEqual(tail.length, 40, 'the last 40 lines of output are kept');
    assert.strictEqual(tail[tail.length - 1], 'line50');

    assert.strictEqual(check('C1', 'FAIL', '--by', 'command').status, 1, '--cwd is required');
    assert.strictEqual(check('C1', 'FAIL', '--by', 'command', '--cwd', path.join(root, 'nope')).status, 1, '--cwd must be a directory');
    assert.strictEqual(check('C1', 'SKIPPED', '--by', 'command', '--cwd', root).status, 1, 'a command decides PASS or FAIL');
    const unknown = check('C7', 'FAIL', '--by', 'observed');
    assert.strictEqual(unknown.status, 1, 'an id outside the frozen contract is refused, whatever the method');
    assert.match(unknown.stderr, /not a criterion of the frozen contract/);
    assert.strictEqual(chain.ofKind(runDir, 'check').length, 1);
  } finally {
    rmDir(root);
  }
});

test('a criterion command that runs past its timeout is a FAIL, never a PASS', () => {
  const slow = `node -e "setTimeout(()=>{},20000)"`;
  const { root, runDir } = frozen(RUNNABLE_CONFIG, draftOf(slow));
  try {
    const run = (result) => ledger(root, ['check', runDir, 'C1', result, '--by', 'command', '--cwd', root, '--timeout-ms', '500']);
    assert.strictEqual(run('PASS').status, 1);
    assert.strictEqual(run('FAIL').status, 0);
    const sealed = chain.last(runDir, 'check').payload;
    assert.strictEqual(sealed.timedOut, true);
    assert.strictEqual(sealed.exitCode, null);
    // Killing the shell alone leaves the command holding the output pipes until it ends by itself.
    assert.ok(sealed.ms < 10000, `the whole tree was killed at the deadline, not left to run (${sealed.ms} ms)`);
  } finally {
    rmDir(root);
  }
});

// --- the close is a chain record ---

test('deleting the close marker re-opens nothing: the ledger still refuses, close rewrites it, verify reports it', () => {
  const { root, runDir, inputs } = closedWith([['C1', 'PASS', 'command'], ['C2', 'PASS', 'command']]);
  try {
    assert.strictEqual(chain.first(runDir, 'init').payload.closesInChain, true);
    const close = chain.last(runDir, 'close');
    assert.ok(close, 'close appended a chain record');
    assert.strictEqual(close.payload.verdict, 'APPROVE');
    assert.strictEqual(close.payload.reportGateSeq, chain.ofKind(runDir, 'gate').find((r) => r.payload.stage === 'report').seq);

    fs.rmSync(path.join(runDir, 'closed.json'));
    for (const args of [['dispatch', runDir, JUDGE, '--source', 'hook'], ['verdict', runDir, 'APPROVE', ...inputs]]) {
      const res = ledger(root, args);
      assert.strictEqual(res.status, 1, `${args[0]} must still refuse: ${res.stdout}`);
      assert.match(res.stderr, /CLOSED/);
    }
    const report = JSON.parse(ledger(root, ['verify', runDir]).stdout);
    assert.ok(report.problems.some((p) => p.includes('close marker removed')), report.problems.join('\n'));

    const again = ledger(root, ['close', runDir]);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.match(again.stdout, /marker rewritten/);
    assert.ok(fs.existsSync(path.join(runDir, 'closed.json')));
    assert.strictEqual(chain.ofKind(runDir, 'close').length, 1, 'the rewrite adds no second close');
    assert.strictEqual(ledger(root, ['close', runDir]).status, 1, 'and a present marker is already closed');

    chain.append(runDir, 'verdict', { verdict: 'APPROVE', inputs: [], dispatchSeq: 0, dispatchSource: 'hook' });
    const after = JSON.parse(ledger(root, ['verify', runDir]).stdout);
    assert.ok(after.problems.some((p) => p.includes(`after the close record (seq ${close.seq})`)), after.problems.join('\n'));
  } finally {
    rmDir(root);
  }
});

// --- the cap holds under parallel dispatch ---

function spawnLedger(root, args) {
  return new Promise((resolve) => {
    const env = { ...process.env, TICKET_LOOP_POLICY: path.join(os.tmpdir(), 'ticket-loop-no-policy.json') };
    delete env.CLAUDE_PLUGIN_ROOT;
    const kid = spawn(process.execPath, [LEDGER, ...args], { cwd: root, env, stdio: 'ignore' });
    kid.on('exit', resolve);
  });
}

test('parallel dispatches near the cap never exceed it', async () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
    for (let i = 0; i < 20; i++) ok(root, ['dispatch', runDir, `implementer: C${i}`]);
    const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => spawnLedger(root, ['dispatch', runDir, `implementer: P${i}`])));
    assert.deepStrictEqual(codes.slice().sort(), [0, 0, 0, 0, 0, 2, 2, 2], 'five fit under the cap and three are refused');
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).dispatches, 25);
    assert.deepStrictEqual(chain.verify(runDir).problems, []);
  } finally {
    rmDir(root);
  }
});

// --- the ceiling charges at least what was sent ---

test('a dispatch with no reported tokens still spends its prompt against the ceiling', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' }, dispatchPolicy: { maxRunTokens: 1000 } });
  try {
    ok(root, ['init', runDir, 'abc']);
    ok(root, ['dispatch', runDir, 'implementer: C1', '--source', 'hook', '--prompt-chars', '4000']);
    let status = JSON.parse(ledger(root, ['status', runDir]).stdout);
    assert.strictEqual(status.tokensUsed, 1000, 'charged its prompt while still out');
    assert.strictEqual(status.tokensFloor, 1000);
    assert.strictEqual(ledger(root, ['outcome', runDir, '2', 'ok', '--tokens', '0']).status, 1, 'zero is not a figure the tool reports');
    ok(root, ['outcome', runDir, '2', 'ok']);
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).tokensUsed, 1000, 'an unreported outcome does not make it free');

    ok(root, ['dispatch', runDir, 'implementer: C2', '--source', 'hook', '--prompt-chars', '400']);
    ok(root, ['outcome', runDir, String(chain.last(runDir, 'dispatch').seq), 'ok', '--tokens', '300']);
    status = JSON.parse(ledger(root, ['status', runDir]).stdout);
    assert.strictEqual(status.tokensUsed, 1300, 'a reported figure above the floor is charged in full');
    assert.strictEqual(status.tokensFloor, 1100);
    assert.strictEqual(JSON.parse(ledger(root, ['cost', runDir]).stdout).tokensFloor, 1100);
  } finally {
    rmDir(root);
  }
});

// --- intact is not passed ---

test('verify says whether the run passed: an intact record of failure or of nothing is not a pass', () => {
  const bare = mkRun({ verify: { test: 'x' } });
  const failed = closedWith([['C1', 'FAIL', 'command'], ['C2', 'PASS', 'command']], draftOf(FAILS));
  const passed = closedWith([['C1', 'PASS', 'command'], ['C2', 'PASS', 'command']]);
  try {
    ok(bare.root, ['init', bare.runDir, 'abc']);
    fs.writeFileSync(path.join(bare.runDir, 'report.md'), '# Report\n');
    ok(bare.root, ['gate', bare.runDir, 'report', '--evidence', path.join(bare.runDir, 'report.md')]);
    ok(bare.root, ['close', bare.runDir]);
    const onlyReport = JSON.parse(ledger(bare.root, ['verify', bare.runDir]).stdout);
    assert.strictEqual(onlyReport.intact, true, 'close stays permissive');
    assert.deepStrictEqual(onlyReport.completeness, { verdict: null, frozenCriteria: 0, criteria: [], passed: false });

    const report = JSON.parse(ledger(failed.root, ['verify', failed.runDir]).stdout);
    assert.strictEqual(report.intact, true);
    assert.strictEqual(report.completeness.verdict, 'APPROVE');
    assert.strictEqual(report.completeness.frozenCriteria, 2);
    assert.deepStrictEqual(report.completeness.criteria.map((c) => `${c.id} ${c.result}`), ['C1 FAIL', 'C2 PASS']);
    assert.strictEqual(report.completeness.passed, false);

    assert.strictEqual(JSON.parse(ledger(passed.root, ['verify', passed.runDir]).stdout).completeness.passed, true);
  } finally {
    rmDir(bare.root);
    rmDir(failed.root);
    rmDir(passed.root);
  }
});

// --- the answer does not depend on where verify runs ---

test('verify gives the same answer from the repo root and from any other directory', () => {
  const { root, runDir } = frozen();
  const elsewhere = mkTmpDir('tl-elsewhere');
  try {
    // A receipt sealed with a path relative to the repo, as older chains hold them.
    const brief = path.join(runDir, 'ticket-brief.md');
    fs.writeFileSync(brief, '# brief\n');
    chain.append(runDir, 'gate', { stage: 'intake', evidence: [{ file: '.agents/ticket-runs/T-1/ticket-brief.md', sha256: chain.sha256File(brief) }] });
    // Evidence named relative to a directory that is neither the repo root nor the verifier's.
    fs.writeFileSync(path.join(runDir, 'codebase-map.md'), '# map\n');
    assert.strictEqual(runScript(LEDGER, ['gate', runDir, 'survey', '--evidence', 'codebase-map.md'], { cwd: runDir }).status, 0);
    const verifyFrom = (cwd) => {
      const res = runScript(LEDGER, ['verify', runDir], { cwd });
      return { status: res.status, problems: JSON.parse(res.stdout).problems };
    };
    assert.deepStrictEqual(verifyFrom(elsewhere), verifyFrom(root));
    assert.strictEqual(verifyFrom(elsewhere).status, 0, verifyFrom(elsewhere).problems.join('\n'));

    fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify({ verify: { test: 'exit 0' } }));
    const fromRoot = verifyFrom(root);
    assert.strictEqual(fromRoot.status, 4);
    assert.ok(fromRoot.problems.some((p) => /TAMPERED: .*ticket-loop\.config\.json/.test(p)), fromRoot.problems.join('\n'));
    assert.deepStrictEqual(verifyFrom(elsewhere), fromRoot);
  } finally {
    rmDir(root);
    rmDir(elsewhere);
  }
});

// --- a return goes to the agent's own dispatch ---

test('a return is routed by agent id, then to the oldest unmarked dispatch of its type, then to the oldest unmarked', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    ok(root, ['init', runDir, 'abc']);
    ok(root, ['dispatch', runDir, 'general-purpose: C1', '--source', 'hook']);
    ok(root, ['dispatch', runDir, 'ticket-loop:ticket-loop-qa: review', '--source', 'hook']);
    ok(root, ['dispatch', runDir, 'general-purpose: C2', '--source', 'hook']);
    const mark = (...args) => {
      ok(root, ['returned', runDir, ...args]);
      return chain.last(runDir, 'returned').payload.dispatchSeq;
    };
    assert.strictEqual(mark('--agent', 'q1', '--type', 'ticket-loop:ticket-loop-qa'), 3, 'the judge, not the oldest dispatch');
    assert.strictEqual(mark('--agent', 'g1', '--type', 'general-purpose'), 2);
    assert.strictEqual(mark('--agent', 'q1', '--type', 'general-purpose'), 3, 'the same agent id is the same dispatch');
    assert.strictEqual(mark('--agent', 'x1', '--type', 'Explore'), 4, 'no dispatch of its type: the oldest unmarked');
  } finally {
    rmDir(root);
  }
});
