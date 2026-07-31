'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkRun, rmDir, ledger, chainDirFor, HOOKS_DIR } = require('./helpers.js');

function init(base) {
  const { root, runDir } = mkRun({ verify: { test: 'node tests/run.js' } });
  const res = ledger(root, ['init', runDir, base || 'abc123']);
  assert.strictEqual(res.status, 0, res.stderr);
  return { root, runDir };
}

test('init writes the mirror, a ledger.md skeleton, and a chain OUTSIDE the run dir', () => {
  const { root, runDir } = init('deadbeef');
  try {
    const mirror = JSON.parse(fs.readFileSync(path.join(runDir, 'budget.json'), 'utf8'));
    assert.deepStrictEqual(
      { d: mirror.dispatches, r: mirror.replans, md: mirror.maxDispatches, mr: mirror.maxReplans },
      { d: 0, r: 0, md: 25, mr: 2 }
    );
    const ledgerMd = fs.readFileSync(path.join(runDir, 'ledger.md'), 'utf8');
    assert.ok(ledgerMd.includes('# Ledger — T-1'));
    assert.ok(ledgerMd.includes('base: deadbeef'));
    assert.ok(ledgerMd.includes('## Attempts'));
    // The chain must not live where the loop is allowed to write.
    assert.ok(fs.existsSync(path.join(chainDirFor(root), 'chain.jsonl')));
    assert.ok(fs.existsSync(path.join(chainDirFor(root), 'key')));
  } finally {
    rmDir(root);
  }
});

test('init seals the enforcement profile so mid-run config drift is detectable', () => {
  const { root, runDir } = init();
  try {
    fs.writeFileSync(
      path.join(root, '.agents', 'ticket-loop.config.json'),
      JSON.stringify({ verify: { test: 'exit 0' } })
    );
    const res = ledger(root, ['verify', runDir]);
    assert.strictEqual(res.status, 4);
    assert.ok(/TAMPERED: .*ticket-loop\.config\.json/.test(res.stdout), res.stdout);
  } finally {
    rmDir(root);
  }
});

test('init refuses to reset an existing chain (RESUME safety)', () => {
  const { root, runDir } = init();
  try {
    ledger(root, ['dispatch', runDir, 'implementer: C1']);
    const res = ledger(root, ['init', runDir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('refusing to reset'));
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).dispatches, 1);
  } finally {
    rmDir(root);
  }
});

test('dispatch increments and trips the hard budget at the cap', () => {
  const { root, runDir } = init();
  try {
    for (let i = 1; i <= 25; i++) {
      const res = ledger(root, ['dispatch', runDir, `implementer: C${i}`]);
      assert.strictEqual(res.status, 0, `dispatch ${i} failed: ${res.stderr}`);
      assert.ok(res.stdout.includes(`${i}/25`));
    }
    const blocked = ledger(root, ['dispatch', runDir, 'one too many']);
    assert.strictEqual(blocked.status, 2);
    assert.ok(blocked.stderr.includes('HARD BUDGET'));
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).dispatches, 25);
  } finally {
    rmDir(root);
  }
});

// budget.json is a mirror for humans, never the authority: if the cap were read from the
// same file it guards, raising it would be a one-line edit.
test('editing budget.json cannot raise the cap or reset the count', () => {
  const { root, runDir } = init();
  try {
    for (let i = 0; i < 25; i++) ledger(root, ['dispatch', runDir, 'burn']);
    fs.writeFileSync(
      path.join(runDir, 'budget.json'),
      JSON.stringify({ dispatches: 0, replans: 0, maxDispatches: 9999, maxReplans: 99 })
    );
    const blocked = ledger(root, ['dispatch', runDir, 'post-tamper']);
    assert.strictEqual(blocked.status, 2, 'tampered mirror must not buy another dispatch');
    assert.ok(blocked.stderr.includes('25/25'));
  } finally {
    rmDir(root);
  }
});

