'use strict';
// Integration tests for the hook shell. The decision corpus lives in guard_policy.test.js;
// what matters here is that the hook wires stdin -> policy -> exit code correctly, and that
// it works out "is a run active?" from the filesystem.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR, runScript, mkFakeRepo, rmDir } = require('./helpers.js');

const SCRIPT = path.join(HOOKS_DIR, 'freeze_guard.js');
const RUN = '.agents/ticket-runs/PROJ-1';

// A run dir with budget.json and no report.md == a run in flight.
function repoWithRun({ closed = false, reportWritten = false } = {}) {
  const root = mkFakeRepo({ verify: { test: 'node tests/run.js' } });
  const runDir = path.join(root, RUN);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'budget.json'), '{}');
  if (reportWritten) fs.writeFileSync(path.join(runDir, 'report.md'), '# report\n');
  if (closed) fs.writeFileSync(path.join(runDir, 'closed.json'), '{"closedAt":"now"}');
  return root;
}

function runHook(toolInput, cwd) {
  return runScript(SCRIPT, [], { input: JSON.stringify({ tool_input: toolInput, cwd }), cwd });
}

test('blocks Edit/Write to frozen done.md, *.approved.md and budget.json', () => {
  const root = repoWithRun();
  try {
    for (const f of [`${RUN}/done.md`, `${RUN}\\done.md`, 'docs/spec.approved.md', `${RUN}/budget.json`]) {
      const res = runHook({ file_path: f }, root);
      assert.strictEqual(res.status, 2, `should block ${f}`);
      assert.ok(res.stderr.includes('BLOCKED'));
    }
  } finally {
    rmDir(root);
  }
});

test('covers the NotebookEdit surface too', () => {
  const root = repoWithRun();
  try {
    assert.strictEqual(runHook({ notebook_path: `${RUN}/done.md` }, root).status, 2);
  } finally {
    rmDir(root);
  }
});

test('allows the writable run artifacts', () => {
  const root = repoWithRun();
  try {
    for (const f of [
      `${RUN}/done-additions.md`,
      `${RUN}/done.draft.md`,
      `${RUN}/ledger.md`,
      `${RUN}/report.md`,
      'lib/src/done_button.dart',
    ]) {
      assert.strictEqual(runHook({ file_path: f }, root).status, 0, `should allow ${f}`);
    }
  } finally {
    rmDir(root);
  }
});

test('blocks writes to the enforcement control plane while a run is active', () => {
  const root = repoWithRun();
  try {
    for (const f of ['.agents/ticket-loop.config.json', '.claude/hooks/state/stop-state.json']) {
      const res = runHook({ file_path: f }, root);
      assert.strictEqual(res.status, 2, `should block ${f} mid-run`);
      assert.ok(res.stderr.includes('control plane'));
    }
  } finally {
    rmDir(root);
  }
});

test('releases the control plane once the run is CLOSED', () => {
  const root = repoWithRun({ closed: true });
  try {
    assert.strictEqual(runHook({ file_path: '.agents/ticket-loop.config.json' }, root).status, 0);
    // Frozen artifacts stay frozen regardless.
    assert.strictEqual(runHook({ file_path: `${RUN}/done.md` }, root).status, 2);
  } finally {
    rmDir(root);
  }
});

// If report.md were the active-run signal, writing the deliverable would unlock the hook
// sources, the profile and the hook state mid-run.
test('writing report.md does NOT release the control plane', () => {
  const root = repoWithRun({ reportWritten: true });
  try {
    for (const f of [
      '.agents/ticket-loop.config.json',
      'hooks/stop_gate.js',
      'hooks/hooks.json',
      '.claude/hooks/state/stop-state.json',
    ]) {
      const res = runHook({ file_path: f }, root);
      assert.strictEqual(res.status, 2, `${f} must stay locked while the run is open`);
    }
  } finally {
    rmDir(root);
  }
});

test('blocks shell writes and passes read-only commands through', () => {
  const root = repoWithRun();
  try {
    assert.strictEqual(runHook({ command: `echo "- [x] C1 done" > ${RUN}/done.md` }, root).status, 2);
    assert.strictEqual(runHook({ command: `python -c "open('${RUN}/done.md','w')"` }, root).status, 2);
    assert.strictEqual(runHook({ command: `cat ${RUN}/done.md` }, root).status, 0);
    assert.strictEqual(
      runHook({ command: `git diff --no-index ${RUN}/done.approved.md ${RUN}/done.md` }, root).status,
      0
    );
  } finally {
    rmDir(root);
  }
});

test('the denial message points at the sanctioned route', () => {
  const root = repoWithRun();
  try {
    const res = runHook({ command: `rm -rf ${RUN}` }, root);
    assert.strictEqual(res.status, 2);
    assert.ok(res.stderr.includes('done-additions.md'));
    assert.ok(res.stderr.includes('ledger.js'));
  } finally {
    rmDir(root);
  }
});

