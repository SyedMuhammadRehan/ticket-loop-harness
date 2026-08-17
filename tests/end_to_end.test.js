'use strict';
// Walks a whole run through the enforcement layer, in order, the way SKILL.md drives it.
// Unit tests prove each guard works; this proves they COMPOSE — that a run which follows the
// playbook completes with an intact chain, and that the shortcuts a lazy orchestrator would
// take are refused at the point where it would take them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, HOOKS_DIR, mkRun, rmDir, runScript, ledger } = require('./helpers.js');

const VALIDATE = path.join(SCRIPTS_DIR, 'validate_done.js');
const FREEZE = path.join(SCRIPTS_DIR, 'freeze_done.js');
const GUARD = path.join(HOOKS_DIR, 'freeze_guard.js');
const DISPATCH = path.join(HOOKS_DIR, 'dispatch_guard.js');

const CONFIG = { verify: { test: 'pytest -q', analyze: 'ruff check .' } };

const DRAFT = `# Done — T-1
## Criteria
- [ ] C1 (test): repository maps 404/500 to a typed ProfileError | run: pytest tests/test_profile_repo.py
- [ ] C2 (test): the screen renders the friendly error state | run: pytest tests/test_profile_screen.py
- [ ] C3 (analyzer): zero analyzer errors | run: ruff check .
## Out of scope
- offline/no-network banner (separate ticket)
`;

const APPROACH = `# Approach — T-1
## Data
- profile: owned by the API; this change reads it
## Boundary
- change lives behind ProfileRepository; callers keep the same interface
## Options
- A: map errors in the repository — UI stays transport-blind
- B: map errors in the widget — fewer files, but couples UI to the HTTP client
## Chosen
- A: error semantics belong at the data boundary; B leaks transport details upward | reuses: the existing Result type and its error mapping
## Failure modes
- API returns 404 vs 500 and needs distinct messages | covered-by: C1
- retry storms if the user hammers the button | covered-by: out-of-scope (tracked by the rate-limit ticket)
## Slice order
- 1st: C1 repository mapping — if typed errors cannot cross this boundary, A is wrong
`;

const guard = (root, toolInput) =>
  runScript(GUARD, [], { input: JSON.stringify({ tool_input: toolInput, cwd: root }), cwd: root });
const dispatch = (root) =>
  runScript(DISPATCH, [], {
    input: JSON.stringify({ tool_input: { subagent_type: 'implementer', description: 'slice' }, cwd: root }),
    cwd: root,
  });

