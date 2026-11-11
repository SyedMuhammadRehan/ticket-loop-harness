// Where a run stands and which stage file to read next, worked out from the sealed chain alone.
// The playbook is one file per stage so the orchestrator holds one stage at a time; what stage
// that is must not depend on its memory of the run, which a long session compacts away.
'use strict';
const fs = require('fs');
const path = require('path');
const chain = require('./chain.js');

const SKILL_DIR = path.join(__dirname, '..');
const STAGES_DIR = path.join(SKILL_DIR, 'stages');
const STAGE_FILES = {
  0: '00-preflight.md',
  1: '01-intake.md',
  2: '02-fast-track-check.md',
  3: '03-survey.md',
  4: '04-design.md',
  5: '05-approach.md',
  6: '06-define-done.md',
  7: '07-implement.md',
  8: '08-verify.md',
  9: '09-adversarial-qa.md',
  10: '10-failure-loop.md',
  11: '11-report-and-close.md',
};
// Stages a run may pass over, each only with a sealed reason.
const SKIPPABLE = { survey: 3, design: 4, approach: 5 };
const BLOCK = 'BLOCK';

function step(stage, why, also = []) {
  return { stage, why, read: [stage, ...also].map((n) => path.join(STAGES_DIR, STAGE_FILES[n])) };
}

// The first thing the chain does not yet show as done, in the order a run does them.
function decide(state) {
  const { gates, skipped, criteria, verdict, verdictAfterLastCheck } = state;
  const has = (g) => gates.includes(g);
  if (!has('intake')) return step(1, 'the ticket brief is not gated yet; decide fast-track before the gate', [2]);
  for (const [name, n] of Object.entries(SKIPPABLE)) {
    if (!has(name) && !skipped.includes(name)) return step(n, `${name} has neither a gate nor a sealed skip`);
  }
  if (!has('freeze') || !has('validate')) return step(6, 'the done-list is not validated, frozen and gated yet');

  const failing = criteria.filter((c) => c.result === 'FAIL');
  const unchecked = criteria.filter((c) => c.result === 'unchecked');
  if (!has('verify')) {
    if (failing.length) return step(10, `${failing.map((c) => c.id).join(', ')} last recorded FAIL`, [8]);
    if (unchecked.length === criteria.length) return step(7, 'no criterion has a result yet', [8]);
    if (unchecked.length) return step(8, `${unchecked.map((c) => c.id).join(', ')} still unchecked`, [7]);
    return step(8, 'every criterion has a result; commit and record the verify gate');
  }
  if (failing.length) return step(10, `${failing.map((c) => c.id).join(', ')} last recorded FAIL after the verify gate`, [8]);
  if (!verdict) return step(9, 'no QA verdict is sealed yet');
  if (verdict === BLOCK) {
    return verdictAfterLastCheck
      ? step(10, 'the QA verdict is BLOCK and nothing has been re-checked since', [9])
      : step(9, 'the QA verdict was BLOCK and criteria were re-checked after it; dispatch the next judge');
  }
  if (!has('qa')) return step(9, `the verdict is ${verdict}; record the qa gate`);
  if (!has('report')) return step(11, 'the report is not written and gated yet');
  return step(11, 'the report is gated; close the run');
}

const FIRST_WORKTREE_STAGE = 7;
const DEFAULT_WORKTREE_PREFIX = '../ticket-';

// <repo>/<worktreePrefix><TICKET>, the repo being the directory that holds the run's `.agents`.
function worktreeOf(runDir, ledger) {
  const abs = path.resolve(runDir);
  const repo = path.resolve(abs, '..', '..', '..');
  const prefix = ledger.readConfig(runDir).worktreePrefix || DEFAULT_WORKTREE_PREFIX;
  return path.resolve(repo, `${prefix}${path.basename(abs)}`);
}

