'use strict';
// The invariant under test: deleting `.agents/` does not disarm the gates. A receipt chain under
// the git dir that promised to record its own close, and has not, is an open run whether or not
// its run directory survives, and every hook that would act on a run fails closed on it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR, SCRIPTS_DIR, mkRun, rmDir, runScript, chainDirFor } = require('./helpers.js');
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));
const lib = require(path.join(HOOKS_DIR, 'hook_lib.js'));

const PROFILE = { verify: { test: 'node -e 0' }, hooks: { stopGate: { extensions: ['.py'], mode: 'full' } } };

// A chain as `ledger.js init` leaves it, written directly so the case does not depend on the
// ledger's version.
function chainedRun(initPayload = { closesInChain: true }) {
  const { root, runDir } = mkRun(PROFILE);
  chain.create(runDir);
  chain.append(runDir, 'init', { baseSha: 'abc', maxDispatches: 25, maxReplans: 3, evidence: [], ...initPayload });
  return { root, runDir };
}

function orphaned(initPayload) {
  const made = chainedRun(initPayload);
  rmDir(made.runDir);
  return made;
}

test('a promised chain with no close and no run dir is an orphaned active run', () => {
  const { root, runDir } = orphaned();
  try {
    const records = lib.runRecords(root);
    assert.strictEqual(records.length, 1, JSON.stringify(records));
    assert.strictEqual(records[0].orphaned, true);
    assert.strictEqual(path.resolve(records[0].dir), path.resolve(runDir), 'the orphan names where its run dir should be');
    assert.strictEqual(path.resolve(records[0].chainDir), path.resolve(chainDirFor(root)));
    assert.deepStrictEqual(lib.activeRuns(root).map((d) => path.resolve(d)), [path.resolve(runDir)]);
  } finally {
    rmDir(root);
  }
});

test('a closed chain, a legacy chain, and an archived run are never orphans', () => {
  const closed = orphaned();
  const legacy = orphaned({});
  const archived = chainedRun();
  try {
    chain.append(closed.runDir, 'close', { reportGateSeq: 1 });
    assert.deepStrictEqual(lib.runRecords(closed.root), [], 'a chain that recorded its close is over');
    assert.deepStrictEqual(lib.runRecords(legacy.root), [], 'a chain from before the promise cannot be judged by it');
    fs.renameSync(archived.runDir, `${archived.runDir}._old_1`);
    assert.deepStrictEqual(lib.runRecords(archived.root), [], 'ledger.js archive leaves the chain behind on purpose');
  } finally {
    for (const r of [closed, legacy, archived]) rmDir(r.root);
  }
});

test('a dispatch into an orphaned run is refused, naming the chain and the way out', () => {
  const { root } = orphaned();
  try {
    const res = runScript(path.join(HOOKS_DIR, 'dispatch_guard.js'), [], {
      cwd: root,
      input: JSON.stringify({ cwd: root, tool_input: { subagent_type: 'general-purpose', description: 'C1' } }),
    });
    assert.strictEqual(res.status, 2, res.stderr);
    assert.ok(res.stderr.includes(path.join('ticket-loop', 'T-1')), res.stderr);
    assert.match(res.stderr, /ledger\.js archive/);
  } finally {
    rmDir(root);
  }
});

test('a "done" claim over an orphaned run is blocked', () => {
  const { root } = orphaned();
  try {
    const res = runScript(path.join(HOOKS_DIR, 'stop_gate.js'), [], { cwd: root, input: '{}' });
    assert.strictEqual(res.status, 2, res.stderr);
    assert.match(res.stderr, /run directory .* is gone/);
  } finally {
    rmDir(root);
  }
});

test('a session opening on an orphaned run is told so', () => {
  const { root } = orphaned();
  try {
    const res = runScript(path.join(HOOKS_DIR, 'session_start.js'), [], { cwd: root, input: JSON.stringify({ cwd: root }) });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /run directory is gone/);
  } finally {
    rmDir(root);
  }
});

test('a return into an orphaned run is not recorded, and says so without blocking', () => {
  const { root } = orphaned();
  try {
    const res = runScript(path.join(HOOKS_DIR, 'subagent_return.js'), [], { cwd: root, input: JSON.stringify({ cwd: root, agent_id: 'a1' }) });
    assert.strictEqual(res.status, 0);
    assert.match(res.stderr, /not recorded/);
  } finally {
    rmDir(root);
  }
});