test('a run that follows the playbook completes with an intact, fully-receipted chain', () => {
  const { root, runDir } = mkRun(CONFIG);
  try {
    // Stage 0 — preflight
    assert.strictEqual(ledger(root, ['init', runDir, 'basesha123']).status, 0);

    // Stage 1 — intake
    fs.writeFileSync(path.join(runDir, 'ticket-brief.md'), '# T-1\n1. friendly error state\n');
    assert.strictEqual(
      ledger(root, ['gate', runDir, 'intake', '--evidence', path.join(runDir, 'ticket-brief.md')]).status,
      0
    );

    // Every ledger call below asserts its exit code. They did not, which meant a change that
    // made a gate refuse would leave this test green and the run silently un-receipted.
    const ok = (args) => {
      const res = ledger(root, args);
      assert.strictEqual(res.status, 0, `ledger ${args.slice(0, 3).join(' ')} failed: ${res.stderr}`);
      return res;
    };

    // Stage 1.5 — survey (feature-sized, so an approach becomes mandatory)
    fs.writeFileSync(path.join(runDir, 'codebase-map.md'), '# map\n- data/profile_repository.py\n');
    ok(['gate', runDir, 'survey', '--evidence', path.join(runDir, 'codebase-map.md')]);

    // Stage 2.5 — approach
    fs.writeFileSync(path.join(runDir, 'approach.md'), APPROACH);
    ok(['gate', runDir, 'approach', '--evidence', path.join(runDir, 'approach.md')]);

    // Stage 3 — define done, validate, freeze
    fs.writeFileSync(path.join(runDir, 'done.draft.md'), DRAFT);
    assert.strictEqual(runScript(VALIDATE, [runDir], { cwd: root }).status, 0);
    assert.strictEqual(runScript(FREEZE, [runDir], { cwd: root }).status, 0);
    ok(['gate', runDir, 'validate']);

    // Stage 4 — implement (dispatches counted by the hook)
    for (let i = 0; i < 3; i++) assert.strictEqual(dispatch(root).status, 0);

    // Stage 5 — verify, recording each check
    ok(['check', runDir, 'C1', 'PASS', '--by', 'command', '5/5']);
    ok(['check', runDir, 'C2', 'FAIL', '--by', 'command', 'wrong copy']);
    ok(['check', runDir, 'C2', 'PASS', '--by', 'command', 'fixed on attempt 2']);
    ok(['check', runDir, 'C3', 'PASS', '--by', 'observed']);
    ok(['gate', runDir, 'verify']);

    // Stage 5.5 — QA seals its own verdict over the contract it read
    assert.strictEqual(dispatch(root).status, 0);
    assert.strictEqual(
      ledger(root, [
        'verdict', runDir, 'APPROVE_WITH_COMMENTS',
        '--inputs', path.join(runDir, 'done.approved.md'),
        '--inputs', path.join(runDir, 'done-additions.md'),
      ]).status,
      0
    );
    ok(['gate', runDir, 'qa']);

    // Stage 7 — report, then CLOSE. The run stays active until it is closed.
    fs.writeFileSync(path.join(runDir, 'report.md'), '# Report — T-1\nStatus: COMPLETE\n');
    ok(['gate', runDir, 'report', '--evidence', path.join(runDir, 'report.md')]);

    const verify = ledger(root, ['verify', runDir]);
    assert.strictEqual(verify.status, 0, verify.stdout);
    const report = JSON.parse(verify.stdout);
    assert.strictEqual(report.intact, true);
    assert.deepStrictEqual(report.problems, []);

    const status = JSON.parse(ledger(root, ['status', runDir]).stdout);
    assert.strictEqual(status.dispatches, 4);
    assert.strictEqual(status.verdict, 'APPROVE_WITH_COMMENTS');
    assert.strictEqual(status.baseSha, 'basesha123');
    for (const stage of ['intake', 'survey', 'approach', 'freeze', 'validate', 'verify', 'qa', 'report']) {
      assert.ok(status.gates.includes(stage), `missing receipt for ${stage}`);
    }

    // The budget is still live until the close, and the close is what releases it.
    assert.strictEqual(dispatch(root).status, 0);
    ok(['close', runDir]);
    assert.ok(fs.existsSync(path.join(runDir, 'closed.json')));
  } finally {
    rmDir(root);
  }
});