test('malformed stdin exits 0 (never wedges the whole session)', () => {
  assert.strictEqual(runScript(SCRIPT, [], { input: 'not json' }).status, 0);
  assert.strictEqual(runScript(SCRIPT, [], { input: '' }).status, 0);
});

test('a tool call with neither a path nor a command is ignored', () => {
  const root = repoWithRun();
  try {
    assert.strictEqual(runHook({ pattern: 'TODO' }, root).status, 0);
  } finally {
    rmDir(root);
  }
});

// GATE A/C is only a fence if code matches edits against the profile's riskPaths: an edit
// under a risk-tier glob must be denied until a human's clearance for that area is RECORDED.
function repoWithRiskPaths(riskPaths, cleared) {
  const root = mkFakeRepo({ verify: { test: 'node tests/run.js' }, riskPaths });
  const runDir = path.join(root, RUN);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'budget.json'), '{}');
  if (cleared) {
    fs.writeFileSync(
      path.join(runDir, 'clearances.json'),
      JSON.stringify({ cleared: cleared.map((glob) => ({ glob, reason: 'test', at: 'now' })) })
    );
  }
  return root;
}

test('an edit under a riskPaths glob is denied while a run is active', () => {
  const root = repoWithRiskPaths(['lib/ui/auth/**', '**/migrations/**', 'pubspec.yaml']);
  try {
    for (const f of ['lib/ui/auth/login_screen.dart', 'db/migrations/003_add_users.sql', 'pubspec.yaml']) {
      const res = runHook({ file_path: f }, root);
      assert.strictEqual(res.status, 2, `${f} is risk-tier and must be denied:\n${res.stderr}`);
      assert.match(res.stderr, /risk-tier path/);
    }
  } finally {
    rmDir(root);
  }
});

test('ordinary paths are untouched by riskPaths', () => {
  const root = repoWithRiskPaths(['lib/ui/auth/**']);
  try {
    for (const f of ['lib/ui/profile/profile_screen.dart', 'test/ui/profile_test.dart', 'README.md']) {
      assert.strictEqual(runHook({ file_path: f }, root).status, 0, `${f} must stay editable`);
    }
  } finally {
    rmDir(root);
  }
});

test('a recorded clearance unlocks only the area it names', () => {
  const root = repoWithRiskPaths(['lib/ui/auth/**', '**/migrations/**'], ['lib/ui/auth/**']);
  try {
    assert.strictEqual(runHook({ file_path: 'lib/ui/auth/login_screen.dart' }, root).status, 0, 'cleared area opens');
    assert.strictEqual(
      runHook({ file_path: 'db/migrations/003_add_users.sql' }, root).status,
      2,
      'an uncleared area stays shut — clearance is per-glob, not a blanket'
    );
  } finally {
    rmDir(root);
  }
});

test('a malformed clearance mirror denies rather than opening everything', () => {
  const root = repoWithRiskPaths(['lib/ui/auth/**']);
  try {
    fs.writeFileSync(path.join(root, RUN, 'clearances.json'), '{ not json');
    assert.strictEqual(runHook({ file_path: 'lib/ui/auth/login_screen.dart' }, root).status, 2);
  } finally {
    rmDir(root);
  }
});

test('riskPaths do not apply when no run is active', () => {
  const root = mkFakeRepo({ verify: { test: 'x' }, riskPaths: ['lib/ui/auth/**'] });
  try {
    assert.strictEqual(
      runHook({ file_path: 'lib/ui/auth/login_screen.dart' }, root).status,
      0,
      'outside a run this hook must not police ordinary development'
    );
  } finally {
    rmDir(root);
  }
});

// The mechanism guarding the file the hook trusts. Without this line in FROZEN_PATH_PATTERNS,
// a single Write to clearances.json forges a blanket clearance and skips ledger.js entirely.
test('the clearance mirror itself cannot be written directly', () => {
  const root = repoWithRiskPaths(['lib/ui/auth/**']);
  try {
    const res = runHook({ file_path: `${RUN}/clearances.json` }, root);
    assert.strictEqual(res.status, 2, `forging the mirror must be denied:\n${res.stderr}`);
    assert.match(res.stderr, /frozen run artifact/);
  } finally {
    rmDir(root);
  }
});

// Clearance is matched against the riskPath glob, not the file path — otherwise one broad
// pattern covering the file opens every risk area at once.
test('a broad clearance pattern does not open areas it was not granted for', () => {
  for (const cleared of [['**'], ['db/**'], ['lib/**']]) {
    const root = repoWithRiskPaths(['lib/ui/auth/**', '**/migrations/**'], cleared);
    try {
      for (const f of ['lib/ui/auth/login_screen.dart', 'db/migrations/003_add_users.sql']) {
        assert.strictEqual(
          runHook({ file_path: f }, root).status,
          2,
          `cleared=${JSON.stringify(cleared)} must not open ${f} — it is not a declared riskPath`
        );
      }
    } finally {
      rmDir(root);
    }
  }
});
