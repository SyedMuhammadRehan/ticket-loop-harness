'use strict';
// The invariant under test: a session opening in a repo with an open run or a stale pre-plugin
// hook copy is told so before anything is refused, and a clean repo hears nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR, mkRun, mkFakeRepo, mkTmpDir, rmDir, runScript, ledger } = require('./helpers.js');
const { HARNESS_HOOK_FILES } = require(path.join(HOOKS_DIR, 'hook_lib.js'));

const SCRIPT = path.join(HOOKS_DIR, 'session_start.js');

function start(root, home, extra = {}) {
  return runScript(SCRIPT, [], {
    cwd: root,
    input: JSON.stringify({ cwd: root, hook_event_name: 'SessionStart', source: 'startup', ...extra }),
    env: { HOME: home, USERPROFILE: home },
  });
}

test('a clean repo, and a repo with no profile at all, start silently', () => {
  const home = mkTmpDir('tl-home');
  const bare = mkTmpDir('tl-bare');
  const repo = mkFakeRepo({ verify: { test: 'x' } });
  try {
    for (const root of [bare, repo]) {
      const res = start(root, home);
      assert.strictEqual(res.status, 0, res.stderr);
      assert.strictEqual(res.stdout.trim(), '', `nothing to say in ${root}`);
    }
  } finally {
    rmDir(home);
    rmDir(bare);
    rmDir(repo);
  }
});

test('an open run started by another session is named at session start with how to end it', () => {
  const home = mkTmpDir('tl-home');
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  try {
    assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
    assert.strictEqual(ledger(root, ['dispatch', runDir, 'implementer: C1', '--session', 's1']).status, 0);
    const res = start(root, home, { session_id: 's2' });
    assert.strictEqual(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.match(out.systemMessage, /1 open ticket run/);
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(/another session/.test(out.hookSpecificOutput.additionalContext) && /archive/.test(out.hookSpecificOutput.additionalContext), out.hookSpecificOutput.additionalContext);
  } finally {
    rmDir(home);
    rmDir(root);
  }
});

test('a pre-plugin hook copy and the settings entry that runs it are named at session start', () => {
  const home = mkTmpDir('tl-home');
  const root = mkFakeRepo({ verify: { test: 'x' } });
  try {
    fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'hooks', 'stop_gate.js'), '');
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: [] },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/stop_gate.js' }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'node "C:/u/.claude/plugins/cache/x/hooks/freeze_guard.js"' }, { type: 'command', command: 'node lint.js' }] }],
        },
      })
    );
    const res = start(root, home);
    assert.strictEqual(res.status, 0, res.stderr);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('stop_gate.js (delete it'), ctx);
    assert.ok(ctx.includes('settings.local.json: node .claude/hooks/stop_gate.js'), ctx);
    assert.ok(!ctx.includes('plugins/cache') && !ctx.includes('lint.js'), 'the plugin itself and unrelated hooks are not stale copies');
  } finally {
    rmDir(home);
    rmDir(root);
  }
});

test('malformed input exits 0 and says nothing', () => {
  const home = mkTmpDir('tl-home');
  try {
    const res = runScript(SCRIPT, [], { input: '{ nope', env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout.trim(), '');
  } finally {
    rmDir(home);
  }
});

// The stale-copy list must name every hook the plugin ships, or a copy of a new one goes unseen.
test('the stale-copy list names every hook file the plugin ships', () => {
  for (const name of fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.js'))) {
    assert.ok(HARNESS_HOOK_FILES.includes(name), `${name} ships in hooks/ but a stale copy of it would not be detected`);
  }
});
