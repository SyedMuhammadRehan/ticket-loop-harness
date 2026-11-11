'use strict';
// The invariant under test: where a run stands is read from its sealed chain, never from the
// orchestrator's memory of it. `ledger.js next` is walked through a whole run and has to name
// the right stage file at every step, including the detours: a skipped stage, a failing
// criterion, a BLOCK verdict, a run with no worktree yet.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkRun, rmDir, ledger, freezeRun, judge, settleDispatches } = require('./helpers.js');

const VERIFY = { test: 'node tests.js', analyze: 'node lint.js' };
const DRAFT =
  '# Done\n## Criteria\n- [ ] C1 (test): behaviour holds | run: node tests.js\n' +
  '- [ ] C2 (analyzer): clean | run: node lint.js\n## Tokens\n- none\n## Out of scope\n- the offline banner\n';

const next = (root, runDir) => {
  const res = ledger(root, ['next', runDir, '--json']);
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};
const files = (state) => state.read.map((f) => path.basename(f));
const ok = (root, args) => {
  const res = ledger(root, args);
  assert.strictEqual(res.status, 0, `ledger ${args.slice(0, 3).join(' ')}: ${res.stderr}`);
};
const suite = (root, name, code) => fs.writeFileSync(path.join(root, name), `process.exit(${code});\n`);

// The "worktree" is <root>/wt-T-1, which the test creates when it wants one.
function started() {
  const made = mkRun({ verify: VERIFY, worktreePrefix: 'wt-' });
  ok(made.root, ['init', made.runDir, 'base123']);
  return made;
}

test('next walks a run from preflight to closed, naming each stage file in turn', () => {
  const { root, runDir } = mkRun({ verify: VERIFY, worktreePrefix: 'wt-' });
  try {
    const before = next(root, runDir);
    assert.strictEqual(before.stage, 0);
    assert.deepStrictEqual(files(before), ['00-preflight.md']);
    for (const f of before.read) assert.ok(fs.existsSync(f), `${f} is a real file`);

    ok(root, ['init', runDir, 'base123']);
    assert.deepStrictEqual(files(next(root, runDir)), ['01-intake.md', '02-fast-track-check.md']);

    fs.writeFileSync(path.join(runDir, 'ticket-brief.md'), '# T-1\n');
    ok(root, ['gate', runDir, 'intake', '--evidence', path.join(runDir, 'ticket-brief.md')]);
    assert.strictEqual(next(root, runDir).stage, 3);

    ok(root, ['skip', runDir, 'survey', 'one file in one module']);
    assert.strictEqual(next(root, runDir).stage, 4);
    ok(root, ['skip', runDir, 'design', 'no design source for this ticket']);
    assert.strictEqual(next(root, runDir).stage, 5);
    ok(root, ['skip', runDir, 'approach', 'trivial change, one file']);
    assert.strictEqual(next(root, runDir).stage, 6);

    freezeRun(root, runDir, DRAFT);
    ok(root, ['gate', runDir, 'validate']);
    const noTree = next(root, runDir);
    assert.strictEqual(noTree.stage, 7);
    assert.strictEqual(files(noTree)[0], '00-preflight.md', 'a run with no worktree is sent to make one first');
    assert.match(noTree.why, /worktree .* does not exist yet/);

    fs.mkdirSync(path.join(root, 'wt-T-1'));
    assert.deepStrictEqual(files(next(root, runDir)), ['07-implement.md', '08-verify.md']);

    suite(root, 'tests.js', 0);
    suite(root, 'lint.js', 1);
    ok(root, ['check', runDir, 'C1', 'PASS', '--by', 'command', '--cwd', root]);
    const partly = next(root, runDir);
    assert.strictEqual(partly.stage, 8);
    assert.match(partly.why, /C2 still unchecked/);

    ok(root, ['check', runDir, 'C2', 'FAIL', '--by', 'command', '--cwd', root]);
    const failing = next(root, runDir);
    assert.strictEqual(failing.stage, 10);
    assert.match(failing.why, /C2 last recorded FAIL/);

    suite(root, 'lint.js', 0);
    ok(root, ['check', runDir, 'C2', 'PASS', '--by', 'command', '--cwd', root]);
    assert.strictEqual(next(root, runDir).stage, 8, 'all passing, the verify gate still to record');
    ok(root, ['gate', runDir, 'verify']);
    assert.strictEqual(next(root, runDir).stage, 9);

    assert.strictEqual(judge(root, runDir, 'BLOCK').status, 0);
    settleDispatches(root, runDir);
    const blocked = next(root, runDir);
    assert.strictEqual(blocked.stage, 10);
    assert.deepStrictEqual(files(blocked), ['10-failure-loop.md', '09-adversarial-qa.md']);

    ok(root, ['check', runDir, 'C1', 'PASS', '--by', 'command', '--cwd', root]);
    const rechecked = next(root, runDir);
    assert.strictEqual(rechecked.stage, 9, 'a re-check after the BLOCK means the next judge is due');

    assert.strictEqual(judge(root, runDir, 'APPROVE').status, 0);
    settleDispatches(root, runDir);
    assert.match(next(root, runDir).why, /record the qa gate/);
    ok(root, ['gate', runDir, 'qa']);
    assert.strictEqual(next(root, runDir).stage, 11);

    fs.writeFileSync(path.join(runDir, 'report.md'), '# Report\n');
    ok(root, ['gate', runDir, 'report', '--evidence', path.join(runDir, 'report.md')]);
    assert.match(next(root, runDir).why, /close the run/);
    ok(root, ['close', runDir]);
    const closed = next(root, runDir);
    assert.strictEqual(closed.stage, null);
    assert.strictEqual(closed.state, 'closed');
    assert.deepStrictEqual(closed.read, []);
  } finally {
    rmDir(root);
  }
});

