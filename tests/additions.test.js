'use strict';
// A QA BLOCK is answered by adding a criterion, and every verdict seals the additions file, so
// the designed path produced a permanent TAMPERED. Appending through the harness re-seals the
// file; anything else that touches it after a verdict is still tampering.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkRun, rmDir, ledger } = require('./helpers.js');

const CRITERION = '- [ ] C9 (test): when the sort is removed, the system shall fail this test | run: node tests/run.js sort';

function judgedRun() {
  const { root, runDir } = mkRun({ verify: { test: 'node tests/run.js' } });
  assert.strictEqual(ledger(root, ['init', runDir, 'abc123']).status, 0);
  const approved = path.join(runDir, 'done.approved.md');
  const additions = path.join(runDir, 'done-additions.md');
  fs.writeFileSync(path.join(runDir, 'done.md'), '# Done\n## Criteria\n- [ ] C1 (test): x | run: node tests/run.js\n');
  fs.writeFileSync(approved, '# Done\n## Criteria\n- [ ] C1 (test): x | run: node tests/run.js\n');
  fs.writeFileSync(additions, '# Additions\n');
  assert.strictEqual(ledger(root, ['gate', runDir, 'freeze', '--evidence', path.join(runDir, 'done.md')]).status, 0);
  assert.strictEqual(ledger(root, ['dispatch', runDir, 'qa: contract [full]', '--source', 'hook']).status, 0);
  const verdict = ledger(root, ['verdict', runDir, 'BLOCK', '--inputs', approved, '--inputs', additions]);
  assert.strictEqual(verdict.status, 0, verdict.stderr);
  return { root, runDir, additions };
}

test('a criterion appended through the harness after a verdict is re-sealed, a hand edit is still TAMPERED', () => {
  const { root, runDir, additions } = judgedRun();
  try {
    const add = ledger(root, ['addition', runDir, CRITERION]);
    assert.strictEqual(add.status, 0, add.stderr);
    assert.ok(fs.readFileSync(additions, 'utf8').includes(CRITERION), 'the line was not appended');

    const ok = ledger(root, ['verify', runDir]);
    assert.strictEqual(ok.status, 0, ok.stdout);
    const report = JSON.parse(ok.stdout);
    assert.ok(report.revisions.some((r) => /C9/.test(r.reason)), JSON.stringify(report.revisions));

    fs.appendFileSync(additions, '- [ ] C10 (test): typed by hand | run: node tests/run.js\n');
    const bad = ledger(root, ['verify', runDir]);
    assert.strictEqual(bad.status, 4);
    assert.ok(bad.stdout.includes('TAMPERED'), bad.stdout);
  } finally {
    rmDir(root);
  }
});

test('addition refuses a non-criterion line, a duplicate id, and a file hand-edited since its seal', () => {
  const { root, runDir, additions } = judgedRun();
  try {
    assert.strictEqual(ledger(root, ['addition', runDir, 'please also check the footer']).status, 1);
    assert.strictEqual(ledger(root, ['addition', runDir, '- [ ] C1 (test): already frozen | run: node tests/run.js']).status, 1, 'C1 exists in the frozen contract');
    assert.strictEqual(ledger(root, ['addition', runDir, CRITERION]).status, 0);
    assert.strictEqual(ledger(root, ['addition', runDir, CRITERION]).status, 1, 'C9 was just added');

    fs.appendFileSync(additions, 'a stray line\n');
    const res = ledger(root, ['addition', runDir, '- [ ] C11 (test): after a hand edit | run: node tests/run.js']);
    assert.strictEqual(res.status, 1);
    assert.ok(/hand|differs|sealed/i.test(res.stderr), res.stderr);
  } finally {
    rmDir(root);
  }
});

test('revise still refuses the additions file, and points at addition', () => {
  const { root, runDir } = judgedRun();
  try {
    const res = ledger(root, ['revise', runDir, path.join(runDir, 'done-additions.md'), '--reason', 'a criterion was added after the judge']);
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes('addition'), res.stderr);
  } finally {
    rmDir(root);
  }
});
