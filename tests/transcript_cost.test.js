'use strict';
// What a run cost, from Claude Code's own session logs: every model call of the run's sessions
// inside the run's window, each counted once, the main session apart from its agents.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkTmpDir, rmDir, mkRun, ledger, runScript } = require('./helpers.js');
const { usageOf } = require(path.join(SCRIPTS_DIR, 'transcript_cost.js'));

const SESSION = '11111111-2222-3333-4444-555555555555';
const WINDOW = { from: '2026-11-17T10:00:00.000Z', to: '2026-11-17T11:00:00.000Z' };

// One reply is logged as one line per content block, all carrying the reply's usage.
function reply(id, at, usage) {
  return ['thinking', 'text', 'tool_use'].map((block) =>
    JSON.stringify({ type: 'assistant', timestamp: at, message: { id, content: [{ type: block }], usage } })
  );
}
const usage = (context, output) => ({ input_tokens: 2, cache_read_input_tokens: context - 2, cache_creation_input_tokens: 0, output_tokens: output });

function logs() {
  const dir = mkTmpDir('tl-cost');
  const project = path.join(dir, 'projects', 'C--some-repo');
  fs.mkdirSync(path.join(project, SESSION, 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(project, `${SESSION}.jsonl`),
    [
      ...reply('msg_before', '2026-11-17T09:59:59.000Z', usage(900000, 900)),
      ...reply('msg_a', '2026-11-17T10:05:00.000Z', usage(500000, 100)),
      JSON.stringify({ type: 'user', timestamp: '2026-11-17T10:06:00.000Z', message: { content: 'go on' } }),
      'not json at all',
      ...reply('msg_b', '2026-11-17T10:30:00.000Z', usage(700000, 300)),
      ...reply('msg_after', '2026-11-17T11:00:01.000Z', usage(900000, 900)),
    ].join('\n')
  );
  fs.writeFileSync(path.join(project, SESSION, 'subagents', 'agent-x.jsonl'), reply('msg_agent', '2026-11-17T10:10:00.000Z', usage(40000, 50)).join('\n'));
  return dir;
}

test('each model call in the window is counted once, the main session apart from its agents', () => {
  const dir = logs();
  try {
    const u = usageOf([SESSION], WINDOW, dir);
    assert.deepStrictEqual(u.missing, []);
    assert.strictEqual(u.main.calls, 2, 'three log lines of one reply are one call, and calls outside the window are not this run');
    assert.strictEqual(u.main.output, 400);
    assert.strictEqual(u.main.contextAvg, 600000);
    assert.strictEqual(u.main.contextMax, 700000);
    assert.strictEqual(u.main.total, 500000 + 700000 + 400);
    assert.strictEqual(u.agents.calls, 1);
    assert.strictEqual(u.agents.total, 40050);
  } finally {
    rmDir(dir);
  }
});

test('ledger cost reports the run sessions from their logs, inside the run window', () => {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  const config = mkTmpDir('tl-cost-cfg');
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
    const d = ledger(root, ['dispatch', runDir, 'implementer: C1', '--source', 'hook', '--session', SESSION]);
    assert.strictEqual(d.status, 0, d.stderr);
    const project = path.join(config, 'projects', 'C--anywhere');
    fs.mkdirSync(project, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(project, `${SESSION}.jsonl`),
      [...reply('msg_old', '2020-01-01T00:00:00.000Z', usage(900000, 9)), ...reply('msg_now', now, usage(300000, 30))].join('\n')
    );
    const res = runScript(path.join(SCRIPTS_DIR, 'ledger.js'), ['cost', runDir], { cwd: root, env: { CLAUDE_CONFIG_DIR: config } });
    assert.strictEqual(res.status, 0, res.stderr);
    const cost = JSON.parse(res.stdout);
    assert.strictEqual(cost.sessionLogs.main.calls, 1, 'a call from before the run is not the run');
    assert.strictEqual(cost.sessionLogs.main.total, 300030);
    assert.deepStrictEqual(cost.sessionLogs.missing, []);
  } finally {
    rmDir(root);
    rmDir(config);
  }
});

test('a session with no log is named, not counted as free', () => {
  const dir = logs();
  try {
    const u = usageOf(['99999999-0000-0000-0000-000000000000'], WINDOW, dir);
    assert.deepStrictEqual(u.missing, ['99999999-0000-0000-0000-000000000000']);
    assert.strictEqual(u.main.calls, 0);
  } finally {
    rmDir(dir);
  }
});

test('a session id that is not an id never becomes a path', () => {
  const dir = logs();
  try {
    const escape = `..${path.sep}..${path.sep}outside`;
    fs.writeFileSync(path.join(dir, 'outside.jsonl'), reply('msg_outside', '2026-11-17T10:20:00.000Z', usage(100, 1)).join('\n'));
    const u = usageOf([escape, SESSION], WINDOW, dir);
    assert.deepStrictEqual(u.missing, [escape]);
    assert.strictEqual(u.main.calls, 2, 'the file the id points at, outside the logs, was not read');
  } finally {
    rmDir(dir);
  }
});