test('a stage is passed over only with a sealed reason, and only the three that may be', () => {
  const { root, runDir } = started();
  try {
    fs.writeFileSync(path.join(runDir, 'ticket-brief.md'), '# T-1\n');
    ok(root, ['gate', runDir, 'intake', '--evidence', path.join(runDir, 'ticket-brief.md')]);

    for (const [args, why] of [
      [['skip', runDir, 'verify', 'it is fine really'], /cannot be skipped/],
      [['skip', runDir, 'intake', 'already know the ticket'], /cannot be skipped/],
      [['skip', runDir, 'survey'], /need the reason/],
      [['skip', runDir, 'survey', 'n/a'], /need the reason/],
    ]) {
      const res = ledger(root, args);
      assert.strictEqual(res.status, 1, args.join(' '));
      assert.match(res.stderr, why);
    }
    assert.strictEqual(next(root, runDir).stage, 3, 'a refused skip moves nothing');

    ok(root, ['skip', runDir, 'survey', 'two-file change in one module']);
    assert.strictEqual(ledger(root, ['skip', runDir, 'survey', 'two-file change in one module']).status, 1, 'once');
    const state = next(root, runDir);
    assert.strictEqual(state.stage, 4);
    assert.deepStrictEqual(state.skipped, ['survey (two-file change in one module)']);

    fs.writeFileSync(path.join(runDir, 'design-spec.md'), '# spec\n');
    ok(root, ['gate', runDir, 'design', '--evidence', path.join(runDir, 'design-spec.md')]);
    const gated = ledger(root, ['skip', runDir, 'design', 'changed my mind about it']);
    assert.strictEqual(gated.status, 1);
    assert.match(gated.stderr, /already has a gate receipt/);
  } finally {
    rmDir(root);
  }
});

test('next reads the plain-text form a model is shown, and a spent budget is called out', () => {
  const { root, runDir } = started();
  try {
    const text = ledger(root, ['next', runDir]).stdout;
    assert.match(text, /^run T-1: Stage 1 — INTAKE$/m);
    assert.match(text, /^read: .*01-intake\.md$/m);
    assert.match(text, /^<SKILL_DIR> is .*skills.ticket-loop$/m);

    for (let i = 0; i < 25; i++) ledger(root, ['dispatch', runDir, `slice ${i}`]);
    const spent = ledger(root, ['next', runDir]).stdout;
    assert.match(spent, /^LIMIT: the dispatch budget is spent/m);
  } finally {
    rmDir(root);
  }
});

test('every stage file next can name ships, and the playbook router names the command', () => {
  const { STAGE_FILES, stageFilesMissing } = require(path.join(SCRIPTS_DIR, 'next.js'));
  assert.deepStrictEqual(stageFilesMissing(), []);
  assert.strictEqual(Object.keys(STAGE_FILES).length, 12);
  const router = fs.readFileSync(path.join(SCRIPTS_DIR, '..', 'SKILL.md'), 'utf8');
  assert.match(router, /ledger\.js next <runDir>/);
  for (const file of Object.values(STAGE_FILES)) assert.ok(router.includes(file), `the router's map lists ${file}`);
});
