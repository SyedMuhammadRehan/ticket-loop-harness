#!/usr/bin/env node
// PreToolUse hook on the subagent tool (Task|Agent): enforce the dispatch budget at the
// moment of dispatch.
//
// Counting here rather than in the skill is what makes the cap mechanical: a script that
// exits 2 when asked enforces nothing, because nothing compels the orchestrator to ask. No
// dispatch reaches the model without passing through this hook.
//
// Delegates to ledger.js rather than reimplementing the chain, so there is exactly one
// enforcement path. `--source hook` lets ledger.js de-duplicate against the skill's own
// bookkeeping call (it takes the max of the two, never the sum).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const lib = require('./hook_lib.js');

const RUNS_REL = path.join('.agents', 'ticket-runs');
const LEDGER_REL = path.join('skills', 'ticket-loop', 'scripts', 'ledger.js');
const LEDGER_TIMEOUT_MS = 15000;
// The ledger must be new enough to keep counters in the sealed chain. An older one accepts
// `dispatch` happily, writes pre-chain state, and leaves the cap unenforced — so probe first
// and refuse to call it, rather than corrupting the mirror and reporting a budget that isn't.
const REQUIRED_LEDGER_PROTOCOL = 2;

// Search the install layouts in order of specificity: plugin root, project-local skill,
// user-level skill, then relative to this hooks dir (repo checkout / manual copy).
function findLedger(root) {
  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT && path.join(process.env.CLAUDE_PLUGIN_ROOT, LEDGER_REL),
    path.join(root, '.claude', LEDGER_REL),
    path.join(os.homedir(), '.claude', LEDGER_REL),
    path.join(root, '.claude', 'skills', 'ticket-loop', 'scripts', 'ledger.js'),
    path.join(__dirname, '..', LEDGER_REL),
    path.join(__dirname, '..', 'skills', 'ticket-loop', 'scripts', 'ledger.js'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Active = initialized (budget.json) and not yet CLOSED (no closed.json, which only
// `ledger.js close` writes, and only against a sealed report receipt). Newest first, so a
// stale run dir left lying around never shadows the one in flight.
//
// Reading report.md as "the run is over" is what let an orchestrator at the cap write one
// unprotected file and carry on dispatching, uncounted.
function activeRuns(root) {
  const runsDir = path.join(root, RUNS_REL);
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.includes('._old_'))
    .map((e) => path.join(runsDir, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'budget.json')) && !fs.existsSync(path.join(dir, 'closed.json')))
    .map((dir) => ({ dir, mtime: fs.statSync(dir).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((r) => r.dir);
}

// Returns the script's protocol number, or null when it is too old to have one.
function ledgerProtocol(ledger, cwd) {
  const res = spawnSync(process.execPath, [ledger, 'protocol'], {
    encoding: 'utf8',
    cwd,
    timeout: LEDGER_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) return null;
  const n = parseInt(String(res.stdout).trim(), 10);
  return Number.isInteger(n) ? n : null;
}

function labelFor(toolInput) {
  const kind = toolInput.subagent_type || toolInput.agentType || 'agent';
  const what = toolInput.description || (typeof toolInput.prompt === 'string' ? toolInput.prompt.split('\n')[0] : '');
  return `${kind}: ${String(what).slice(0, 120)}`.trim();
}

function main() {
  const input = lib.readStdinJson();
  if (!input) process.exit(0);

  const root = lib.findRepoRoot(input.cwd || process.cwd());
  const runs = activeRuns(root);
  if (runs.length === 0) process.exit(0); // not inside a ticket run — nothing to budget

  const runDir = runs[0];
  const ledger = findLedger(root);
  if (!ledger) {
    console.error(
      'dispatch_guard: could not locate ledger.js — the dispatch budget is NOT being enforced ' +
        'for this call. Check the install (plugin root / .claude/skills/ticket-loop/scripts/).'
    );
    process.exit(0); // fail open, loudly: never wedge a session over a missing script
  }

  const protocol = ledgerProtocol(ledger, root);
  if (protocol === null || protocol < REQUIRED_LEDGER_PROTOCOL) {
    console.error(
      `dispatch_guard: ${ledger} is too old (protocol ${protocol === null ? 'absent' : protocol}, ` +
        `need >= ${REQUIRED_LEDGER_PROTOCOL}) — THE DISPATCH BUDGET IS NOT BEING ENFORCED.\n` +
        `  The hook and the scripts are out of step, usually a stale plugin cache. Reinstall/update ` +
        `the plugin so both come from the same version. Not calling it: an old ledger would write ` +
        `pre-chain state and make the run's counters untrustworthy.`
    );
    process.exit(0); // an install problem must not wedge every subagent call
  }

  const res = spawnSync(
    process.execPath,
    [ledger, 'dispatch', runDir, labelFor(input.tool_input || {}), '--source', 'hook'],
    { encoding: 'utf8', cwd: root, timeout: LEDGER_TIMEOUT_MS }
  );

  if (res.error) {
    console.error(`dispatch_guard: ledger.js failed to run (${res.error.message}) — budget NOT enforced for this call.`);
    process.exit(0);
  }

  // 2 = cap reached, 4 = receipt chain broken. Both must stop the dispatch.
  if (res.status === 2 || res.status === 4) {
    console.error(
      `BLOCKED: ${(res.stderr || '').trim()}\n` +
        `  This dispatch was refused by the budget, not by a suggestion. Go to Stage 7 and ` +
        `report status INCOMPLETE with the work that was finished.`
    );
    process.exit(2);
  }

  process.exit(0);
}

if (require.main === module) main();
module.exports = { activeRuns, findLedger, labelFor, ledgerProtocol, REQUIRED_LEDGER_PROTOCOL };
