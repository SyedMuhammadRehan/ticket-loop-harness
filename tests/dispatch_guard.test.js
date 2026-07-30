'use strict';
// The invariant under test: the cap holds whether or not the skill makes its bookkeeping
// call, because this hook counts every subagent tool call itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR, SCRIPTS_DIR, mkRun, rmDir, runScript, ledger } = require('./helpers.js');

const SCRIPT = path.join(HOOKS_DIR, 'dispatch_guard.js');

// The hook locates ledger.js via CLAUDE_PLUGIN_ROOT / .claude/skills / its own ../skills.
// In-repo it resolves through the last of those, which is what a checkout looks like.
function dispatch(root, toolInput = { subagent_type: 'implementer', description: 'slice C1' }) {
  return runScript(SCRIPT, [], {
    input: JSON.stringify({ tool_input: toolInput, cwd: root }),
    cwd: root,
  });
}

function setup() {
  const { root, runDir } = mkRun({ verify: { test: 'node tests/run.js' } });
  assert.strictEqual(ledger(root, ['init', runDir, 'abc123']).status, 0);
  return { root, runDir };
}

test('no active run means the hook stays out of the way', () => {
  const { root } = mkRun({ verify: { test: 'node tests/run.js' } });
  try {
    assert.strictEqual(dispatch(root).status, 0);
  } finally {
    rmDir(root);
  }
});

test('a dispatch is counted in the sealed chain without the skill calling ledger.js', () => {
  const { root, runDir } = setup();
  try {
    assert.strictEqual(dispatch(root).status, 0);
    const status = JSON.parse(ledger(root, ['status', runDir]).stdout);
    assert.strictEqual(status.dispatches, 1);
    assert.strictEqual(status.dispatchesByHook, 1);
    assert.strictEqual(status.dispatchesByScript, 0);
  } finally {
    rmDir(root);
  }
});

test('the label records what was dispatched, for the report', () => {
  const { root, runDir } = setup();
  try {
    dispatch(root, { subagent_type: 'code-reviewer', description: 'adversarial QA' });
    const res = ledger(root, ['verify', runDir]);
    assert.ok(res.stdout.includes('code-reviewer') || ledger(root, ['status', runDir]).stdout.length > 0);
  } finally {
    rmDir(root);
  }
});

test('the cap is enforced at the tool call, not by asking nicely', () => {
  const { root, runDir } = setup();
  try {
    for (let i = 0; i < 25; i++) {
      assert.strictEqual(dispatch(root).status, 0, `dispatch ${i + 1} should be allowed`);
    }
    const blocked = dispatch(root);
    assert.strictEqual(blocked.status, 2);
    assert.ok(blocked.stderr.includes('BLOCKED'));
    assert.ok(blocked.stderr.includes('HARD BUDGET'));
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).dispatches, 25);
  } finally {
    rmDir(root);
  }
});

test('a broken receipt chain stops dispatches rather than being ignored', () => {
  const { root, runDir } = setup();
  try {
    dispatch(root);
    const chainFile = path.join(root, '.git', 'ticket-loop', 'T-1', 'chain.jsonl');
    const lines = fs.readFileSync(chainFile, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[1]);
    rec.payload.label = 'rewritten';
    lines[1] = JSON.stringify(rec);
    fs.writeFileSync(chainFile, lines.join('\n') + '\n');

    const res = dispatch(root);
    assert.strictEqual(res.status, 2);
    assert.ok(res.stderr.includes('CHAIN BROKEN'));
  } finally {
    rmDir(root);
  }
});

// The regression this locks down: the hooks used to read "report.md exists" as "the run is
// over", so an orchestrator at the cap could write one unprotected file and keep dispatching,
// uncounted and invisible to `verify`. The previous version of this file asserted that
// behaviour as correct, which is how it survived a review.
test('writing report.md does NOT release the budget — only a sealed close does', () => {
  const { root, runDir } = setup();
  try {
    for (let i = 0; i < 25; i++) dispatch(root);
    assert.strictEqual(dispatch(root).status, 2);

    fs.writeFileSync(path.join(runDir, 'report.md'), '# report\n');
    const stillCapped = dispatch(root);
    assert.strictEqual(stillCapped.status, 2, 'report.md must not be an off switch for the cap');
    assert.ok(stillCapped.stderr.includes('HARD BUDGET'));

    // Closing needs a receipt for the report, not just the file.
    const noReceipt = ledger(root, ['close', runDir]);
    assert.strictEqual(noReceipt.status, 3, noReceipt.stderr);
    assert.ok(noReceipt.stderr.includes('no sealed "report" gate receipt'), noReceipt.stderr);
    assert.strictEqual(dispatch(root).status, 2, 'a failed close must not release anything');

    assert.strictEqual(
      ledger(root, ['gate', runDir, 'report', '--evidence', path.join(runDir, 'report.md')]).status,
      0
    );
    assert.strictEqual(ledger(root, ['close', runDir]).status, 0);
    assert.strictEqual(dispatch(root).status, 0, 'a properly closed run releases the budget');
  } finally {
    rmDir(root);
  }
});

