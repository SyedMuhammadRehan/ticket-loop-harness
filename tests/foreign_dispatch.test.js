'use strict';
// Another Claude session working in the same repo is not this run: its agents are recorded, never
// counted against the run's budget. A session of the run itself always calls the ledger for it,
// so only a session whose own readable log never did is set aside; with no log to read, every
// dispatch counts, as it always has.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR, SCRIPTS_DIR, mkRun, rmDir, runScript, ledger } = require('./helpers.js');
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

const GUARD = path.join(HOOKS_DIR, 'dispatch_guard.js');

function sessionLog(root, name, commands) {
  const file = path.join(root, `${name}.jsonl`);
  const lines = commands.map((command, i) =>
    JSON.stringify({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command } }] } })
  );
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function dispatchFrom(root, session, transcript, toolInput = { subagent_type: 'general-purpose', description: 'research Flutter release notes' }) {
  return runScript(GUARD, [], {
    input: JSON.stringify({ tool_input: toolInput, cwd: root, session_id: session, ...(transcript ? { transcript_path: transcript } : {}) }),
    cwd: root,
  });
}

const statusOf = (root, runDir) => JSON.parse(ledger(root, ['status', runDir]).stdout);
const LEDGER = path.join(SCRIPTS_DIR, 'ledger.js');

function setup() {
  const { root, runDir } = mkRun({ verify: { test: 'node tests/run.js' } });
  assert.strictEqual(ledger(root, ['init', runDir, 'abc123']).status, 0);
  return { root, runDir };
}

test('an agent of a session that never touched the run is recorded, not counted', () => {
  const { root, runDir } = setup();
  try {
    const log = sessionLog(root, 'other', ['flutter --version', 'git log --oneline -5']);
    // The hooks' own notes name the run's ledger commands; the session reading one has not run them.
    fs.appendFileSync(
      log,
      '\n' +
        JSON.stringify({ type: 'attachment', attachment: { content: `ticket-loop: end it: ledger.js archive ${runDir}` } }) +
        '\n' +
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: `run node ${LEDGER} next ${runDir}` }] } })
    );
    const res = dispatchFrom(root, 'other-session', log);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /not counted against run T-1/);
    const s = statusOf(root, runDir);
    assert.strictEqual(s.dispatches, 0, 'another session spends none of this run');
    assert.strictEqual(s.open.length, 0, 'and leaves nothing open for the run to settle');
    assert.strictEqual(s.foreignDispatches, 1, 'but it is on the record');
    assert.strictEqual(dispatchFrom(root, 'other-session', log).status, 0);
    assert.strictEqual(statusOf(root, runDir).dispatches, 0, 'its next agent is not counted either: being on the record does not make it the run');
    const rec = chain.last(runDir, 'foreign-dispatch');
    assert.strictEqual(rec.payload.session, 'other-session');
    assert.strictEqual(JSON.parse(ledger(root, ['verify', runDir]).stdout).intact, true);
  } finally {
    rmDir(root);
  }
});

test('a session whose log shows a ledger call for the run is counted', () => {
  const { root, runDir } = setup();
  try {
    const log = sessionLog(root, 'own', [`node ${LEDGER} next ${runDir}`]);
    assert.strictEqual(dispatchFrom(root, 'resumed-session', log).status, 0);
    assert.strictEqual(statusOf(root, runDir).dispatches, 1);
  } finally {
    rmDir(root);
  }
});

test('with no log to read, every dispatch counts, so hiding the log buys nothing', () => {
  const { root, runDir } = setup();
  try {
    assert.strictEqual(dispatchFrom(root, 's-nolog', null).status, 0);
    assert.strictEqual(dispatchFrom(root, 's-badlog', path.join(root, 'no-such.jsonl')).status, 0);
    const s = statusOf(root, runDir);
    assert.strictEqual(s.dispatches, 2);
    assert.strictEqual(s.foreignDispatches, 0);
  } finally {
    rmDir(root);
  }
});

test('a session already in the run record is counted whatever its log shows', () => {
  const { root, runDir } = setup();
  try {
    assert.strictEqual(dispatchFrom(root, 's1', null).status, 0);
    const log = sessionLog(root, 's1', ['npm test']);
    assert.strictEqual(dispatchFrom(root, 's1', log).status, 0);
    assert.strictEqual(statusOf(root, runDir).dispatches, 2);
  } finally {
    rmDir(root);
  }
});

test('another session is not refused by the run budget it does not spend', () => {
  const { root, runDir } = setup();
  try {
    for (let i = 0; i < 25; i++) assert.strictEqual(ledger(root, ['dispatch', runDir, `implementer: C${i}`]).status, 0);
    const own = dispatchFrom(root, 'own', sessionLog(root, 'own', [`node ${LEDGER} gate ${runDir} intake`]));
    assert.strictEqual(own.status, 2, 'the run itself is still capped');
    const other = dispatchFrom(root, 'other', sessionLog(root, 'other', ['flutter test']));
    assert.strictEqual(other.status, 0, other.stderr);
  } finally {
    rmDir(root);
  }
});
