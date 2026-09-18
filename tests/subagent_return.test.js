'use strict';
// The invariant under test: a dispatched subagent's return reaches the record without the
// orchestrator's cooperation, so a dispatch that never returned and one returned but never
// accounted for can be told apart afterwards.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR, SCRIPTS_DIR, mkRun, mkFakeRepo, rmDir, runScript, ledger } = require('./helpers.js');
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

const SCRIPT = path.join(HOOKS_DIR, 'subagent_return.js');
const hook = (root, input) =>
  runScript(SCRIPT, [], {
    cwd: root,
    input: typeof input === 'string' ? input : JSON.stringify({ cwd: root, hook_event_name: 'SubagentStop', ...input }),
  });

test('a subagent return is recorded against the oldest dispatch still out, with the agent named', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
    assert.strictEqual(ledger(root, ['dispatch', runDir, 'implementer: C1', '--source', 'hook']).status, 0);
    const res = hook(root, { agent_id: 'ag-1', agent_type: 'general-purpose', last_assistant_message: 'done: 12 lines' });
    assert.strictEqual(res.status, 0, res.stderr);
    const mark = chain.last(runDir, 'returned');
    assert.ok(mark, 'a returned record was appended');
    assert.strictEqual(mark.payload.dispatchSeq, 2);
    assert.strictEqual(mark.payload.agentId, 'ag-1');
    assert.strictEqual(mark.payload.agentType, 'general-purpose');
    assert.strictEqual(mark.payload.messageChars, 14);
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).open[0].returned, true);
  } finally {
    rmDir(root);
  }
});

test('outside a run the hook records nothing and stays silent', () => {
  const root = mkFakeRepo({ verify: { test: 'x' } });
  try {
    const res = hook(root, { agent_id: 'x' });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stderr.trim(), '');
    assert.strictEqual(res.stdout.trim(), '');
  } finally {
    rmDir(root);
  }
});

test('malformed input, and a return with nothing out, both exit 0 and append nothing', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    assert.strictEqual(hook(root, '{ not json').status, 0);
    assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
    const res = hook(root, { agent_id: 'x' });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(chain.ofKind(runDir, 'returned').length, 0);
  } finally {
    rmDir(root);
  }
});

test('a return that cannot be recorded never blocks, but says so', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    // Active by the hooks' definition, with no chain behind it: the ledger refuses to record.
    fs.writeFileSync(path.join(runDir, 'budget.json'), '{}');
    const res = hook(root, { agent_id: 'x' });
    assert.strictEqual(res.status, 0);
    assert.ok(res.stderr.includes('not recorded'), res.stderr);
  } finally {
    rmDir(root);
  }
});
