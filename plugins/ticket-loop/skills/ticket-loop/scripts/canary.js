#!/usr/bin/env node
// Proves the enforcement works on this machine by trying it: a throwaway repo with an open run,
// and one real violation fed to each hook that has to refuse it. A health check that only reads
// configuration says the plugin is installed; this says the gates close.
//
// It runs the hook scripts that ship beside this one. It cannot show that Claude Code calls them:
// that is the setup skill's own canary, a tool call the write guard has to refuse.
//
// usage: canary.js [--json]      exit 0 when every gate refused, 1 otherwise
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', '..', '..', 'hooks');
const LEDGER = path.join(__dirname, 'ledger.js');
const TIMEOUT_MS = 60000;
const BLOCKED = 2;
// Fails by its exit code on every shell: the stop gate's verdict is the command's exit code.
const RED_SUITE = 'node -e "process.exit(1)"';
const PROFILE = {
  verify: { test: RED_SUITE },
  riskPaths: ['secrets/**'],
  hooks: { stopGate: { extensions: ['.js'], mode: 'full', worktrees: 'cwd' } },
};

// The canary's own run must not be steered by the session it is called from.
function cleanEnv() {
  const env = { ...process.env, TICKET_LOOP_NOTIFY: path.join(os.tmpdir(), 'ticket-loop-canary-no-notify.json') };
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

function git(root, args) {
  return spawnSync('git', ['-C', root, '-c', 'user.name=canary', '-c', 'user.email=canary@localhost', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
}

function hook(file, payload, cwd) {
  return spawnSync(process.execPath, [file], { input: JSON.stringify(payload), encoding: 'utf8', cwd, env: cleanEnv(), timeout: TIMEOUT_MS });
}

function ledger(root, args) {
  return spawnSync(process.execPath, [LEDGER, ...args], { encoding: 'utf8', cwd: root, env: cleanEnv(), timeout: TIMEOUT_MS });
}

function firstLine(text) {
  return String(text || '').trim().split(/\r?\n/)[0] || '';
}

// Returns the repo and its run dir, or { problem } when the machine cannot stand one up.
function standUp(base) {
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify(PROFILE));
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/ticket-runs/\n.claude/hooks/state/\n');
  fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 1;\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'canary base']]) {
    const res = git(root, args);
    if (res.status !== 0) return { problem: `git ${args[0]} failed: ${firstLine(res.stderr) || (res.error && res.error.message) || `exit ${res.status}`}` };
  }
  const runDir = path.join(root, '.agents', 'ticket-runs', 'CANARY-1');
  fs.mkdirSync(runDir, { recursive: true });
  const init = ledger(root, ['init', runDir]);
  if (init.status !== 0) return { problem: `ledger.js init failed: ${firstLine(init.stderr) || `exit ${init.status}`}` };
  return { root, runDir };
}

// Each gate is given the violation it exists to refuse, and the ordinary case it must let through.
function gateChecks(root, runDir, hooks) {
  const payload = (tool, toolInput) => ({ tool_name: tool, tool_input: toolInput, cwd: root, session_id: 'canary' });
  const out = [];
  const record = (name, ok, detail, tried) => out.push({ name, ok, detail, tried });

  const frozen = hook(hooks.freeze_guard, payload('Edit', { file_path: path.join(runDir, 'done.md') }), root);
  const ordinary = hook(hooks.freeze_guard, payload('Edit', { file_path: path.join(root, 'app.js') }), root);
  const risky = hook(hooks.freeze_guard, payload('Edit', { file_path: path.join(root, 'secrets', 'key.js') }), root);
  const pushed = hook(hooks.freeze_guard, payload('Bash', { command: 'git push origin main' }), root);
  record(
    'write guard',
    frozen.status === BLOCKED && risky.status === BLOCKED && pushed.status === BLOCKED && ordinary.status === 0,
    `frozen contract exit ${frozen.status}, risk path exit ${risky.status}, git push exit ${pushed.status} (each should be ${BLOCKED}); an ordinary edit exit ${ordinary.status} (should be 0)`,
    'an edit to a frozen contract, an edit under a risk path and a git push were each refused, and an ordinary edit was let through'
  );

  const dispatched = hook(hooks.dispatch_guard, payload('Agent', { subagent_type: 'general-purpose', description: 'canary', prompt: 'canary dispatch' }), root);
  let counted = null;
  try {
    counted = JSON.parse(ledger(root, ['status', runDir]).stdout).dispatches;
  } catch {
    counted = null;
  }
  record('dispatch count', dispatched.status === 0 && counted === 1, `a dispatch exit ${dispatched.status} (should be 0), counted in the sealed chain: ${counted} (should be 1)`, 'a dispatch was counted in the sealed record');

  fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 2;\n');
  const stop = hook(hooks.stop_gate, { cwd: root, session_id: 'canary', hook_event_name: 'Stop' }, root);
  record('stop gate', stop.status === BLOCKED, `a "done" claim over a red suite exit ${stop.status} (should be ${BLOCKED})${stop.status === BLOCKED ? '' : `: ${firstLine(stop.stderr)}`}`, 'a "done" claim over a failing suite was blocked');
  return out;
}

// opts.hooks replaces a hook's path, so a test can stand in a hook that refuses nothing.
function runCanary(opts = {}) {
  const hooks = { freeze_guard: path.join(HOOKS_DIR, 'freeze_guard.js'), dispatch_guard: path.join(HOOKS_DIR, 'dispatch_guard.js'), stop_gate: path.join(HOOKS_DIR, 'stop_gate.js'), ...(opts.hooks || {}) };
  const missing = Object.entries(hooks).filter(([, file]) => !fs.existsSync(file)).map(([name]) => name);
  if (missing.length) return { ran: false, checks: [], problem: `the hooks are not beside this script (${missing.join(', ')} missing), so nothing could be tried` };

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-loop-canary-'));
  try {
    const made = standUp(base);
    if (made.problem) return { ran: false, checks: [], problem: made.problem };
    return { ran: true, checks: gateChecks(made.root, made.runDir, hooks), problem: null };
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
}

function main() {
  const result = runCanary();
  const ok = result.ran && result.checks.every((c) => c.ok);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ ...result, ok }, null, 2) + '\n');
  } else {
    if (result.problem) console.log(`ticket-loop canary: could not run — ${result.problem}`);
    for (const c of result.checks) console.log(`  ${c.ok ? 'held' : 'DID NOT HOLD'}: ${c.name} — ${c.detail}`);
    console.log(ok ? '  ok: every gate refused its violation' : '  NOT ready: a gate let its violation through');
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { runCanary };
