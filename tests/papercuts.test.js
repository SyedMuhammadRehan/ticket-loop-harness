'use strict';
// When the harness gets in a session's way, the session says so in the run's papercuts.md, and the
// report and a repo-wide listing carry it to whoever owns the harness. A report never loosens a gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR, mkRun, rmDir, ledger, runScript } = require('./helpers.js');

const GOOD = `# Papercuts

## worktree_deps rejects the documented one-argument form
- trying: install dependencies in the new worktree at Stage 0
- ran: node worktree_deps.js ../wt
- expected: linked, present or install
- happened: it printed its usage line and exited 1
- instead: passed --main explicitly
- fix: treat the worktree as the positional argument when --main is absent
`;

const MISSING_FIX = `
## the guard refused a read-only wc
- trying: count source lines to size the split
- happened: refused as a write under src/auth/**
`;

const json = (res) => {
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};

test('a run lists its papercuts, and names one missing a field the owner needs', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
    assert.strictEqual(json(ledger(root, ['papercuts', runDir])).count, 0, 'none filed is none, not an error');
    fs.writeFileSync(path.join(runDir, 'papercuts.md'), GOOD + MISSING_FIX);
    const out = json(ledger(root, ['papercuts', runDir]));
    assert.strictEqual(out.count, 2);
    assert.strictEqual(out.entries[0].title, 'worktree_deps rejects the documented one-argument form');
    assert.strictEqual(out.entries[0].fix, 'treat the worktree as the positional argument when --main is absent');
    assert.deepStrictEqual(out.malformed, [{ title: 'the guard refused a read-only wc', missing: ['fix'] }]);
  } finally {
    rmDir(root);
  }
});

test('a value wrapped onto the next line stays one value', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
    fs.writeFileSync(
      path.join(runDir, 'papercuts.md'),
      '## long one\n- trying: a\n- happened: the gate tested nine worktrees\n  at every stop, 35 minutes in all\n- fix: b\n'
    );
    const [entry] = json(ledger(root, ['papercuts', runDir])).entries;
    assert.strictEqual(entry.happened, 'the gate tested nine worktrees at every stop, 35 minutes in all');
  } finally {
    rmDir(root);
  }
});

test('the repo listing gathers papercuts from every run, closed and archived ones too', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    const runs = path.dirname(runDir);
    for (const name of ['T-2', 'T-3._old_1']) fs.mkdirSync(path.join(runs, name), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'papercuts.md'), GOOD);
    fs.writeFileSync(path.join(runs, 'T-2', 'closed.json'), '{}');
    fs.writeFileSync(path.join(runs, 'T-2', 'papercuts.md'), MISSING_FIX);
    fs.writeFileSync(path.join(runs, 'T-3._old_1', 'papercuts.md'), GOOD);
    const out = json(ledger(root, ['papercuts', '--repo', root]));
    assert.strictEqual(out.total, 3);
    assert.deepStrictEqual(out.runs.map((r) => [r.run, r.count]), [['T-1', 1], ['T-2', 1], ['T-3._old_1', 1]]);
    assert.strictEqual(out.malformed, 1);
  } finally {
    rmDir(root);
  }
});

test('the cost report counts the run papercuts', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
    fs.writeFileSync(path.join(runDir, 'papercuts.md'), GOOD + MISSING_FIX);
    const cost = json(ledger(root, ['cost', runDir]));
    assert.deepStrictEqual(cost.papercuts, { count: 2, malformed: 1 });
  } finally {
    rmDir(root);
  }
});

test('a session may write papercuts.md mid-run with the edit tools', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
    const res = runScript(path.join(HOOKS_DIR, 'freeze_guard.js'), [], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(runDir, 'papercuts.md') }, cwd: root }),
      cwd: root,
    });
    assert.strictEqual(res.status, 0, res.stderr);
  } finally {
    rmDir(root);
  }
});