test('verify reports mirror drift without letting it change enforcement', () => {
  const { root, runDir } = init();
  try {
    ledger(root, ['dispatch', runDir, 'one']);
    fs.writeFileSync(path.join(runDir, 'budget.json'), JSON.stringify({ dispatches: 99, replans: 7, maxDispatches: 25, maxReplans: 2 }));
    const res = ledger(root, ['verify', runDir]);
    assert.strictEqual(res.status, 4);
    assert.ok(res.stdout.includes('budget.json disagrees'), res.stdout);
  } finally {
    rmDir(root);
  }
});

test('replan trips the circuit breaker after MAX_REPLANS', () => {
  const { root, runDir } = init();
  try {
    assert.strictEqual(ledger(root, ['replan', runDir, 'first']).status, 0);
    assert.strictEqual(ledger(root, ['replan', runDir, 'second']).status, 0);
    const blocked = ledger(root, ['replan', runDir, 'third']);
    assert.strictEqual(blocked.status, 2);
    assert.ok(blocked.stderr.includes('CIRCUIT BREAKER'));
  } finally {
    rmDir(root);
  }
});

// The chain does not move with the run dir, so archiving it aside and re-initing cannot
// hand back a fresh budget.
test('archive + re-init cannot silently reset the budget', () => {
  const { root, runDir } = init();
  try {
    for (let i = 0; i < 25; i++) ledger(root, ['dispatch', runDir, 'burn']);

    assert.strictEqual(ledger(root, ['archive', runDir]).status, 0);
    assert.ok(fs.existsSync(`${runDir}._old_1`));

    const plain = ledger(root, ['init', runDir, 'abc123']);
    assert.strictEqual(plain.status, 1, 'a plain re-init after archiving must still refuse');
    assert.ok(plain.stderr.includes('refusing to reset'));

    const restart = ledger(root, ['init', runDir, 'abc123', '--restart']);
    assert.strictEqual(restart.status, 0);
    assert.ok(restart.stdout.includes('RESTARTED'), 'a restart must announce itself');
    assert.ok(fs.existsSync(path.join(chainDirFor(root), 'chain.1.jsonl')), 'old chain retired, not deleted');

    // The restart is recorded in the new chain, so a report cannot present it as a fresh run.
    const status = JSON.parse(ledger(root, ['status', runDir]).stdout);
    assert.strictEqual(status.dispatches, 0);
  } finally {
    rmDir(root);
  }
});

test('a broken chain is fatal, not silently ignored', () => {
  const { root, runDir } = init();
  try {
    ledger(root, ['dispatch', runDir, 'one']);
    const chainFile = path.join(chainDirFor(root), 'chain.jsonl');
    const lines = fs.readFileSync(chainFile, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[1]);
    rec.payload.label = 'rewritten history';
    lines[1] = JSON.stringify(rec);
    fs.writeFileSync(chainFile, lines.join('\n') + '\n');

    const verify = ledger(root, ['verify', runDir]);
    assert.strictEqual(verify.status, 4);
    assert.ok(verify.stdout.includes('seal does not match'), verify.stdout);

    const dispatch = ledger(root, ['dispatch', runDir, 'next']);
    assert.strictEqual(dispatch.status, 4, 'enforcement must refuse to run on a broken history');
    assert.ok(dispatch.stderr.includes('RECEIPT CHAIN BROKEN'));
  } finally {
    rmDir(root);
  }
});

test('gate records a stage; require fails (exit 3) when the stage never happened', () => {
  const { root, runDir } = init();
  try {
    fs.writeFileSync(path.join(runDir, 'ticket-brief.md'), '# brief\n');
    const gate = ledger(root, ['gate', runDir, 'intake', '--evidence', path.join(runDir, 'ticket-brief.md')]);
    assert.strictEqual(gate.status, 0, gate.stderr);

    assert.strictEqual(ledger(root, ['require', runDir, 'intake']).status, 0);
    const missing = ledger(root, ['require', runDir, 'qa']);
    assert.strictEqual(missing.status, 3);
    assert.ok(missing.stderr.includes('no receipt'));
  } finally {
    rmDir(root);
  }
});