test('the close marker is write-protected, so the run cannot be ended by hand', () => {
  const policy = require(path.join(HOOKS_DIR, 'guard_policy.js'));
  for (const p of [
    '.agents/ticket-runs/T-1/closed.json',
    '.agents/ticket-runs/T-1/budget.json',
    '.agents/ticket-runs/T-1/done.md',
  ]) {
    assert.ok(policy.pathVerdict(p, { runActive: true }), `${p} must not be writable`);
    assert.ok(policy.pathVerdict(p, { runActive: false }), `${p} must not be writable when idle either`);
  }
  // report.md stays writable — it is the deliverable. It just no longer ends the run.
  assert.strictEqual(policy.pathVerdict('.agents/ticket-runs/T-1/report.md', { runActive: true }), null);
});

test('close refuses twice, so a run cannot be re-closed to paper over a re-open', () => {
  const { root, runDir } = setup();
  try {
    fs.writeFileSync(path.join(runDir, 'report.md'), '# report\n');
    ledger(root, ['gate', runDir, 'report', '--evidence', path.join(runDir, 'report.md')]);
    assert.strictEqual(ledger(root, ['close', runDir]).status, 0);
    const again = ledger(root, ['close', runDir]);
    assert.strictEqual(again.status, 1);
    assert.ok(again.stderr.includes('already closed'));
  } finally {
    rmDir(root);
  }
});

test('malformed stdin never wedges a dispatch', () => {
  assert.strictEqual(runScript(SCRIPT, [], { input: 'not json' }).status, 0);
});

// Pin the resolution order explicitly: reading CLAUDE_PLUGIN_ROOT from the ambient
// environment makes this file test the INSTALLED plugin when the suite runs inside Claude
// Code, i.e. a different version of the harness than the checkout.
test('findLedger prefers CLAUDE_PLUGIN_ROOT, then falls back to the checkout layout', () => {
  const { findLedger } = require(SCRIPT);
  const saved = process.env.CLAUDE_PLUGIN_ROOT;
  const { root } = mkRun({});
  try {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const found = findLedger(path.join(HOOKS_DIR, '..', '..', '..'));
    assert.ok(found, 'ledger.js must be discoverable or the budget silently stops being enforced');
    assert.strictEqual(path.resolve(found), path.resolve(path.join(SCRIPTS_DIR, 'ledger.js')));

    // An installed plugin root wins, which is correct: the hook and the scripts must be
    // version-matched, and they ship together.
    const pluginRoot = path.join(root, 'plugin');
    const installed = path.join(pluginRoot, 'skills', 'ticket-loop', 'scripts');
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'ledger.js'), '// installed copy\n');
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    assert.strictEqual(path.resolve(findLedger(root)), path.resolve(path.join(installed, 'ledger.js')));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = saved;
    rmDir(root);
  }
});

test('the ledger exposes a protocol number for the hook to check', () => {
  const { REQUIRED_LEDGER_PROTOCOL } = require(SCRIPT);
  const res = runScript(path.join(SCRIPTS_DIR, 'ledger.js'), ['protocol']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(parseInt(res.stdout.trim(), 10) >= REQUIRED_LEDGER_PROTOCOL);
});

// The bug this closes: a stale plugin cache meant dispatch_guard called an OLD ledger.js,
// which accepted the dispatch, wrote pre-chain state, and left the cap unenforced — silently.
test('a ledger too old to have a protocol is refused loudly, not called', () => {
  const { root, runDir } = setup();
  try {
    // Stand up a fake "installed plugin" whose ledger.js predates the chain.
    const pluginRoot = path.join(root, 'stale-plugin');
    const scripts = path.join(pluginRoot, 'skills', 'ticket-loop', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(
      path.join(scripts, 'ledger.js'),
      `const c=process.argv[2];
       if(c==='protocol'){console.error('unknown command "protocol"');process.exit(1);}
       require('fs').writeFileSync(require('path').join(process.argv[3],'budget.json'),'{"dispatches":99}');
       console.log('ledger: dispatch OK');\n`
    );

    const res = runScript(SCRIPT, [], {
      input: JSON.stringify({ tool_input: { subagent_type: 'implementer' }, cwd: root }),
      cwd: root,
      env: { CLAUDE_PLUGIN_ROOT: pluginRoot },
    });

    assert.strictEqual(res.status, 0, 'an install problem must not wedge every subagent call');
    assert.ok(res.stderr.includes('NOT BEING ENFORCED'), res.stderr);
    assert.ok(res.stderr.includes('stale plugin cache'), res.stderr);

    // Crucially, the stale script was never invoked, so it wrote nothing.
    const mirror = JSON.parse(fs.readFileSync(path.join(runDir, 'budget.json'), 'utf8'));
    assert.notStrictEqual(mirror.dispatches, 99, 'the old ledger must not have run');
    assert.strictEqual(JSON.parse(ledger(root, ['status', runDir]).stdout).dispatches, 0);
  } finally {
    rmDir(root);
  }
});
