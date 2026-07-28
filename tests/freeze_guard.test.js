'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { HOOKS_DIR, runScript } = require('./helpers.js');

const SCRIPT = path.join(HOOKS_DIR, 'freeze_guard.js');

function runHook(toolInput) {
  return runScript(SCRIPT, [], { input: JSON.stringify({ tool_input: toolInput }) });
}

// --- Edit/Write surface (file_path) ---

test('blocks Edit/Write to frozen done.md inside ticket-runs', () => {
  const res = runHook({ file_path: '.agents/ticket-runs/PROJ-1/done.md' });
  assert.strictEqual(res.status, 2);
  assert.ok(res.stderr.includes('BLOCKED'));
});

test('blocks Edit/Write to any *.approved.md and to budget.json', () => {
  assert.strictEqual(runHook({ file_path: 'docs/spec.approved.md' }).status, 2);
  assert.strictEqual(runHook({ file_path: '.agents/ticket-runs/PROJ-1/budget.json' }).status, 2);
});

test('blocks Windows-style paths too', () => {
  const res = runHook({ file_path: '.agents\\ticket-runs\\PROJ-1\\done.md' });
  assert.strictEqual(res.status, 2);
});

test('allows the writable run artifacts', () => {
  for (const f of [
    '.agents/ticket-runs/PROJ-1/done-additions.md',
    '.agents/ticket-runs/PROJ-1/done.draft.md',
    '.agents/ticket-runs/PROJ-1/ledger.md',
    '.agents/ticket-runs/PROJ-1/report.md',
    'lib/src/done_button.dart',
  ]) {
    assert.strictEqual(runHook({ file_path: f }).status, 0, `should allow ${f}`);
  }
});

// --- Bash/PowerShell surface (command) ---

test('blocks shell redirection into frozen files', () => {
  const res = runHook({ command: 'echo "- [x] C1 done" > .agents/ticket-runs/PROJ-1/done.md' });
  assert.strictEqual(res.status, 2);
});

test('blocks sed -i, rm, and PowerShell Set-Content on frozen files', () => {
  assert.strictEqual(runHook({ command: 'sed -i "s/C3.*//" .agents/ticket-runs/PROJ-1/done.md' }).status, 2);
  assert.strictEqual(runHook({ command: 'rm .agents/ticket-runs/PROJ-1/done.approved.md' }).status, 2);
  assert.strictEqual(runHook({ command: 'Set-Content .agents/ticket-runs/PROJ-1/budget.json \'{"dispatches":0}\'' }).status, 2);
});

test('allows read-only commands that mention frozen files (stage-7 tamper check)', () => {
  assert.strictEqual(runHook({ command: 'git diff --no-index .agents/ticket-runs/PROJ-1/done.approved.md .agents/ticket-runs/PROJ-1/done.md' }).status, 0);
  assert.strictEqual(runHook({ command: 'cat .agents/ticket-runs/PROJ-1/done.md' }).status, 0);
});

test('allows the sanctioned writers (freeze_done.js / ledger.js)', () => {
  assert.strictEqual(runHook({ command: 'node scripts/freeze_done.js .agents/ticket-runs/PROJ-1' }).status, 0);
  assert.strictEqual(runHook({ command: 'node scripts/ledger.js dispatch .agents/ticket-runs/PROJ-1 "qa"' }).status, 0);
});

test('allows unrelated commands and unrelated done.md files', () => {
  assert.strictEqual(runHook({ command: 'flutter test test/ui/profile_test.dart' }).status, 0);
  assert.strictEqual(runHook({ command: 'echo x > docs/done.md' }).status, 0); // not a run artifact
});

test('malformed stdin exits 0 (never blocks the whole session)', () => {
  const res = runScript(SCRIPT, [], { input: 'not json' });
  assert.strictEqual(res.status, 0);
});

// --- bypasses found in review: each must stay blocked ---

test('BYPASS: case tricks do not evade the command surface (Windows is case-insensitive)', () => {
  assert.strictEqual(runHook({ command: 'echo pwned > .agents/Ticket-Runs/PROJ-1/DONE.MD' }).status, 2);
  assert.strictEqual(runHook({ command: 'Rm .agents/TICKET-RUNS/PROJ-1/done.APPROVED.md' }).status, 2);
});

test('BYPASS: mentioning a sanctioned script in a comment/tail does not ride the exemption', () => {
  assert.strictEqual(
    runHook({ command: 'echo pwned > .agents/ticket-runs/PROJ-1/done.md # via ledger.js' }).status,
    2
  );
  assert.strictEqual(
    runHook({ command: 'node scripts/ledger.js status .agents/ticket-runs/PROJ-1 && echo p > .agents/ticket-runs/PROJ-1/done.md' }).status,
    2
  );
  assert.strictEqual(
    runHook({ command: 'node scripts/ledger.js status .agents/ticket-runs/PROJ-1\nrm .agents/ticket-runs/PROJ-1/budget.json' }).status,
    2
  );
});

test('BYPASS: deleting the run dir (which would let ledger.js init reset the budget) is blocked', () => {
  assert.strictEqual(runHook({ command: 'rm -rf .agents/ticket-runs/PROJ-1' }).status, 2);
  assert.strictEqual(runHook({ command: 'rm .agents/ticket-runs/PROJ-1/*' }).status, 2);
  assert.strictEqual(runHook({ command: 'Remove-Item -Recurse -Force .agents\\ticket-runs\\PROJ-1' }).status, 2);
  assert.strictEqual(runHook({ command: 'del .agents\\ticket-runs\\PROJ-1\\budget.json' }).status, 2);
});

test('the sanctioned CLEAN-RESTART archive step (a move, not a delete) stays allowed', () => {
  assert.strictEqual(
    runHook({ command: 'mv .agents/ticket-runs/PROJ-1 .agents/ticket-runs/PROJ-1._old_1' }).status,
    0
  );
  assert.strictEqual(
    runHook({ command: 'Move-Item .agents\\ticket-runs\\PROJ-1 .agents\\ticket-runs\\PROJ-1._old_1' }).status,
    0
  );
});