test('gate refuses to seal evidence that does not exist', () => {
  const { root, runDir } = init();
  try {
    const res = ledger(root, ['gate', runDir, 'design', '--evidence', path.join(runDir, 'nope.md')]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('evidence not found'));
  } finally {
    rmDir(root);
  }
});

test('evidence sealed by a gate is reported as TAMPERED when it changes afterwards', () => {
  const { root, runDir } = init();
  try {
    const brief = path.join(runDir, 'ticket-brief.md');
    fs.writeFileSync(brief, '# brief\noriginal scope\n');
    ledger(root, ['gate', runDir, 'intake', '--evidence', brief]);
    fs.writeFileSync(brief, '# brief\nquietly narrowed scope\n');
    const res = ledger(root, ['verify', runDir]);
    assert.strictEqual(res.status, 4);
    assert.ok(res.stdout.includes('TAMPERED'), res.stdout);
  } finally {
    rmDir(root);
  }
});

test('check records a per-criterion history, which is what a FLAKY claim must cite', () => {
  const { root, runDir } = init();
  try {
    ledger(root, ['check', runDir, 'C3', 'FAIL', 'token mismatch']);
    ledger(root, ['check', runDir, 'C3', 'PASS']);
    const res = ledger(root, ['check', runDir, 'C3', 'FAIL']);
    assert.ok(res.stdout.includes('FAIL → PASS → FAIL'), res.stdout);
    assert.strictEqual(ledger(root, ['check', runDir, 'C3', 'MAYBE']).status, 1);
  } finally {
    rmDir(root);
  }
});

// Reach the state a real run is in when the judge reports: frozen contract, then the judge
// dispatched. Both are preconditions for a verdict now.
function frozenRun() {
  const { root, runDir } = init();
  const approved = path.join(runDir, 'done.approved.md');
  fs.writeFileSync(approved, '# Done\n');
  fs.writeFileSync(path.join(runDir, 'done.md'), '# Done\n');
  assert.strictEqual(ledger(root, ['gate', runDir, 'freeze', '--evidence', path.join(runDir, 'done.md')]).status, 0);
  return { root, runDir, approved };
}

test('verdict is recorded with the contract it judged, and rejects unknown verdicts', () => {
  const { root, runDir, approved } = frozenRun();
  try {
    assert.strictEqual(ledger(root, ['dispatch', runDir, 'qa: adversarial review']).status, 0);
    const ok = ledger(root, ['verdict', runDir, 'APPROVE', '--inputs', approved]);
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).verdict, 'APPROVE');
    assert.strictEqual(ledger(root, ['verdict', runDir, 'LGTM']).status, 1);
  } finally {
    rmDir(root);
  }
});

test('a verdict that seals no contract is refused', () => {
  const { root, runDir } = frozenRun();
  try {
    ledger(root, ['dispatch', runDir, 'qa']);
    const bare = ledger(root, ['verdict', runDir, 'APPROVE']);
    assert.strictEqual(bare.status, 1, bare.stderr);
    assert.ok(bare.stderr.includes('does not seal the frozen contract'), bare.stderr);
  } finally {
    rmDir(root);
  }
});

test('a verdict with no subagent dispatched after the freeze is refused', () => {
  const { root, runDir, approved } = frozenRun();
  try {
    const res = ledger(root, ['verdict', runDir, 'APPROVE', '--inputs', approved]);
    assert.strictEqual(res.status, 3, res.stderr);
    assert.ok(res.stderr.includes('no fresh-context judge can have run'), res.stderr);
  } finally {
    rmDir(root);
  }
});

// The whole point of fixing the free receipt: an APPROVE the orchestrator recorded itself,
// without the hook counting a dispatch, must not read as a clean run.
test('verify flags a verdict whose dispatch was not counted by the hook', () => {
  const { root, runDir, approved } = frozenRun();
  try {
    ledger(root, ['dispatch', runDir, 'qa']); // script-sourced, i.e. self-reported
    assert.strictEqual(ledger(root, ['verdict', runDir, 'APPROVE', '--inputs', approved]).status, 0);
    const res = ledger(root, ['verify', runDir]);
    assert.strictEqual(res.status, 4);
    const report = JSON.parse(res.stdout);
    assert.strictEqual(report.intact, false);
    assert.ok(
      report.problems.some((p) => p.includes("judge's independence is unverified")),
      JSON.stringify(report.problems)
    );
  } finally {
    rmDir(root);
  }
});