function nextStep(runDir, ledger) {
  const ticket = path.basename(path.resolve(runDir));
  const base = { ticket, runDir: path.resolve(runDir), skillDir: SKILL_DIR, scriptsDir: __dirname };
  if (!chain.exists(runDir)) {
    return { ...base, ...step(0, 'no run has been started for this ticket'), state: 'not started' };
  }
  if (ledger.isClosed(runDir)) {
    return { ...base, stage: null, why: 'the run is closed; a new pass is "ledger.js archive" then "init --restart"', read: [], state: 'closed' };
  }
  const c = ledger.counters(runDir);
  const done = ledger.completeness(runDir);
  const records = chain.records(runDir);
  const lastOf = (kind) => records.filter((r) => r.kind === kind).pop();
  const lastVerdict = lastOf('verdict');
  const lastCheck = lastOf('check');
  const decided = decide({
    gates: c.gates,
    skipped: chain.ofKind(runDir, 'skip').map((r) => r.payload.stage),
    criteria: done.criteria,
    verdict: c.verdict,
    verdictAfterLastCheck: !!lastVerdict && (!lastCheck || lastVerdict.seq > lastCheck.seq),
  });
  // Work from Stage 7 on happens in the ticket worktree; a dry run stops before making one.
  const worktree = worktreeOf(runDir, ledger);
  const needsWorktree = decided.stage >= FIRST_WORKTREE_STAGE && !fs.existsSync(worktree);
  if (needsWorktree) {
    decided.read.unshift(path.join(STAGES_DIR, STAGE_FILES[0]));
    decided.why += `; the worktree ${worktree} does not exist yet, so create it first (Stage 0, step 4)`;
  }
  const limits = [];
  if (c.dispatches >= c.maxDispatches) limits.push('the dispatch budget is spent: go to Stage 11 as INCOMPLETE');
  if (c.maxRunTokens !== null && c.tokensUsed >= c.maxRunTokens) limits.push('the token ceiling is reached: only a raise the person agrees to lifts it');
  return {
    ...base,
    ...decided,
    state: 'open',
    worktree,
    gates: c.gates,
    skipped: chain.ofKind(runDir, 'skip').map((r) => `${r.payload.stage} (${r.payload.reason})`),
    criteria: done.criteria.map((x) => `${x.id} ${x.result}`),
    verdict: c.verdict,
    dispatches: `${c.dispatches}/${c.maxDispatches}`,
    open: c.open.length,
    stalled: c.stalled,
    limits,
  };
}

const STAGE_NAMES = Object.fromEntries(
  Object.entries(STAGE_FILES).map(([n, file]) => [n, file.replace(/^\d+-|\.md$/g, '').replace(/-/g, ' ').toUpperCase()])
);

function render(s) {
  const lines = [];
  lines.push(s.stage === null ? `run ${s.ticket}: CLOSED` : `run ${s.ticket}: Stage ${s.stage} — ${STAGE_NAMES[s.stage]}`);
  lines.push(`why: ${s.why}`);
  for (const file of s.read) lines.push(`read: ${file}`);
  if (s.state === 'open') {
    lines.push(`gated: ${s.gates.join(', ') || 'nothing yet'}${s.skipped.length ? ` · skipped: ${s.skipped.join('; ')}` : ''}`);
    if (s.criteria.length) lines.push(`criteria: ${s.criteria.join(', ')}`);
    lines.push(`verdict: ${s.verdict || 'none'} · dispatches ${s.dispatches}, ${s.open} still out${s.stalled ? `, ${s.stalled} STALLED` : ''}`);
    for (const l of s.limits) lines.push(`LIMIT: ${l}`);
    lines.push(`<runDir> is ${s.runDir} · <wt> is ${s.worktree}`);
  }
  lines.push(`<SKILL_DIR> is ${s.skillDir}`);
  return lines.join('\n') + '\n';
}

function stageFilesMissing() {
  return Object.values(STAGE_FILES).filter((f) => !fs.existsSync(path.join(STAGES_DIR, f)));
}

module.exports = { nextStep, render, decide, STAGE_FILES, SKIPPABLE, stageFilesMissing };