test('the lazy path is refused at every step a shortcut would be taken', () => {
  const { root, runDir } = mkRun(CONFIG);
  try {
    ledger(root, ['init', runDir, 'basesha123']);
    fs.writeFileSync(path.join(runDir, 'codebase-map.md'), '# map\n');

    // Shortcut 1: a contract that is green by construction.
    fs.writeFileSync(
      path.join(runDir, 'done.draft.md'),
      '# Done\n## Criteria\n- [x] C1 (analyzer): fine | run: true\n- [x] C1 (analyzer): fine | run: true\n## Out of scope\n- everything\n'
    );
    const bad = runScript(VALIDATE, [runDir], { cwd: root });
    assert.strictEqual(bad.status, 1);
    for (const needle of [
      'no (test) or (runtime) criterion',
      'duplicate criterion id C1',
      'already ticked before the freeze',
      'must be checked by the real command',
      'there is no approach.md',
    ]) {
      assert.ok(bad.stderr.includes(needle), `expected "${needle}" in:\n${bad.stderr}`);
    }

    // Shortcut 2: freeze it anyway.
    assert.strictEqual(runScript(FREEZE, [runDir], { cwd: root }).status, 1);
    assert.ok(!fs.existsSync(path.join(runDir, 'done.md')));

    // Do it properly, then try to move the goalposts.
    fs.writeFileSync(path.join(runDir, 'approach.md'), APPROACH);
    fs.writeFileSync(path.join(runDir, 'done.draft.md'), DRAFT);
    assert.strictEqual(runScript(VALIDATE, [runDir], { cwd: root }).status, 0);
    assert.strictEqual(runScript(FREEZE, [runDir], { cwd: root }).status, 0);

    // Shortcut 3: weaken the frozen contract, by any route.
    const done = path.join(runDir, 'done.md');
    assert.strictEqual(guard(root, { file_path: done }).status, 2);
    assert.strictEqual(guard(root, { command: `echo "- [x] all done" > ${done}` }).status, 2);
    assert.strictEqual(guard(root, { command: `python -c "open(r'${done}','w')"` }).status, 2);
    assert.strictEqual(guard(root, { command: `cd ${runDir} && sed -i "s/C1.*//" done.md` }).status, 2);

    // Shortcut 4: disarm the gates mid-run.
    assert.strictEqual(guard(root, { file_path: '.agents/ticket-loop.config.json' }).status, 2);
    assert.strictEqual(guard(root, { file_path: 'plugins/ticket-loop/hooks/stop_gate.js' }).status, 2);

    // Shortcut 5: grant yourself more dispatches.
    for (let i = 0; i < 25; i++) dispatch(root);
    assert.strictEqual(dispatch(root).status, 2);
    fs.writeFileSync(path.join(runDir, 'budget.json'), JSON.stringify({ dispatches: 0, maxDispatches: 9999 }));
    assert.strictEqual(dispatch(root).status, 2, 'editing the mirror must not buy a dispatch');

    // Shortcut 6: claim a QA pass that never happened. Asserting `require` fails BEFORE
    // anything is claimed proves nothing — the claim route is what must be refused, so drive
    // it: a `gate qa` carrying no verdict must not be able to satisfy `require qa`.
    assert.strictEqual(ledger(root, ['require', runDir, 'qa']).status, 3);
    const forgedGate = ledger(root, ['gate', runDir, 'qa']);
    assert.strictEqual(forgedGate.status, 1, 'a qa receipt with no verdict behind it must be refused');
    assert.ok(forgedGate.stderr.includes('no sealed "verdict" record'), forgedGate.stderr);
    assert.strictEqual(ledger(root, ['require', runDir, 'qa']).status, 3, 'and require still fails');

    const forgedVerdict = ledger(root, ['verdict', runDir, 'APPROVE']);
    assert.strictEqual(forgedVerdict.status, 1, 'a verdict sealing no contract must be refused');
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).verdict, null);

    // Shortcut 7: end the run early to get out from under the gates.
    fs.writeFileSync(path.join(runDir, 'report.md'), '# report\nStatus: COMPLETE\n');
    assert.strictEqual(dispatch(root).status, 2, 'report.md must not release the dispatch budget');
    assert.strictEqual(guard(root, { file_path: '.agents/ticket-loop.config.json' }).status, 2);
    assert.strictEqual(
      guard(root, { file_path: path.join(runDir, 'closed.json') }).status,
      2,
      'the close marker cannot be written by hand'
    );
    assert.strictEqual(ledger(root, ['close', runDir]).status, 3, 'close needs a report receipt');

    // The sealed history itself was never broken by any of the above — but the mirror edit
    // from shortcut 5 is still reported, which is the point: it changed nothing and it shows.
    const res = ledger(root, ['verify', runDir]);
    assert.strictEqual(res.status, 4);
    const report = JSON.parse(res.stdout);
    assert.ok(
      report.problems.every((p) => /budget\.json/.test(p)),
      `only the tampered mirror should be reported, got:\n${report.problems.join('\n')}`
    );
    assert.ok(report.problems.some((p) => p.includes('disagrees with the sealed chain')));
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).dispatches, 25);
  } finally {
    rmDir(root);
  }
});

test('tampering that gets through anyway is reported, not absorbed', () => {
  const { root, runDir } = mkRun(CONFIG);
  try {
    ledger(root, ['init', runDir, 'basesha123']);
    fs.writeFileSync(path.join(runDir, 'done.draft.md'), DRAFT);
    runScript(VALIDATE, [runDir], { cwd: root });
    runScript(FREEZE, [runDir], { cwd: root });
    assert.strictEqual(ledger(root, ['verify', runDir]).status, 0);

    // Write BOTH copies, which is what defeated the old self-reported diff check.
    const weakened = DRAFT.replace('maps 404/500 to a typed ProfileError', 'does something');
    fs.writeFileSync(path.join(runDir, 'done.md'), weakened);
    fs.writeFileSync(path.join(runDir, 'done.approved.md'), weakened);

    const res = ledger(root, ['verify', runDir]);
    assert.strictEqual(res.status, 4, 'the integrity check must fail loudly');
    const report = JSON.parse(res.stdout);
    assert.strictEqual(report.intact, false);
    assert.ok(report.problems.some((p) => p.includes('done.md')));
    assert.ok(report.problems.some((p) => p.includes('done.approved.md')));
  } finally {
    rmDir(root);
  }
});