test('every stage gate must attach the artifact the stage produces', () => {
  const { root, runDir } = init();
  try {
    // The old free receipt: no --evidence at all.
    for (const stage of ['intake', 'survey', 'design', 'approach', 'report']) {
      const res = ledger(root, ['gate', runDir, stage]);
      assert.strictEqual(res.status, 1, `gate ${stage} must refuse with no evidence`);
      assert.ok(res.stderr.includes('among the sealed evidence'), res.stderr);
    }
    // The right artifact, not merely an existing file, is what satisfies the receipt.
    fs.writeFileSync(path.join(runDir, 'notes.md'), 'x\n');
    const wrong = ledger(root, ['gate', runDir, 'intake', '--evidence', path.join(runDir, 'notes.md')]);
    assert.strictEqual(wrong.status, 1, wrong.stderr);
    assert.ok(wrong.stderr.includes('ticket-brief.md'), wrong.stderr);
  } finally {
    rmDir(root);
  }
});

test('receipt-backed stages are bound to the record they claim, not to a file', () => {
  const { root, runDir } = init();
  try {
    const qa = ledger(root, ['gate', runDir, 'qa']);
    assert.strictEqual(qa.status, 1, qa.stderr);
    assert.ok(qa.stderr.includes('no sealed "verdict" record'), qa.stderr);

    const verify = ledger(root, ['gate', runDir, 'verify']);
    assert.strictEqual(verify.status, 1, verify.stderr);
    assert.ok(verify.stderr.includes('no sealed "check" record'), verify.stderr);

    // Recording a real check unlocks the verify gate, and nothing else does.
    assert.strictEqual(ledger(root, ['check', runDir, 'C1', 'PASS']).status, 0);
    assert.strictEqual(ledger(root, ['gate', runDir, 'verify']).status, 0);
  } finally {
    rmDir(root);
  }
});

// A deleted chain must not read as a fresh run: `rm -rf` on the chain dir then `init` would
// otherwise zero every counter and receipt while verify still reported intact:true, because
// the refusal fires only when a chain is present.
test('a deleted chain directory is refused by init, not treated as a fresh run', () => {
  const { root, runDir } = init();
  try {
    for (let i = 0; i < 4; i++) ledger(root, ['dispatch', runDir, 'd' + i]);
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).dispatches, 4);

    fs.rmSync(path.join(root, '.git', 'ticket-loop', 'T-1'), { recursive: true, force: true });
    const res = ledger(root, ['init', runDir, 'abc']);
    assert.strictEqual(res.status, 1, res.stderr);
    assert.ok(res.stderr.includes('NO receipt chain'), res.stderr);
    assert.ok(res.stderr.includes('--restart'), res.stderr);

    // The sanctioned way out records that the history was missing, so a restart cannot be
    // presented as a first run.
    const restart = ledger(root, ['init', runDir, 'abc', '--restart']);
    assert.strictEqual(restart.status, 0, restart.stderr);
    const chainFile = path.join(root, '.git', 'ticket-loop', 'T-1', 'chain.jsonl');
    const initRec = JSON.parse(fs.readFileSync(chainFile, 'utf8').trim().split('\n')[0]);
    assert.match(initRec.payload.restartedFrom, /MISSING/);
  } finally {
    rmDir(root);
  }
});

test('an emptied chain file stops the ledger instead of resetting the budget', () => {
  const { root, runDir } = init();
  try {
    for (let i = 0; i < 3; i++) ledger(root, ['dispatch', runDir, 'd' + i]);
    fs.writeFileSync(path.join(root, '.git', 'ticket-loop', 'T-1', 'chain.jsonl'), '');

    const res = ledger(root, ['dispatch', runDir, 'free one']);
    assert.strictEqual(res.status, 4, res.stderr);
    assert.ok(res.stderr.includes('CHAIN BROKEN'), res.stderr);
  } finally {
    rmDir(root);
  }
});

