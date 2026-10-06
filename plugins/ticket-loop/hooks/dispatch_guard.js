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
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./hook_lib.js');

const { activeRuns, findLedger } = lib;
const LEDGER_TIMEOUT_MS = 15000;
// The ledger must be new enough to keep counters in the sealed chain. An older one accepts
// `dispatch` happily, writes pre-chain state, and leaves the cap unenforced — so probe first
// and refuse to call it, rather than corrupting the mirror and reporting a budget that isn't.
const REQUIRED_LEDGER_PROTOCOL = 2;

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

// Earlier dispatches gone quiet past the stall threshold, named at the next dispatch. One still
// working is not news, and telling the orchestrator to record an outcome for it would push it to
// record one before the result exists.
function unresolvedContext(status, runDir) {
  const unresolved = status.open.filter((o) => o.stalled);
  if (unresolved.length === 0) return null;
  return (
    `ticket-loop: ${unresolved.length} earlier dispatch(es) have gone quiet with no outcome:\n` +
    unresolved.map((o) => `  - ${lib.describeOpenDispatch(o)}`).join('\n') +
    `\n  If one is dead, record it: "ledger.js outcome ${runDir} <seq> died [note]". Close refuses while any is open.`
  );
}

// A filled prompt keeps none of its template's {PLACEHOLDERS}; one left in hands the subagent a
// literal it cannot resolve, and nothing downstream notices.
const UNFILLED = /\{[A-Z][A-Z0-9_]{2,}\}/g;
function unfilledPlaceholders(toolInput) {
  const text = ['prompt', 'description'].map((k) => (typeof toolInput[k] === 'string' ? toolInput[k] : '')).join('\n');
  return [...new Set(text.match(UNFILLED) || [])];
}

// What the orchestrator is told alongside a permitted dispatch: unresolved earlier dispatches,
// and a run it did not start. Neither blocks — a resumed run is a new session by design.
// The playbook's three strikes for QA_BLOCK, held here: a fourth judge is a loop nobody is
// steering, and only a person can say whether the contract or the work is wrong.
const MAX_QA_BLOCKS = 3;
const SOFT_CEILING = 0.8;
const BLOCK_NOTIFY_MS = 30 * 60 * 1000;

function isJudge(toolInput) {
  return /ticket-loop-qa/.test(String(toolInput.subagent_type || toolInput.agentType || ''));
}

// A refusal this dispatch must not pass, or null.
function budgetRefusal(status, toolInput, runDir) {
  if (isJudge(toolInput) && status.blockVerdicts >= MAX_QA_BLOCKS) {
    return {
      key: `qa-cap:${runDir}`,
      text:
        `${status.blockVerdicts} QA verdicts in this run were BLOCK; a ${MAX_QA_BLOCKS + 1}th judge is refused. ` +
        `Stop and ask the person whether the contract or the work is wrong (Stage 10 escalation).`,
    };
  }
  if (status.maxRunTokens && status.tokensUsed >= status.maxRunTokens) {
    return {
      key: `ceiling:${runDir}`,
      text:
        `the run has used ${status.tokensUsed} of its ${status.maxRunTokens}-token ceiling; no further dispatch. ` +
        `Go to Stage 11 as INCOMPLETE, or, on the person's word, "ledger.js raise ${runDir} --tokens <n> \"<reason>\"".`,
    };
  }
  return null;
}

function dispatchContext(status, runDir, sessionId, staleHours) {
  if (!status) return null;
  const notes = [unresolvedContext(status, runDir)];
  if (status.maxRunTokens && status.tokensUsed >= status.maxRunTokens * SOFT_CEILING) {
    notes.push(`ticket-loop: ${status.tokensUsed} of the run's ${status.maxRunTokens}-token ceiling is spent; plan the remaining work to fit it.`);
  }
  const foreign = lib.foreignRunNote(status, sessionId, runDir, staleHours);
  if (foreign) notes.push(`ticket-loop: this dispatch is counted against ${foreign}`);
  const text = notes.filter(Boolean).join('\n');
  return text || null;
}

async function main() {
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

  const unfilled = unfilledPlaceholders(input.tool_input || {});
  if (unfilled.length) {
    console.error(
      `BLOCKED: the dispatch prompt still holds template placeholder(s) ${unfilled.join(', ')}.\n` +
        `  Fill every one from the playbook's fill list before dispatching; this dispatch was not counted.`
    );
    process.exit(2);
  }

  const { config } = lib.loadConfig(root);
  const toolInput = input.tool_input || {};
  const { status } = lib.runStatus(ledger, runDir, root, LEDGER_TIMEOUT_MS);
  const refusal = status ? budgetRefusal(status, toolInput, runDir) : null;
  if (refusal) {
    console.error(`BLOCKED: ${refusal.text}\n  This dispatch was not counted.`);
    await lib.notifyOnce(root, refusal.key, BLOCK_NOTIFY_MS, `ticket-loop ${path.basename(runDir)} in ${path.basename(root)} stopped: ${refusal.text}`);
    process.exit(2);
  }
  const context = dispatchContext(status, runDir, input.session_id, config.staleRunHours);
  const res = spawnSync(
    process.execPath,
    [
      ledger, 'dispatch', runDir, labelFor(toolInput),
      '--source', 'hook',
      '--prompt-chars', String(promptCharsOf(toolInput)),
      ...(input.session_id ? ['--session', String(input.session_id)] : []),
      ...(typeof toolInput.model === 'string' && toolInput.model.trim() ? ['--model', toolInput.model.trim()] : []),
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

  if (context) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }) + '\n'
    );
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    // A run is active past the first checks, so a crash here must not let the dispatch through.
    console.error(`BLOCKED: dispatch_guard failed (${err.message}); the dispatch was not counted.`);
    process.exit(2);
  });
}
module.exports = { activeRuns, findLedger, labelFor, ledgerProtocol, unresolvedContext, dispatchContext, unfilledPlaceholders, budgetRefusal, MAX_QA_BLOCKS, REQUIRED_LEDGER_PROTOCOL };
