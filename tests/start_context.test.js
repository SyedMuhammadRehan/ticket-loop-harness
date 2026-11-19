'use strict';
// A run starts in a session that is not already carrying earlier work: every later call re-sends
// that context, so it is the largest cost a run can carry and adds nothing to the ticket.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR, SCRIPTS_DIR, runScript, mkRun, rmDir, ledger } = require('./helpers.js');
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

const GUARD = path.join(HOOKS_DIR, 'freeze_guard.js');

// A session log whose last main-session call carried `context` tokens; an agent's call after it
// does not count, because it is not this session's context.
function sessionLog(dir, context) {
  const file = path.join(dir, 'session.jsonl');
  const call = (id, ctx, sidechain) =>
    JSON.stringify({
      type: 'assistant',
      isSidechain: sidechain,
      timestamp: new Date().toISOString(),
      message: { id, usage: { input_tokens: 3, cache_read_input_tokens: ctx - 3, cache_creation_input_tokens: 0, output_tokens: 10 } },
    });
  fs.writeFileSync(file, [call('m1', 90000, false), call('m2', context, false), call('a1', 5000, true), 'not json'].join('\n'));
  return file;
}

function startRun(root, runDir, transcript, extraArgs = []) {
  const command = `node ${path.join(SCRIPTS_DIR, 'ledger.js')} init ${runDir} abc ${extraArgs.join(' ')}`.trim();
  return runScript(GUARD, [], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root, session_id: 's1', transcript_path: transcript }),
    cwd: root,
  });
}

test('a run does not start in a session already carrying earlier work', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    const res = startRun(root, runDir, sessionLog(root, 380000));
    assert.strictEqual(res.status, 2, res.stderr);
    assert.match(res.stderr, /already carries 380,000 tokens/);
    assert.match(res.stderr, /new session/);
  } finally {
    rmDir(root);
  }
});

test('a fresh session starts a run, and so does any other command in a full one', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    assert.strictEqual(startRun(root, runDir, sessionLog(root, 120000)).status, 0, 'a fresh session is under the limit');
    const status = `node ${path.join(SCRIPTS_DIR, 'ledger.js')} status ${runDir}`;
    const other = runScript(GUARD, [], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: status }, cwd: root, transcript_path: sessionLog(root, 900000) }),
      cwd: root,
    });
    assert.strictEqual(other.status, 0, 'only the start of a run is judged on context');
  } finally {
    rmDir(root);
  }
});

test('a missing or unreadable session log never stops a run', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    assert.strictEqual(startRun(root, runDir, path.join(root, 'no-such.jsonl')).status, 0);
    const garbage = path.join(root, 'garbage.jsonl');
    fs.writeFileSync(garbage, '{{{{ not a log');
    assert.strictEqual(startRun(root, runDir, garbage).status, 0);
    assert.strictEqual(startRun(root, runDir, undefined).status, 0);
  } finally {
    rmDir(root);
  }
});

test('the limit comes from the profile, and 0 turns the check off', () => {
  const low = mkRun({ verify: { test: 'x' }, maxStartContext: 100000 });
  const off = mkRun({ verify: { test: 'x' }, maxStartContext: 0 });
  try {
    assert.strictEqual(startRun(low.root, low.runDir, sessionLog(low.root, 120000)).status, 2);
    assert.strictEqual(startRun(off.root, off.runDir, sessionLog(off.root, 900000)).status, 0);
  } finally {
    rmDir(low.root);
    rmDir(off.root);
  }
});

test('a reason to keep the context lets the run start, and the record keeps the reason', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    const why = '"the person asked to keep the design discussion"';
    assert.strictEqual(startRun(root, runDir, sessionLog(root, 380000), ['--keep-context', why]).status, 0);
    const init = ledger(root, ['init', runDir, 'abc', '--keep-context', 'the person asked to keep the design discussion']);
    assert.strictEqual(init.status, 0, init.stderr);
    assert.strictEqual(chain.first(runDir, 'init').payload.keptContext, 'the person asked to keep the design discussion');
  } finally {
    rmDir(root);
  }
});