test('the chain directory itself is protected, not just chain.jsonl', () => {
  const policy = require(path.join(HOOKS_DIR, 'guard_policy.js'));
  for (const cmd of [
    'rm -rf .git/ticket-loop',
    'rm -rf .git/ticket-loop/T-1',
    'mv .git/ticket-loop/T-1 /tmp/stash',
    'rm .git/ticket-loop/T-1/key',
    'rm .git/worktrees/wt/ticket-loop/T-1/head.json',
  ]) {
    assert.ok(policy.commandVerdict(cmd, { runActive: false }), `must be denied: ${cmd}`);
  }
  // ...and the harness's own plugin tree is NOT swept up by that pattern, or this repo would be
  // undevelopable.
  assert.strictEqual(policy.commandVerdict('prettier --write plugins/ticket-loop/README.md', { runActive: false }), null);
  assert.strictEqual(policy.commandVerdict('ls plugins/ticket-loop/skills', { runActive: false }), null);
});

test('dispatch/status on an uninitialized run dir fails with guidance', () => {
  const { root, runDir } = mkRun({});
  try {
    const res = ledger(root, ['dispatch', runDir]);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('init'));
  } finally {
    rmDir(root);
  }
});

test('hook-sourced and script-sourced dispatches are de-duplicated, never summed', () => {
  const { root, runDir } = init();
  try {
    ledger(root, ['dispatch', runDir, 'implementer: C1']);
    ledger(root, ['dispatch', runDir, 'implementer: C1', '--source', 'hook']);
    const status = JSON.parse(ledger(root, ['status', runDir]).stdout);
    assert.strictEqual(status.dispatches, 1, 'the same dispatch counted twice would burn the budget at 2x');
    assert.strictEqual(status.dispatchesByHook, 1);
    assert.strictEqual(status.dispatchesByScript, 1);
  } finally {
    rmDir(root);
  }
});

// Cost reporting exists so claims about the loop getting cheaper can be checked. It reports
// PROXIES on purpose: tokens are unobservable from outside the model, so a token figure here
// could only be the loop's self-report — unverifiable by the standard the rest of the report
// is held to.
test('cost derives spend from the sealed chain, and never claims token counts', () => {
  const { root, runDir } = init();
  try {
    ledger(root, ['dispatch', runDir, 'implementer: C1']);
    ledger(root, ['dispatch', runDir, 'fixer: C3']);
    ledger(root, ['replan', runDir, 'wrong boundary']);

    const cost = JSON.parse(ledger(root, ['cost', runDir]).stdout);
    assert.strictEqual(cost.dispatches, 2);
    assert.strictEqual(cost.replans, 1);
    assert.strictEqual(cost.receiptsByKind.init, 1);
    assert.strictEqual(cost.receiptsByKind.dispatch, 2);
    assert.ok(cost.wallClockMs >= 0, 'wall-clock comes from the receipt timestamps');
    assert.ok(Array.isArray(cost.slowestSpans));

    // No token key, now or by accident later.
    for (const key of Object.keys(cost)) {
      assert.ok(!/token/i.test(key), `cost must not report tokens: found "${key}"`);
    }
    assert.match(cost.note, /NOT token counts/);
  } finally {
    rmDir(root);
  }
});

test('cost degrades honestly when git cannot answer, rather than inventing a diff', () => {
  const { root, runDir } = init();
  try {
    ledger(root, ['dispatch', runDir, 'implementer: C1']);
    // mkRun's .git is a marker directory, so `git diff` cannot resolve the base.
    const cost = JSON.parse(ledger(root, ['cost', runDir]).stdout);
    assert.strictEqual(cost.diffVsBase, null, 'an unavailable diff is null, never zero');
    assert.strictEqual(cost.linesPerDispatch, null, 'no diff means no lines-per-dispatch');
    assert.strictEqual(cost.dispatches, 1, 'chain-derived numbers still report');
  } finally {
    rmDir(root);
  }
});
