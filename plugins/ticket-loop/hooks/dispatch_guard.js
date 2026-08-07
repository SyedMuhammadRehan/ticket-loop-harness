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

// The filled prompt is visible here and nowhere else: the skill's own bookkeeping call sees
// only a label, and the subagent's result says nothing about what it was handed. Characters,
// not tokens — nothing outside the model can count those.
function promptCharsOf(toolInput) {
  return ['prompt', 'description'].reduce(
    (n, k) => n + (typeof toolInput[k] === 'string' ? toolInput[k].length : 0),
    0
  );
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
  // Past this point a run IS active (checked above), so "I cannot enforce" must not mean
  // "carry on". Failing open here would make hiding ledger.js a one-command way to buy
  // unlimited dispatches. Outside a run this hook has already returned, so nobody who is not
  // running a ticket can be blocked by it.
  if (!ledger) {
    console.error(
      'BLOCKED: a ticket run is active but ledger.js cannot be found, so the dispatch budget ' +
        'cannot be enforced.\n' +
        '  Fix the install (plugin root / .claude/skills/ticket-loop/scripts/), or close the ' +
        'run with "ledger.js close" if it is finished.'
    );
    process.exit(2);
  }

  const protocol = ledgerProtocol(ledger, root);
  if (protocol === null || protocol < REQUIRED_LEDGER_PROTOCOL) {
    console.error(
      `BLOCKED: ${ledger} is too old (protocol ${protocol === null ? 'absent' : protocol}, ` +
        `need >= ${REQUIRED_LEDGER_PROTOCOL}), so the dispatch budget cannot be enforced.\n` +
        `  The hook and the scripts are out of step, usually a stale plugin cache. Reinstall or ` +
        `update the plugin so both come from the same version. Calling it anyway would write ` +
        `pre-chain state and make the run's counters untrustworthy.`
    );
    process.exit(2);
  }

  const toolInput = input.tool_input || {};
  const res = spawnSync(
    process.execPath,
    [
      ledger, 'dispatch', runDir, labelFor(toolInput),
      '--source', 'hook',
      '--prompt-chars', String(promptCharsOf(toolInput)),
    ],
    { encoding: 'utf8', cwd: root, timeout: LEDGER_TIMEOUT_MS }
  );

  // Success is the ONLY outcome that permits the dispatch. Enumerating the refusal codes
  // instead (2 = cap, 4 = broken chain) fails open on every other one — a usage error, an
  // unwritable chain, a future exit code — and "the budget could not be recorded" would then
  // mean "proceed unbudgeted", which is the hole this hook exists to close.
  if (res.error) {
    console.error(
      `BLOCKED: the dispatch budget could not be recorded (${res.error.message}).\n` +
        `  A run is active, so this dispatch is refused rather than run uncounted. Fix the ` +
        `environment, or close the run with "ledger.js close" if it is finished.`
    );
    process.exit(2);
  }
  if (res.status !== 0) {
    const detail = (res.stderr || '').trim() || `ledger.js exited ${res.status}`;
    console.error(
      `BLOCKED: ${detail}\n` +
        `  This dispatch was refused by the budget, not by a suggestion. Go to Stage 7 and ` +
        `report status INCOMPLETE with the work that was finished.`
    );
    process.exit(2);
  }

  process.exit(0);
}

if (require.main === module) main();
module.exports = { activeRuns, findLedger, labelFor, ledgerProtocol, REQUIRED_LEDGER_PROTOCOL };
