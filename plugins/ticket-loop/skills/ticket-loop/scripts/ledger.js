#!/usr/bin/env node
// Mechanical budget + stage-receipt enforcement (zero deps).
//
// The counters are derived from the HMAC-sealed receipt chain in <gitdir>/ticket-loop/,
// NOT from budget.json. budget.json is a human-readable MIRROR: editing it changes
// nothing, and `verify` reports the disagreement. The caps themselves are recorded in the
// chain's init receipt, so raising them by editing a file no longer works.
//
//   ledger.js init <runDir> [baseSha] [--restart] [--off-base "<why>"]  create the chain (refuses to reset)
//   ledger.js dispatch <runDir> [label]            +1 dispatch; exit 2 at the cap
//   ledger.js replan <runDir> [reason]             +1 re-plan;  exit 2 at the cap
//   ledger.js gate <runDir> <stage> [--evidence f] record that a stage completed
//   ledger.js require <runDir> <stage>             exit 3 unless that stage was recorded
//   ledger.js check <runDir> <id> <result> --by <m> [--cwd <dir>] [--timeout-ms <n>]
//                                                  record a result AND how it was reached;
//                                                  --by command runs the criterion's frozen run:
//   ledger.js verdict <runDir> <v> [--inputs f]    record the QA verdict + what it judged
//   ledger.js close <runDir>                       end the run (needs a report receipt)
//   ledger.js archive <runDir>                     sanctioned CLEAN-RESTART move
//   ledger.js status <runDir>                      counters as JSON
//   ledger.js cost <runDir> [--worktree <path>]    what the run spent
//   ledger.js qascope <runDir> [--worktree <path>] how widely the QA judge should read
//   ledger.js qascope --base <ref> [--worktree <path>]  same, with no run behind it
//   ledger.js clear <runDir> <glob> <reason>       record a human's GATE A/C risk clearance
//   ledger.js revise <runDir> <file> --reason ".."  account for an edit to a sealed document
//   ledger.js outcome <runDir> <seq> <ok|died>     what a dispatch actually produced
//   ledger.js returned <runDir>                    the subagent tool returned (SubagentStop hook)
//   ledger.js verify <runDir>                      chain integrity + tamper report
//   ledger.js keygen                               create this machine's Ed25519 signing key
//   ledger.js approval <runDir> --question .. --choice n ..   a person's answer from a notify channel
//   ledger.js raise <runDir> --tokens <n> <reason> [--approval <seq>]  a person lifts the token ceiling
//   ledger.js consent <runDir> --push yes|no --pr yes|no --ticket yes|no "<who said so>"  per-run publish answers
//   ledger.js export <runDir> --out <file>         signed bundle of a closed run, for verify_bundle.js
//   ledger.js protocol                             compatibility probe for the hooks
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const chain = require('./chain.js');
const { importersOf } = require('./importers.js');
const attest = require('./attest.js');
const policy = require('./policy.js');
const { digestOf, FORMAT: ATTESTATION_FORMAT } = require('./verify_bundle.js');

// Bumped when the contract between the hooks and this script changes (chain-backed counters,
// --source de-duplication, the closed.json end-of-run marker). dispatch_guard refuses to trust
// an older script rather than silently writing old-format state and leaving the budget
// unenforced.
const LEDGER_PROTOCOL = 2;

const MAX_DISPATCHES = 25;
const MAX_REPLANS = 2;
const STAGES = ['intake', 'survey', 'design', 'approach', 'validate', 'freeze', 'implement', 'verify', 'qa', 'report'];
const VERDICTS = ['BLOCK', 'APPROVE_WITH_COMMENTS', 'APPROVE'];
const CHECK_RESULTS = ['PASS', 'FAIL', 'SKIPPED'];

// How a result was reached, which PASS|FAIL|SKIPPED cannot express. Without it a criterion an
// agent concluded from reading source records identically to one whose suite ran.
//   command  — a command ran and its exit code decided it
//   observed — the running system was exercised and its behaviour seen
//   human    — a person confirmed it
//   asserted — neither: concluded from source, or from another agent's summary
const CHECK_METHODS = ['command', 'observed', 'human', 'asserted'];
const DISPATCH_OUTCOMES = ['ok', 'died'];
// An unreturned dispatch older than this is reported as STALLED; dispatchPolicy.stallMinutes overrides.
const DEFAULT_STALL_MINUTES = 30;
// A phone answer backs one clearance or raise, and only while it is fresh; `approvalMinutes` in
// the profile overrides.
const DEFAULT_APPROVAL_MINUTES = 60;
// Mirrors load_config's dispatchPolicy default, for a run whose profile does not set one.
const DEFAULT_PROMPT_BUDGET = 32000;
const DEFAULT_SMALL_DIFF_LINES = 60;
// A dispatch spends at least the prompt it was handed, whatever was reported for it.
const CHARS_PER_TOKEN = 4;
const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_LINES = 40;
// Enough output for the sealed tail however long its lines run, without holding all of it.
const CHECK_OUTPUT_KEEP_CHARS = 256 * 1024;
// The judge's subagent type, as the dispatch hook records it at the head of the label.
const JUDGE_ROLE = /ticket-loop-qa/;
const PASSING_VERDICTS = ['APPROVE', 'APPROVE_WITH_COMMENTS'];
// Criteria checked by a tool rather than a shell command; validate_done exempts the same set.
const NON_COMMAND_RUNNERS = /^(playwright|browser|manual):/i;

// The riskPaths globs, matched the way the guard matches them. Kept here rather than imported
// from the hooks: scripts and hooks install to different places, and a require across that
// boundary breaks the by-hand install.
function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i++;
        if (g[i + 1] === '/') i++; // `**/` also matches zero directories
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}
const MIN_REVISION_REASON = 8;

// Files a revision receipt may never cover: the frozen contract, and control-plane state whose
// own checks in `verify` a reason string would launder. Everything else a gate seals is a
// document the playbook goes on writing.
const UNREVISABLE = [
  /(^|\/)done\.md$/,
  /\.approved\.md$/,
  // Writable on purpose (criteria may be ADDED mid-run), but the verdict seals it, so a
  // revision over it would launder a criterion removed after the judge read it.
  /(^|\/)done-additions\.md$/,
  /(^|\/)budget\.json$/,
  /(^|\/)closed\.json$/,
  /(^|\/)clearances\.json$/,
  /(^|\/)ticket-loop\.config\.json$/,
];

// What each stage must show before its receipt is recorded. Evidence cannot be optional: ten
// gates plus an APPROVE verdict would otherwise be eleven free commands, leaving `verify`
// reporting `intact: true, problems: []` over a run in which nothing happened, and
// `require <stage>` proving only that someone typed `ledger.js gate`.
//
// `artifact` = the file the stage cannot have happened without: <runDir>/<artifact>, non-empty,
// among --evidence. A file of the same name elsewhere is not this run's product. `receipt` = a
// stage whose product is another sealed record rather than a file, bound to that record instead.
// `validated` = the artifact must hash to what a validate receipt sealed.
const STAGE_PROOF = {
  intake: { artifact: 'ticket-brief.md' },
  survey: { artifact: 'codebase-map.md' },
  design: { artifact: 'design-spec.md' },
  approach: { artifact: 'approach.md' },
  validate: { receipt: 'validate', how: 'run validate_done.js against the draft — it seals the receipt' },
  freeze: { artifact: 'done.md', validated: true, how: 'freeze with freeze_done.js, which seals the draft validate_done.js accepted' },
  implement: {
    anyEvidence: true,
    how: 'seal the diff or the files the slices touched — ledger.md keeps growing after this gate, so sealing it costs a "revise" receipt per attempt',
  },
  verify: { receipt: 'check', how: 'record each criterion result with "ledger.js check" first' },
  qa: { receipt: 'verdict', how: 'the judge records its own verdict with "ledger.js verdict"' },
  report: { artifact: 'report.md' },
};

function budgetPath(runDir) {
  return path.join(runDir, 'budget.json');
}

// The end-of-run marker. The hooks treat a run as ACTIVE from `init` until this file exists,
// so it is what releases the dispatch budget and the control-plane freeze.
//
// It is deliberately NOT report.md. If the hooks read that as "the run is over", the one file
// Stage 7 tells the orchestrator to write first would also switch off the budget, unlock the
// hook sources and make the stop gate's missing-config block inert — reachable with an
// ordinary Write, uncounted, and invisible to `verify`. Ending a run is an explicit act that
// requires a report receipt in the sealed chain, and the
// marker itself is write-protected by freeze_guard.
function closedPath(runDir) {
  return path.join(runDir, 'closed.json');
}

// The marker is a file in the run dir, so deleting it must not re-open the run: the chain's own
// `close` record says so too, and either one is enough.
function isClosed(runDir) {
  return fs.existsSync(closedPath(runDir)) || !!chain.first(runDir, 'close');
}

// The repo a run belongs to is the directory holding its `.agents`, wherever the command was
// started from.
function repoRootOf(runDir) {
  let dir = path.resolve(runDir);
  for (;;) {
    if (path.basename(dir) === '.agents') return path.dirname(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

// Evidence is sealed absolute; a receipt from before that is resolved against the run's repo,
// never against the cwd of whoever is verifying.
function sealedFile(runDir, file) {
  return path.isAbsolute(String(file)) ? path.resolve(String(file)) : path.resolve(repoRootOf(runDir), String(file));
}

function caps(runDir) {
  const init = chain.first(runDir, 'init');
  const p = (init && init.payload) || {};
  return {
    maxDispatches: Number.isInteger(p.maxDispatches) ? p.maxDispatches : MAX_DISPATCHES,
    maxReplans: Number.isInteger(p.maxReplans) ? p.maxReplans : MAX_REPLANS,
    baseSha: p.baseSha || null,
  };
}

// The dispatch guard hook and this script both record dispatches. Counting the MAX of the
// two (rather than the sum) means: the hook is authoritative when installed, the script
// still enforces when it is not, and neither double-counts the other.
function dispatchCount(runDir) {
  const all = chain.ofKind(runDir, 'dispatch');
  const byHook = all.filter((r) => r.payload && r.payload.source === 'hook').length;
  const byScript = all.filter((r) => !r.payload || r.payload.source !== 'hook').length;
  return { count: Math.max(byHook, byScript), byHook, byScript };
}

// Dispatches that produced nothing. They still spent their slot, so this never reduces the
// count — it only lets the report say how much of the budget bought nothing.
function diedCount(runDir) {
  const died = new Set(
    chain.ofKind(runDir, 'outcome').filter((r) => r.payload && r.payload.outcome === 'died').map((r) => r.payload.dispatchSeq)
  );
  return dispatchPairs(runDir).filter((d) => d.seqs.some((seq) => died.has(seq))).length;
}

// Which sessions have written to this run, and when it was last touched. A run nobody in the
// current session started is still enforced, but the hooks can say whose it is.
function sessionStats(runDir) {
  const records = chain.records(runDir);
  const sessions = [...new Set(records.map((r) => r.payload && r.payload.session).filter(Boolean))];
  const lastRecordAt = records.length ? records[records.length - 1].at : null;
  const idleMinutes = lastRecordAt ? Math.max(0, Math.round((Date.now() - Date.parse(lastRecordAt)) / 60000)) : null;
  return { sessions, lastRecordAt, idleMinutes };
}

// How the run's results were reached, so a report can say "eight by command, one by a person"
// rather than nine indistinguishable passes.
function evidenceStats(runDir) {
  const out = Object.fromEntries(CHECK_METHODS.map((m) => [m, 0]));
  for (const r of chain.ofKind(runDir, 'check')) {
    const by = r.payload && r.payload.by;
    if (by in out) out[by] += 1;
  }
  return out;
}

function counters(runDir) {
  const { maxDispatches, maxReplans, baseSha } = caps(runDir);
  const d = dispatchCount(runDir);
  const open = openDispatches(runDir);
  return {
    dispatches: d.count,
    dispatchesDied: diedCount(runDir),
    open,
    stalled: open.filter((o) => o.stalled).length,
    ...sessionStats(runDir),
    replans: chain.ofKind(runDir, 'replan').length,
    maxDispatches,
    maxReplans,
    baseSha,
    dispatchesByHook: d.byHook,
    dispatchesByScript: d.byScript,
    gates: chain.ofKind(runDir, 'gate').map((r) => r.payload.stage),
    verdict: (chain.last(runDir, 'verdict') || { payload: {} }).payload.verdict || null,
    blockVerdicts: chain.ofKind(runDir, 'verdict').filter((r) => r.payload.verdict === 'BLOCK').length,
    ...tokenCeiling(runDir),
  };
}

// Reported tokens arrive only with an outcome, and an outcome need not report any, so each
// dispatch counts at least its prompt as the hook measured it. The ceiling is checked before each
// dispatch: a run can overshoot by at most what the ones in flight spend beyond their prompts.
function tokenCeiling(runDir) {
  const stats = tokenStats(runDir);
  const used = stats.counted;
  const base = Number((readConfig(runDir).dispatchPolicy || {}).maxRunTokens);
  if (!Number.isInteger(base) || base <= 0) return { tokensUsed: used, tokensFloor: stats.floor, maxRunTokens: null };
  const raised = chain.ofKind(runDir, 'raise').reduce((n, r) => n + (Number(r.payload.tokens) || 0), 0);
  return { tokensUsed: used, tokensFloor: stats.floor, maxRunTokens: base + raised };
}

// budget.json exists so a human can read the state without a tool. It is never read back.
function mirrorBudget(runDir) {
  const c = counters(runDir);
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      budgetPath(runDir),
      JSON.stringify(
        {
          '//': 'MIRROR ONLY — derived from the sealed receipt chain. Editing this file changes nothing; run "ledger.js verify" to see it reported as drift.',
          dispatches: c.dispatches,
          replans: c.replans,
          maxDispatches: c.maxDispatches,
          maxReplans: c.maxReplans,
        },
        null,
        2
      ) + '\n'
    );
  } catch {
    // A read-only mirror failing to write must not break enforcement.
  }
}

function requireChain(runDir) {
  if (!chain.exists(runDir)) {
    console.error(`ledger: no receipt chain for ${runDir} — run "ledger.js init ${runDir} <baseSha>" first.`);
    process.exit(1);
  }
  const v = chain.verify(runDir);
  if (!v.ok) {
    console.error(
      `ledger: RECEIPT CHAIN BROKEN for ${runDir}:\n- ${v.problems.join('\n- ')}\n` +
        `The run's history has been altered. Stop and escalate to a human; do not report COMPLETE.`
    );
    process.exit(4);
  }
  runPolicy(runDir);
  return v;
}

// The org policy a run is governed by is the file sealed at its init, by path as well as by
// hash: pointing TICKET_LOOP_POLICY at a missing file would otherwise lift the floor mid-run.
// A run that started under no policy has no floor to lift, so a different path is refused only
// when a policy was sealed. A run initialised before the path was sealed reads the policy the
// environment names.
function runPolicy(runDir) {
  const init = chain.first(runDir, 'init');
  const sealed = init && init.payload && init.payload.policy;
  if (!sealed || !sealed.path) return policy.readPolicy();
  const now = policy.policyPath();
  if (sealed.sha256 && path.resolve(sealed.path) !== now) {
    console.error(
      `ledger: this run's org policy was sealed at ${path.resolve(sealed.path)}, but ${policy.ENV_POLICY} now resolves to ${now}.\n` +
        `  A run is governed by the policy it started under; restore the environment, or archive and restart the run.`
    );
    process.exit(1);
  }
  return policy.readPolicy(sealed.path);
}

// `close` released the dispatch budget and the control-plane freeze against the receipts as
// they stood; collecting more afterwards leaves the report describing a different run. Reads
// and `archive` stay available.
function requireOpen(runDir, what) {
  if (!isClosed(runDir)) return;
  console.error(
    `ledger ${what}: ${runDir} is CLOSED — refusing to record anything more.\n` +
      `  Closing released the budget and the control-plane freeze against the receipts as they were; ` +
      `appending now would leave the report describing a different run.\n` +
      `  A new pass over this ticket is "ledger.js archive ${runDir}" then a fresh "init ... --restart".`
  );
  process.exit(1);
}

// A run's base is the tip of the profile's base branch. Branching from whatever the session was
// on carried a field run's unrelated commits into its ticket branch and its recorded base.
// Null when the base is right, cannot be judged (no base ref, or git cannot resolve one), or a
// person gave a reason to start elsewhere.
function baseProblem(baseSha, offBase) {
  if (offBase || !baseSha) return null;
  const ref = ((readConfig().hooks || {}).stopGate || {}).baseRef;
  if (!ref) return null;
  const tip = gitLines('.', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const given = gitLines('.', ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`]);
  if (!tip || !tip[0] || !given || !given[0]) return null;
  if (tip[0].trim() === given[0].trim()) return null;
  return (
    `base ${String(baseSha).slice(0, 12)} is not the tip of the profile's base branch ${ref} (${tip[0].trim().slice(0, 12)}).\n` +
    `  Create the worktree from it: git worktree add <wt> -b ticket/<TICKET> ${ref}\n` +
    `  If this ticket must start elsewhere, say why: --off-base "<reason>".`
  );
}

function cmdInit(runDir, baseSha, opts) {
  const wrongBase = baseProblem(baseSha, opts.offBase);
  if (wrongBase) {
    console.error(`ledger init: ${wrongBase}`);
    process.exit(1);
  }
  // The run dir is a protected namespace: the write guard refuses a plain mkdir under it, so
  // the subdirectories the playbook expects have to come from a sanctioned invocation.
  fs.mkdirSync(path.join(runDir, 'screenshots'), { recursive: true });

  // A chain that is GONE is not the same as a run that never started: without this check,
  // `rm -rf` on the chain dir followed by `init` zeroes every counter and receipt and still
  // reports `intact: true`, because the refusal below only fires when a chain is present.
  // budget.json is the one trace the chain leaves inside the run dir, and freeze_guard
  // protects it, so its presence without a chain is the signature of a deleted history.
  if (!chain.exists(runDir) && fs.existsSync(budgetPath(runDir)) && !opts.restart) {
    console.error(
      `ledger init: ${runDir} has a budget.json but NO receipt chain at ${chain.resolveChainDir(runDir).dir}.\n` +
        `  The chain was deleted, moved, or the run dir was copied from elsewhere. Initializing now would ` +
        `silently reset the counters and drop every stage receipt.\n` +
        `  If this is a deliberate clean restart: "ledger.js init ${runDir} <baseSha> --restart" — it records ` +
        `that the previous history was missing. If not, restore the chain before continuing.`
    );
    process.exit(1);
  }

  if (chain.exists(runDir) && !opts.restart) {
    const c = counters(runDir);
    console.error(
      `ledger init: a receipt chain already exists for ${runDir} — refusing to reset counters ` +
        `(${c.dispatches}/${c.maxDispatches} dispatches, ${c.replans}/${c.maxReplans} re-plans used).\n` +
        `RESUME keeps these counts. A genuine CLEAN RESTART is ` +
        `"ledger.js archive ${runDir}" then "ledger.js init ${runDir} <baseSha> --restart".`
    );
    process.exit(1);
  }

  let rotated = null;
  if (opts.restart) {
    const priorMirror = !chain.exists(runDir) && fs.existsSync(budgetPath(runDir));
    rotated = chain.rotate(runDir);
    if (!rotated) {
      chain.create(runDir);
      // A restart over a chain that is not there is worth recording as exactly that, so the
      // report cannot present it as a first run.
      if (priorMirror) rotated = { retired: 'MISSING — the previous chain directory was gone', retiredSeal: null, retiredRecords: null };
    }
  } else {
    chain.create(runDir);
  }

  // Seal the enforcement profile itself. The hooks read their parameters from this file, so
  // a mid-run edit (extensions that match nothing, a no-op verify.test, a deleted stopGate
  // block) is a way to disarm the gates. Sealing it here makes that edit show up as
  // TAMPERED in `ledger.js verify` instead of passing as "verified".
  const configRel = path.join('.agents', 'ticket-loop.config.json');
  const configSealed = fs.existsSync(configRel) ? chain.hashEvidence([configRel]) : [];
  // The org policy governs the profile, so it is sealed beside it, by path as well as content.
  const policyFile = policy.policyPath();
  const orgPolicy = policy.readPolicy(policyFile);
  if (orgPolicy && orgPolicy.error) {
    console.error(`ledger init: ${orgPolicy.error} — fix or remove it before a run starts under it.`);
    process.exit(1);
  }
  if (orgPolicy) configSealed.push(...chain.hashEvidence([orgPolicy.path]));

  const { inGit } = chain.resolveChainDir(runDir);
  chain.append(runDir, 'init', {
    baseSha: baseSha || null,
    ...(opts.offBase ? { offBase: opts.offBase } : {}),
    maxDispatches: MAX_DISPATCHES,
    maxReplans: MAX_REPLANS,
    evidence: configSealed,
    policy: { path: policyFile.replace(/\\/g, '/'), sha256: orgPolicy ? orgPolicy.sha256 : null },
    closesInChain: true,
    ...(rotated ? { restartedFrom: rotated.retired, retiredSeal: rotated.retiredSeal, retiredRecords: rotated.retiredRecords } : {}),
  });

  const ledgerFile = path.join(runDir, 'ledger.md');
  if (!fs.existsSync(ledgerFile)) {
    fs.writeFileSync(
      ledgerFile,
      `# Ledger — ${path.basename(path.resolve(runDir))}\n` +
        `base: ${baseSha || 'unknown'}\n` +
        `started: ${new Date().toISOString()}\n` +
        `counters: sealed receipt chain (ledger.js status) — budget.json is a mirror, ledger.md is a narrative\n` +
        `## Check history\n` +
        `| check | results (oldest→newest) |\n` +
        `|---|---|\n` +
        `## Attempts\n`
    );
  }
  mirrorBudget(runDir);

  if (rotated) {
    console.log(`ledger: RESTARTED ${runDir} — retired ${rotated.retired} (${rotated.retiredRecords} records, recorded in the new chain)`);
  }
  console.log(`ledger: initialized ${runDir} (budget ${MAX_DISPATCHES} dispatches / ${MAX_REPLANS} re-plans)`);
  if (configSealed.length === 0) {
    console.error(
      `ledger: WARNING — no ${configRel} to seal. The stop gate and post-edit hooks are inert ` +
        `without it, and config drift cannot be detected for this run.`
    );
  }
  if (!inGit) {
    console.error(
      `ledger: WARNING — no git dir found, so the receipt chain sits in ` +
        `${chain.resolveChainDir(runDir).dir} instead of <gitdir>/ticket-loop/. Still outside the run dir, but less protected.`
    );
  }
}

function cmdDispatch(runDir, label, opts) {
  requireChain(runDir);
  requireOpen(runDir, 'dispatch');
  const { maxDispatches } = caps(runDir);
  const promptChars = Number(opts && opts.promptChars);
  const payload = {
    label: label || null,
    source: opts && opts.source ? opts.source : 'script',
    session: (opts && opts.session) || null,
    // Only the hook sees the filled prompt, so a script-recorded dispatch leaves this null
    // rather than guessing — an invented zero would read as a free dispatch.
    promptChars: Number.isFinite(promptChars) && promptChars >= 0 ? promptChars : null,
    // The model the Agent tool was handed, as the hook saw it; null is the session model.
    model: (opts && opts.model) || null,
  };
  // Count and append under one lock: parallel dispatches that each read the count first would
  // all see room under the cap and all append.
  const counted = chain.withLock(runDir, () => {
    const { count } = dispatchCount(runDir);
    if (count >= maxDispatches) return { refused: count };
    chain.appendUnlocked(runDir, 'dispatch', payload);
    return { used: dispatchCount(runDir).count };
  });
  if (counted.refused !== undefined) {
    console.error(
      `HARD BUDGET: ${counted.refused}/${maxDispatches} dispatches used — do NOT dispatch. Go to Stage 7 with status INCOMPLETE.`
    );
    process.exit(2);
  }
  mirrorBudget(runDir);
  console.log(`ledger: dispatch OK — ${counted.used}/${maxDispatches} used`);
}

function cmdReplan(runDir, reason) {
  requireChain(runDir);
  requireOpen(runDir, 'replan');
  const { maxReplans } = caps(runDir);
  const used = chain.ofKind(runDir, 'replan').length;
  if (used >= maxReplans) {
    console.error(
      `CIRCUIT BREAKER: ${used}/${maxReplans} re-plans used — do NOT re-plan again. Go to Stage 7 with status INCOMPLETE.`
    );
    process.exit(2);
  }
  chain.append(runDir, 'replan', { reason: reason || null });
  mirrorBudget(runDir);
  console.log(`ledger: replan OK — ${used + 1}/${maxReplans} used`);
}

function cmdGate(runDir, stage, evidence) {
  requireChain(runDir);
  requireOpen(runDir, 'gate');
  if (!STAGES.includes(stage)) {
    console.error(`ledger gate: unknown stage "${stage}" — one of ${STAGES.join(', ')}`);
    process.exit(1);
  }
  const hashed = chain.hashEvidence(evidence);
  const missing = hashed.filter((e) => e.missing);
  if (missing.length) {
    console.error(
      `ledger gate: refusing to record "${stage}" — evidence not found: ${missing.map((m) => m.file).join(', ')}. ` +
        `A receipt must reference real files.`
    );
    process.exit(1);
  }

  const proof = STAGE_PROOF[stage] || {};
  const refuse = (why) => {
    console.error(`ledger gate: refusing to record "${stage}" — ${why}${proof.how ? `\n  ${proof.how}` : ''}`);
    process.exit(1);
  };
  if (proof.artifact) {
    const want = path.join(path.resolve(runDir), proof.artifact);
    const hit = hashed.find((e) => samePath(e.file, want));
    if (!hit) {
      refuse(
        `no ${proof.artifact} from this run dir among the sealed evidence. Pass it: ` +
          `--evidence ${want}. A stage receipt with nothing attached, or a file of that name from ` +
          `elsewhere, attests only that this command ran.`
      );
    }
    if (fs.statSync(want).size === 0) refuse(`${want} is empty, so the stage produced nothing`);
    if (proof.validated && !chain.ofKind(runDir, 'validate').some((r) => r.payload && r.payload.sha256 === hit.sha256)) {
      refuse(`${want} matches no validate receipt — only the draft validate_done.js accepted may be frozen`);
    }
  }
  if (proof.anyEvidence && hashed.length === 0) {
    refuse('no --evidence at all, so the receipt proves nothing happened');
  }
  if (proof.receipt && chain.ofKind(runDir, proof.receipt).length === 0) {
    refuse(`there is no sealed "${proof.receipt}" record in the chain yet`);
  }

  chain.append(runDir, 'gate', { stage, evidence: hashed });
  console.log(`ledger: gate "${stage}" recorded${hashed.length ? ` (${hashed.length} evidence file(s) sealed)` : ''}`);
}

// Every path that compares a sealed file against the one on disk resolves it the same way,
// or an absolute receipt and a relative argument would name the same file and never match.
function samePath(a, b) {
  return path.resolve(String(a)) === path.resolve(String(b));
}

// Receipts that sealed this file, oldest first.
function sealsOf(runDir, records, file) {
  const out = [];
  for (const r of records) {
    for (const e of (r.payload && (r.payload.evidence || r.payload.inputs)) || []) {
      if (samePath(sealedFile(runDir, e.file), file)) out.push({ record: r, evidence: e });
    }
  }
  return out;
}

// Record that a sealed document legitimately changed: several files a gate seals keep growing
// afterwards (ledger.md per attempt, approach.md under "## Revisions"). The receipt covers the
// ONE content hash it was recorded against, so a later edit is TAMPERED again.
function cmdRevise(runDir, file, reason) {
  requireChain(runDir);
  requireOpen(runDir, 'revise');
  if (!file) {
    console.error('ledger revise: need the file that changed, e.g. "ledger.js revise <runDir> <runDir>/approach.md --reason \\"...\\""');
    process.exit(1);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`ledger revise: ${file} does not exist — a revision must describe a real file.`);
    process.exit(1);
  }
  if (UNREVISABLE.some((re) => re.test(abs.replace(/\\/g, '/')))) {
    console.error(
      `ledger revise: ${file} is frozen — it may not be revised at all.\n` +
        `  The frozen contract cannot be restated after the freeze, and control-plane state has its own ` +
        `checks in "verify" that a reason string would launder. New criteria are appended with ` +
        `"ledger.js addition ${runDir} \\"- [ ] C<n> (kind): ... | run: ...\\"".`
    );
    process.exit(1);
  }
  if (!reason || reason.trim().replace(/[^a-z0-9]/gi, '').length < MIN_REVISION_REASON) {
    console.error(
      `ledger revise: need a reason a human can act on — what changed in ${path.basename(abs)}, and why.\n` +
        `  "wip" or "fix" is the absence of one wearing the syntax.`
    );
    process.exit(1);
  }

  const records = chain.records(runDir);
  const seals = sealsOf(runDir, records, abs);
  if (seals.length === 0) {
    console.error(
      `ledger revise: no receipt ever sealed ${file}, so there is nothing to revise.\n` +
        `  Only a file a gate committed to can drift, and only that drift needs accounting for.`
    );
    process.exit(1);
  }

  const now = chain.sha256File(abs);
  const prior = records.filter((r) => r.kind === 'revise' && samePath(sealedFile(runDir, r.payload.file), abs)).pop();
  const expected = prior ? prior.payload.sha256 : seals[seals.length - 1].evidence.sha256;
  if (now === expected) {
    console.error(
      `ledger revise: ${path.basename(abs)} is unchanged since it was last sealed — nothing to record.\n` +
        `  Make the edit first; a receipt recorded ahead of the change would not cover it.`
    );
    process.exit(1);
  }

  chain.append(runDir, 'revise', {
    file: abs.replace(/\\/g, '/'),
    sha256: now,
    reason: reason.trim(),
    supersedes: (prior || seals[seals.length - 1].record).seq,
  });
  console.log(`ledger: revision of ${path.basename(abs)} recorded — it will show in the report's Integrity section`);
}

// Additive by construction: the only write this command makes is an append, and the receipt
// seals the result, so a verdict-sealed additions file can grow without becoming TAMPERED
// while any other change to it still is.
const CRITERION_LINE = /^- \[ \] (C\d+) \((test|analyzer|runtime|token|manual)\):.+\|\s*run:\s*\S/;
const CRITERION_ID = (id) => new RegExp(`^- \\[[ x]\\] ${id} `, 'm');

function cmdAddition(runDir, line) {
  requireChain(runDir);
  requireOpen(runDir, 'addition');
  const text = String(line || '').trim();
  const m = CRITERION_LINE.exec(text);
  if (!m) {
    console.error(
      'ledger addition: the line must be a criterion in the done-list shape:\n' +
        '  "- [ ] C<n> (test|analyzer|runtime|token|manual): when <trigger>, the system shall <response> | run: <command>"'
    );
    process.exit(1);
  }
  const file = path.join(runDir, 'done-additions.md');
  if (!fs.existsSync(file)) {
    console.error(`ledger addition: ${file} does not exist — the freeze creates it, so nothing is frozen yet.`);
    process.exit(1);
  }
  const abs = path.resolve(file);
  const records = chain.records(runDir);
  const seals = sealsOf(runDir, records, abs);
  const priorAdd = records.filter((r) => r.kind === 'addition').pop();
  const expected = priorAdd ? priorAdd.payload.sha256 : seals.length ? seals[seals.length - 1].evidence.sha256 : null;
  const current = fs.readFileSync(abs, 'utf8');
  if (expected && chain.sha256File(abs) !== expected) {
    console.error(
      `ledger addition: done-additions.md differs from what was last sealed — it was hand-edited. ` +
        `That edit is TAMPERED and appending cannot re-seal it; restore the sealed content first.`
    );
    process.exit(1);
  }
  const approvedPath = path.join(runDir, 'done.approved.md');
  const approved = fs.existsSync(approvedPath) ? fs.readFileSync(approvedPath, 'utf8') : '';
  if (CRITERION_ID(m[1]).test(approved) || CRITERION_ID(m[1]).test(current)) {
    console.error(`ledger addition: ${m[1]} already exists in the contract — a new criterion needs a new id.`);
    process.exit(1);
  }
  fs.appendFileSync(abs, `${current.endsWith('\n') || current === '' ? '' : '\n'}${text}\n`);
  const sealedBy = priorAdd ? `addition (seq ${priorAdd.seq})` : seals.length ? `${seals[seals.length - 1].record.kind} (seq ${seals[seals.length - 1].record.seq})` : 'nothing yet';
  chain.append(runDir, 'addition', {
    file: abs.replace(/\\/g, '/'),
    id: m[1],
    line: text,
    sha256: chain.sha256File(abs),
    reason: `criterion ${m[1]} appended after ${sealedBy}`,
  });
  console.log(`ledger: ${m[1]} appended to done-additions.md and sealed — the next judge reads it from disk`);
}

// Known only after the dispatch returns, so it is a separate record. It never changes the
// count — refunding a spent slot would make the budget negotiable after the fact.
// Refused rather than stored as null: null means "not measured".
function wholeNumberFlag(value, flag) {
  if (value === undefined) return null;
  if (!/^\d+$/.test(String(value))) {
    console.error(`ledger outcome: ${flag} must be a whole number as the tool reported it, got "${value}"`);
    process.exit(1);
  }
  return Number(value);
}

function cmdOutcome(runDir, seqArg, outcome, note, opts) {
  requireChain(runDir);
  requireOpen(runDir, 'outcome');
  const normalized = String(outcome || '').toLowerCase();
  if (!DISPATCH_OUTCOMES.includes(normalized)) {
    console.error(`ledger outcome: outcome must be one of ${DISPATCH_OUTCOMES.join(', ')}`);
    process.exit(1);
  }
  const tokens = wholeNumberFlag(opts && opts.tokens, '--tokens');
  // A dispatch that ran spent something; zero would undercount the ceiling as an explicit claim.
  if (tokens === 0) {
    console.error('ledger outcome: --tokens must be above zero; leave it out when the tool reported no figure');
    process.exit(1);
  }
  const ms = wholeNumberFlag(opts && opts.ms, '--ms');
  const seq = Number(seqArg);
  const target = chain.records(runDir).find((r) => r.seq === seq);
  if (!target || target.kind !== 'dispatch') {
    console.error(
      `ledger outcome: seq ${seqArg} is ${target ? `a "${target.kind}" record` : 'not in the chain'}, not a dispatch.\n` +
        `  "ledger.js status ${runDir}" and the chain list the dispatch seqs.`
    );
    process.exit(1);
  }
  // The playbook's labelled record and the hook's record are one dispatch, so an outcome on
  // either seq settles both.
  const pair = dispatchPairs(runDir).find((d) => d.seqs.includes(seq)) || { seqs: [seq] };
  const prior = chain.ofKind(runDir, 'outcome').find((r) => pair.seqs.includes(r.payload.dispatchSeq));
  if (prior) {
    const same = prior.payload.dispatchSeq === seq ? '' : ` (seq ${prior.payload.dispatchSeq} is the same dispatch's other record)`;
    console.error(
      `ledger outcome: the dispatch at seq ${seq} already has an outcome${same} — it is recorded once and not revised.`
    );
    process.exit(1);
  }
  chain.append(runDir, 'outcome', { dispatchSeq: seq, outcome: normalized, note: note || null, tokens, ms });
  console.log(
    `ledger: dispatch seq ${seq} recorded as ${normalized}` +
      `${tokens != null ? ` (${tokens} tokens${ms != null ? `, ${ms} ms` : ''})` : ''}` +
      `${normalized === 'died' ? ' (it still spent its budget slot)' : ''}`
  );
}

function roleOf(label) {
  const m = /^\s*([a-z][\w-]*)\s*(?::|$)/i.exec(String(label || ''));
  return m ? m[1].toLowerCase() : 'unlabelled';
}

// The hook labels a dispatch `<subagent_type>: <description>`, and a plugin agent's type
// carries its own colon (`ticket-loop:ticket-loop-qa`), so the type ends at the first colon
// followed by a space.
function agentTypeOf(label) {
  const text = String(label || '');
  const m = /^\s*(.*?):(?:\s|$)/.exec(text);
  return (m ? m[1] : text).trim();
}

// SubagentStop may name an agent with or without its plugin prefix.
function sameAgentType(a, b) {
  if (!a || !b) return false;
  const bare = (t) => String(t).split(':').pop();
  return a === b || bare(a) === bare(b);
}

// One subagent call reaches the chain twice: the playbook's labelled `dispatch` before the
// call, then the hook's record at the tool call. A hook record pairs with the nearest earlier
// unpaired script record; the label comes from the script side, the prompt size from the hook.
// `model` is what the hook saw the Agent tool handed over: null for the session model, and
// absent entirely when no hook record exists to say.
function dispatchPairs(runDir) {
  const pairs = [];
  const unpairedScripts = [];
  for (const r of chain.ofKind(runDir, 'dispatch')) {
    const p = r.payload || {};
    if (p.source === 'hook') {
      const mate = unpairedScripts.pop();
      if (mate) {
        mate.seqs.push(r.seq);
        if (Number.isFinite(p.promptChars) && mate.promptChars == null) mate.promptChars = p.promptChars;
        mate.model = p.model || null;
        mate.agentType = agentTypeOf(p.label);
      } else {
        pairs.push({
          seqs: [r.seq],
          label: p.label,
          promptChars: Number.isFinite(p.promptChars) ? p.promptChars : null,
          model: p.model || null,
          agentType: agentTypeOf(p.label),
        });
      }
    } else {
      const entry = { seqs: [r.seq], label: p.label, promptChars: Number.isFinite(p.promptChars) ? p.promptChars : null };
      pairs.push(entry);
      unpairedScripts.push(entry);
    }
  }
  return pairs;
}

// An alias and the id it resolves to name one model (`haiku`, `claude-haiku-4-5-20251001`).
function sameModel(a, b) {
  return a === b || a.includes(b) || b.includes(a);
}

// The profile names a model per role; the hook records what the Agent tool was handed. A tier
// the profile did not choose, cheaper or dearer, is reported. Pairs with no hook record are
// skipped here: their independence is already reported on its own.
function modelProblems(runDir) {
  const models = readConfig(runDir).models || {};
  const loaded = runPolicy(runDir);
  const org = loaded && !loaded.error ? loaded.policy : null;
  const out = [];
  for (const d of dispatchPairs(runDir)) {
    if (d.model === undefined) continue;
    const role = roleOf(d.label);
    if (org && !policy.modelAllowed(org, role, d.model)) {
      out.push(
        `dispatch seq ${d.seqs[0]} (${role}) ran on ${d.model || 'the session model'} but the org policy allows only ` +
          `${policy.allowedFor(org, role).join(', ')} for ${role}`
      );
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(models, role)) continue;
    const expected = String(models[role] || '').trim().toLowerCase() || 'inherit';
    const actual = d.model ? String(d.model).toLowerCase() : null;
    const matches = expected === 'inherit' ? actual === null : actual !== null && sameModel(actual, expected);
    if (matches) continue;
    out.push(
      `dispatch seq ${d.seqs[0]} (${role}) ran on ${actual || 'the session model'} but the profile names ${expected} for ${role} — ` +
        `the tier was changed at dispatch`
    );
  }
  return out;
}

function stallMinutes(runDir) {
  const v = (readConfig(runDir).dispatchPolicy || {}).stallMinutes;
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_STALL_MINUTES;
}

// Dispatches with no outcome. `returned` is the SubagentStop hook's mark that the tool call
// came back; a dispatch that has neither returned nor been recorded past the stall threshold
// is STALLED. Only the orchestrator can say what a returned dispatch produced, so a return
// without an outcome stays open until it does.
// A `returned` record is a sign of life, not a finish: SubagentStop fires for a background
// agent shortly after it starts, long before its result arrives. So an open dispatch is
// judged by how long it has gone without one, from its last mark or, with none, its launch.
function openDispatches(runDir, now = Date.now()) {
  const atOf = new Map(chain.records(runDir).map((r) => [r.seq, r.at]));
  const outcomes = new Set(chain.ofKind(runDir, 'outcome').map((r) => r.payload.dispatchSeq));
  const lastSeen = new Map();
  for (const r of chain.ofKind(runDir, 'returned')) lastSeen.set(r.payload.dispatchSeq, r.at);
  const stallMs = stallMinutes(runDir) * 60000;
  return dispatchPairs(runDir)
    .filter((d) => !d.seqs.some((seq) => outcomes.has(seq)))
    .map((d) => {
      const at = atOf.get(d.seqs[0]);
      const seenAt = d.seqs.map((seq) => lastSeen.get(seq)).filter(Boolean).sort().pop() || null;
      const quietMs = Math.max(0, now - Date.parse(seenAt || at));
      return {
        seqs: d.seqs,
        label: d.label,
        agentType: d.agentType || null,
        at,
        minutesOpen: Math.round(Math.max(0, now - Date.parse(at)) / 60000),
        seenAt,
        minutesQuiet: Math.round(quietMs / 60000),
        stalled: quietMs >= stallMs,
      };
    });
}

function describeOpen(o) {
  const seq = o.seqs[0];
  const label = o.label || 'unlabelled';
  if (o.stalled) return `dispatch seq ${seq} (${label}) has no outcome and no sign of life for ${o.minutesQuiet} min — STALLED; record it as died if it is dead`;
  return `dispatch seq ${seq} (${label}) has no outcome recorded (out ${o.minutesOpen} min) — wait for it, or record what it produced`;
}

// Marks the dispatch an agent belongs to: the one an earlier mark from the same agent named;
// else the oldest never-marked dispatch of the agent's own type; else the oldest never marked.
// Parallel launches of one type can swap labels, never counts; the outcome the orchestrator
// records names its seq itself.
function cmdReturned(runDir, opts) {
  requireChain(runDir);
  requireOpen(runDir, 'returned');
  const open = openDispatches(runDir);
  const agentId = opts && opts.agentId;
  const agentType = opts && opts.agentType;
  const known = agentId ? chain.ofKind(runDir, 'returned').find((r) => r.payload.agentId === agentId) : null;
  const unmarked = open.filter((o) => !o.seenAt);
  const target = known
    ? open.find((o) => o.seqs.includes(known.payload.dispatchSeq))
    : unmarked.find((o) => sameAgentType(o.agentType, agentType)) || unmarked[0];
  if (!target) {
    console.log('ledger: no dispatch is out — nothing to mark');
    return;
  }
  const messageChars = Number(opts && opts.messageChars);
  chain.append(runDir, 'returned', {
    dispatchSeq: target.seqs[0],
    session: (opts && opts.session) || null,
    agentId: (opts && opts.agentId) || null,
    agentType: (opts && opts.agentType) || null,
    messageChars: Number.isFinite(messageChars) && messageChars >= 0 ? messageChars : null,
  });
  console.log(`ledger: dispatch seq ${target.seqs[0]} seen — its outcome is recorded when its result arrives`);
}

function tokenStats(runDir) {
  const outcomes = new Map(chain.ofKind(runDir, 'outcome').map((r) => [r.payload.dispatchSeq, r.payload]));
  const byRole = {};
  let measured = 0;
  let total = 0;
  // `floor` is what the prompts alone cost; `counted` is what the ceiling charges: per dispatch,
  // the reported figure or the prompt's floor, whichever is larger.
  let floor = 0;
  let counted = 0;
  const pairs = dispatchPairs(runDir);
  for (const d of pairs) {
    const role = roleOf(d.label);
    const entry = byRole[role] || (byRole[role] = { dispatches: 0, measured: 0, tokens: 0, ms: 0 });
    entry.dispatches++;
    const promptFloor = Number.isFinite(d.promptChars) ? Math.ceil(d.promptChars / CHARS_PER_TOKEN) : 0;
    floor += promptFloor;
    const o = d.seqs.map((s) => outcomes.get(s)).find((x) => x && Number.isInteger(x.tokens));
    counted += Math.max(o ? o.tokens : 0, promptFloor);
    if (o) {
      entry.measured++;
      entry.tokens += o.tokens;
      if (Number.isInteger(o.ms)) entry.ms += o.ms;
      measured++;
      total += o.tokens;
    }
  }
  return { measured, unmeasured: pairs.length - measured, total: measured ? total : null, floor, counted, byRole };
}

function cmdRequire(runDir, stage) {
  requireChain(runDir);
  const hit = chain.ofKind(runDir, 'gate').find((r) => r.payload.stage === stage);
  if (!hit) {
    console.error(
      `ledger: stage "${stage}" has no receipt — it did not happen (or was not recorded). ` +
        `Complete it and run "ledger.js gate ${runDir} ${stage}" before continuing.`
    );
    process.exit(3);
  }
  console.log(`ledger: stage "${stage}" receipt present (seq ${hit.seq}, ${hit.at})`);
}

// The frozen contract's criteria: done.approved.md, then what the harness appended to
// done-additions.md. A wrapped bullet is one criterion, as validate_done reads it, since the
// `| run:` tag often lands on a continuation line.
const FROZEN_CONTRACT = ['done.approved.md', 'done-additions.md'];
const CRITERION_HEAD = /^-\s*\[[ xX]\]\s*(C\d+)\b/i;

function frozenCriteria(runDir) {
  const out = [];
  for (const name of FROZEN_CONTRACT) {
    let text;
    try {
      text = fs.readFileSync(path.join(runDir, name), 'utf8');
    } catch {
      continue;
    }
    let open = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('- ')) {
        open = CRITERION_HEAD.test(line) ? { text: line } : null;
        if (open) out.push(open);
      } else if (!line) {
        continue;
      } else if (!/^\s/.test(raw)) {
        open = null;
      } else if (open) {
        open.text += ` ${line}`;
      }
    }
  }
  return out.map(({ text }) => {
    const kind = /\((test|analyzer|runtime|token|manual)\)/i.exec(text);
    const run = /\|\s*run:\s*(.+)$/.exec(text);
    return {
      id: CRITERION_HEAD.exec(text)[1].toUpperCase(),
      kind: kind ? kind[1].toLowerCase() : null,
      run: run ? run[1].trim().replace(/^`(.+)`$/, '$1') : null,
    };
  });
}

function frozenCriterion(runDir, id) {
  return frozenCriteria(runDir).find((c) => c.id === String(id || '').toUpperCase()) || null;
}

// The kind the FROZEN contract gave this criterion, so the rules below key off the contract
// itself rather than a second list that could disagree with it.
function frozenKindOf(runDir, id) {
  const c = frozenCriterion(runDir, id);
  return c ? c.kind : null;
}

function tailOf(text, lines) {
  return String(text || '').replace(/\s+$/, '').split(/\r?\n/).slice(-lines).join('\n');
}

// Runs one shell command and kills its whole process tree at the deadline. A timeout on the
// shell alone orphans what the shell started — on Windows the command keeps running and holds
// its directory — so the deadline is enforced by this child, which can wait asynchronously.
const CRITERION_RUNNER = `
const { spawn, spawnSync } = require('child_process');
const [command, cwd, timeoutMs, keep] = JSON.parse(process.argv[1]);
const win = process.platform === 'win32';
const kid = spawn(command, { shell: true, cwd, detached: !win, windowsHide: true });
let out = '';
const take = (c) => { out = (out + c).slice(-keep); };
kid.stdout.on('data', take);
kid.stderr.on('data', take);
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (win) spawnSync('taskkill', ['/pid', String(kid.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-kid.pid, 'SIGKILL'); } catch (e) { kid.kill('SIGKILL'); } }
}, timeoutMs);
kid.on('error', (e) => take('\\n' + e.message));
kid.on('close', (code) => {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ code: timedOut ? null : code, timedOut, out }));
});
`;
// Grace for the runner itself to report after it has killed the command.
const RUNNER_GRACE_MS = 30000;

// The criterion's own frozen command, run by the ledger rather than reported to it: a result
// "by command" is the exit code this process saw.
function runCriterion(command, cwd, timeoutMs) {
  const started = Date.now();
  const res = spawnSync(process.execPath, ['-e', CRITERION_RUNNER, JSON.stringify([command, cwd, timeoutMs, CHECK_OUTPUT_KEEP_CHARS])], {
    encoding: 'utf8',
    timeout: timeoutMs + RUNNER_GRACE_MS,
    windowsHide: true,
  });
  let ran;
  try {
    ran = JSON.parse(res.stdout);
  } catch {
    ran = { code: null, timedOut: false, out: `the command could not be run: ${(res.stderr || (res.error && res.error.message) || '').trim()}` };
  }
  return {
    command,
    cwd: path.resolve(cwd).replace(/\\/g, '/'),
    exitCode: typeof ran.code === 'number' ? ran.code : null,
    ms: Date.now() - started,
    ...(ran.timedOut ? { timedOut: true } : {}),
    outputTail: tailOf(ran.out, OUTPUT_TAIL_LINES),
  };
}

// Runs the criterion for `--by command` and refuses a claimed result its exit code contradicts.
function commandResult(runDir, criterion, claimed, opts) {
  const refuse = (why) => {
    console.error(`ledger check: refusing ${criterion.id} ${claimed} --by command — ${why}`);
    process.exit(1);
  };
  if (claimed === 'SKIPPED') refuse('a command decides PASS or FAIL; record a skip --by asserted');
  if (!criterion.run || NON_COMMAND_RUNNERS.test(criterion.run)) {
    refuse(`the frozen contract gives it no shell command to run (${criterion.run || 'no run:'}); record it --by observed or --by human`);
  }
  if (!opts.cwd || !fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
    refuse(`--cwd <dir> must name the directory the command runs in (the ticket worktree)${opts.cwd ? `; ${opts.cwd} is not one` : ''}`);
  }
  let timeoutMs = DEFAULT_CHECK_TIMEOUT_MS;
  if (opts.timeoutMs !== undefined) {
    if (!/^\d+$/.test(String(opts.timeoutMs)) || Number(opts.timeoutMs) <= 0) refuse(`--timeout-ms must be a whole number above zero, got "${opts.timeoutMs}"`);
    timeoutMs = Number(opts.timeoutMs);
  }
  const ran = runCriterion(criterion.run, opts.cwd, timeoutMs);
  if ((claimed === 'PASS') !== (ran.exitCode === 0)) {
    refuse(
      `"${ran.command}" ${ran.timedOut ? `timed out after ${timeoutMs} ms` : `exited ${ran.exitCode}`}, which is not a ${claimed}.\n` +
        `  Last output:\n${ran.outputTail.split('\n').map((l) => `    ${l}`).join('\n')}`
    );
  }
  return ran;
}

function cmdCheck(runDir, id, result, method, note, opts = {}) {
  requireChain(runDir);
  requireOpen(runDir, 'check');
  const normalized = String(result || '').toUpperCase();
  if (!CHECK_RESULTS.includes(normalized)) {
    console.error(`ledger check: result must be one of ${CHECK_RESULTS.join(', ')}`);
    process.exit(1);
  }
  const by = String(method || '').toLowerCase();
  if (!CHECK_METHODS.includes(by)) {
    console.error(
      `ledger check: name how this was established — --by ${CHECK_METHODS.join('|')}\n` +
        `  command = a command decided it | observed = the running system was exercised\n` +
        `  human = a person confirmed it  | asserted = concluded without either`
    );
    process.exit(1);
  }
  // Concluding that something works, having neither run nor watched anything, is not a pass.
  // SKIPPED already says "not established" without claiming it holds.
  if (by === 'asserted' && normalized === 'PASS') {
    console.error(
      `ledger check: refusing "${id} PASS --by asserted" — reading the code or trusting a summary ` +
        `does not establish a pass.\n  Run it (command), drive it (observed), have someone look ` +
        `(human), or record SKIPPED, which is what "not established" is for.`
    );
    process.exit(1);
  }
  const criterion = frozenCriterion(runDir, id);
  if (!criterion) {
    console.error(
      `ledger check: ${id} is not a criterion of the frozen contract (${FROZEN_CONTRACT.join(', ')} in ${runDir}).\n` +
        `  A result is recorded against the contract; a new criterion is appended with "ledger.js addition" first.`
    );
    process.exit(1);
  }
  const kind = frozenKindOf(runDir, id);
  if (kind === 'manual' && normalized === 'PASS' && by !== 'human') {
    console.error(
      `ledger check: ${id} is a (manual) criterion in the frozen contract, so a pass needs ` +
        `--by human. A command cannot stand in for the person the criterion asks for.`
    );
    process.exit(1);
  }
  const ran = by === 'command' ? commandResult(runDir, criterion, normalized, opts) : null;
  chain.append(runDir, 'check', { id: criterion.id, result: normalized, by, kind, note: note || null, ...(ran || {}) });
  const history = chain.ofKind(runDir, 'check').filter((r) => r.payload.id === criterion.id).map((r) => r.payload.result);
  console.log(
    `ledger: check ${criterion.id} ${normalized}${ran ? ` ("${ran.command}" exited ${ran.exitCode} in ${ran.ms} ms)` : ''} — history: ${history.join(' → ')}`
  );
}

// A verdict is a claim that an independent judge read the frozen contract. Two things have to
// hold: this run's frozen contract, by path, is among the sealed inputs, and a QA judge was
// dispatched through the hook after the freeze and has neither sealed a verdict nor been given
// an outcome — a judge seals its verdict before it returns. Neither proves WHICH process typed
// the verdict — process identity is not available here — but a dispatch of any other agent
// does not back one.
function judgeDispatch(runDir, freeze) {
  const judged = new Set(chain.ofKind(runDir, 'verdict').map((r) => r.payload.dispatchSeq));
  const settledSeqs = new Set(chain.ofKind(runDir, 'outcome').map((r) => r.payload.dispatchSeq));
  const settled = new Set(dispatchPairs(runDir).filter((d) => d.seqs.some((s) => settledSeqs.has(s))).flatMap((d) => d.seqs));
  const judges = chain
    .ofKind(runDir, 'dispatch')
    .filter((r) => r.seq > freeze.seq && r.payload && r.payload.source === 'hook' && JUDGE_ROLE.test(agentTypeOf(r.payload.label)));
  return { judges, judge: judges.filter((r) => !judged.has(r.seq) && !settled.has(r.seq)).pop() || null };
}

function cmdVerdict(runDir, verdict, inputs) {
  requireChain(runDir);
  requireOpen(runDir, 'verdict');
  const normalized = String(verdict || '').toUpperCase().replace(/[\s-]+/g, '_');
  if (!VERDICTS.includes(normalized)) {
    console.error(`ledger verdict: must be one of ${VERDICTS.join(', ')}`);
    process.exit(1);
  }
  const hashed = chain.hashEvidence(inputs);
  const missing = hashed.filter((e) => e.missing);
  if (missing.length) {
    console.error(`ledger verdict: judged-input files not found: ${missing.map((m) => m.file).join(', ')}`);
    process.exit(1);
  }
  const contract = FROZEN_CONTRACT.map((name) => path.join(path.resolve(runDir), name)).filter(
    (f, i) => i === 0 || fs.existsSync(f)
  );
  const unsealed = contract.filter((f) => !hashed.some((e) => samePath(e.file, f)));
  if (unsealed.length) {
    console.error(
      `ledger verdict: refusing to record a verdict that does not seal the frozen contract.\n` +
        `  Pass --inputs ${unsealed.join(' --inputs ')}. ` +
        `A verdict over nothing, or over a copy from elsewhere, cannot show which contract was judged.`
    );
    process.exit(1);
  }

  const freeze = chain.ofKind(runDir, 'gate').find((r) => r.payload.stage === 'freeze');
  if (!freeze) {
    console.error(`ledger verdict: refusing — nothing has been frozen yet, so there is no contract to judge.`);
    process.exit(1);
  }
  const { judges, judge } = judgeDispatch(runDir, freeze);
  if (!judge && judges.length) {
    const last = judges[judges.length - 1];
    const prior = chain.ofKind(runDir, 'verdict').find((r) => r.payload.dispatchSeq === last.seq);
    console.error(
      `ledger verdict: every QA judge dispatched since the freeze has already sealed a verdict or been given an outcome` +
        `${prior ? ` (seq ${last.seq} already sealed ${prior.payload.verdict} at seq ${prior.seq})` : ''} — ` +
        `a judge's verdict is recorded once. A re-review is a new dispatch, not a second seal.`
    );
    process.exit(1);
  }
  if (!judge) {
    console.error(
      `ledger verdict: refusing — no ticket-loop-qa judge was dispatched through the hook after the freeze ` +
        `(seq ${freeze.seq}), so no fresh-context judge can have run.\n` +
        `  Dispatch the QA agent (subagent_type ticket-loop-qa) and let it record the verdict itself.`
    );
    process.exit(3);
  }

  chain.append(runDir, 'verdict', {
    verdict: normalized,
    inputs: hashed,
    dispatchSeq: judge.seq,
    dispatchSource: judge.payload.source,
  });
  console.log(
    `ledger: verdict ${normalized} recorded (${hashed.length} judged input(s) sealed, backed by the judge dispatched at seq ${judge.seq})`
  );
}

function writeCloseMarker(runDir, closeRec) {
  const marker = {
    '//': 'END-OF-RUN MARKER — written only by ledger.js close. The chain\'s close record is the authority; this file is how the hooks see it.',
    closedAt: closeRec.at,
    reportGateSeq: closeRec.payload.reportGateSeq,
    closeSeq: closeRec.seq,
    chainRecords: closeRec.seq,
    lastSeal: closeRec.hmac,
  };
  fs.writeFileSync(closedPath(runDir), JSON.stringify(marker, null, 2) + '\n');
}

// Ending the run has to cost a receipt, or it is just another file the orchestrator can write
// to get out from under the gates. The close is itself a chain record, so deleting the marker
// re-opens nothing: the ledger still refuses records, close rewrites the marker from the
// chain, and verify reports the removal.
function cmdClose(runDir) {
  requireChain(runDir);
  const sealedClose = chain.first(runDir, 'close');
  if (sealedClose && !fs.existsSync(closedPath(runDir))) {
    writeCloseMarker(runDir, sealedClose);
    console.log(
      `ledger: ${runDir} was closed in the chain (seq ${sealedClose.seq}) but its close marker was missing — ` +
        `marker rewritten from the chain. verify reports the removal.`
    );
    return;
  }
  if (sealedClose || fs.existsSync(closedPath(runDir))) {
    console.error(`ledger close: ${runDir} is already closed.`);
    process.exit(1);
  }
  const reportGate = chain.ofKind(runDir, 'gate').find((r) => r.payload.stage === 'report');
  if (!reportGate) {
    console.error(
      `ledger close: refusing to close ${runDir} — there is no sealed "report" gate receipt.\n` +
        `  Write report.md, then "ledger.js gate ${runDir} report --evidence ${path.join(runDir, 'report.md')}", ` +
        `then close.\n` +
        `  If this run is being abandoned rather than reported, use "ledger.js archive ${runDir}" instead.`
    );
    process.exit(3);
  }
  const open = openDispatches(runDir);
  if (open.length) {
    console.error(
      `ledger close: refusing to close ${runDir} — ${open.length} dispatch(es) have no outcome:\n` +
        open.map((o) => `  - ${describeOpen(o)}`).join('\n') +
        `\n  Record each with "ledger.js outcome ${runDir} <seq> ok|died [note]" — died if it produced nothing — then close.`
    );
    process.exit(3);
  }
  const records = chain.records(runDir);
  const closeRec = chain.append(runDir, 'close', {
    reportGateSeq: reportGate.seq,
    verdict: (chain.last(runDir, 'verdict') || { payload: {} }).payload.verdict || null,
    records: records.length,
  });
  writeCloseMarker(runDir, closeRec);
  console.log(
    `ledger: closed ${runDir} (report receipt seq ${reportGate.seq}, close record seq ${closeRec.seq}). ` +
      `The dispatch budget and the control-plane freeze are released.`
  );
}

function cmdArchive(runDir) {
  if (!fs.existsSync(runDir)) {
    console.error(`ledger archive: ${runDir} does not exist`);
    process.exit(1);
  }
  let n = 1;
  while (fs.existsSync(`${runDir}._old_${n}`)) n++;
  const dest = `${runDir}._old_${n}`;
  fs.renameSync(runDir, dest);
  console.log(
    `ledger: archived ${runDir} → ${dest}. The receipt chain was NOT moved — ` +
      `"ledger.js init ${runDir} <baseSha> --restart" is required, and the restart is recorded.`
  );
}

// A person's answer, as notify.js received it: the question, the option chosen, the channel and
// sender it came from, and the one-time code it carried. `forgeable` marks a channel the agent
// itself could have posted on; such an answer is recorded but cannot back a clearance.
function cmdApproval(runDir, a) {
  requireChain(runDir);
  requireOpen(runDir, 'approval');
  const choice = Number(a.choice);
  const missing = ['question', 'channel', 'sender', 'nonce'].filter((k) => !a[k] || !String(a[k]).trim());
  if (missing.length || !Number.isInteger(choice) || choice < 1) {
    console.error(`ledger approval: need --question, --choice <n>, --channel, --sender and --nonce${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
    process.exit(1);
  }
  chain.append(runDir, 'approval', {
    question: a.question,
    choice,
    choiceText: a.choiceText || null,
    channel: a.channel,
    sender: a.sender,
    nonce: a.nonce,
    forgeable: !!a.forgeable,
  });
  console.log(`ledger: approval recorded (seq ${chain.last(runDir, 'approval').seq}) — choice ${choice} from ${a.channel}`);
}

// The approval a clearance or raise cites: recorded, from a channel the agent could not post on,
// still fresh, and not already spent on another act.
function usableApproval(runDir, approvalSeq, what) {
  const approval = chain.ofKind(runDir, 'approval').find((r) => r.seq === Number(approvalSeq));
  const fail = (msg) => {
    console.error(`ledger ${what}: ${msg}`);
    process.exit(1);
  };
  if (!approval) fail(`seq ${approvalSeq} is not a recorded approval`);
  if (approval.payload.forgeable) {
    fail(`the approval at seq ${approvalSeq} came on ${approval.payload.channel}, which the agent itself could have posted on; it cannot back a ${what}`);
  }
  const limit = Number(readConfig(runDir).approvalMinutes);
  const minutes = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_APPROVAL_MINUTES;
  if (Date.now() - Date.parse(approval.at) > minutes * 60000) {
    fail(`the approval at seq ${approvalSeq} is older than ${minutes} min; ask again`);
  }
  const spent = [...chain.ofKind(runDir, 'clearance'), ...chain.ofKind(runDir, 'raise'), ...chain.ofKind(runDir, 'consent')].find((r) => r.payload.approvalSeq === approval.seq);
  if (spent) fail(`the approval at seq ${approvalSeq} already backed the ${spent.kind} at seq ${spent.seq}; one answer, one act`);
  return approval;
}

const PUBLISH_ACTS = ['push', 'pr', 'ticket'];

// What the profile, under the org policy, lets a run publish. An act missing here cannot be
// consented to, so no answer given mid-run can widen what the repo allows.
function publishAllowed(runDir) {
  const list = ((readConfig(runDir).publish || {}).allowed) || [];
  return PUBLISH_ACTS.filter((a) => Array.isArray(list) && list.includes(a));
}

// The person's answers to the three publish questions, asked once at the start of a run. Each act
// is answered on its own; anything not answered yes is a no.
function cmdConsent(runDir, answers, reason, approvalSeq) {
  requireChain(runDir);
  requireOpen(runDir, 'consent');
  if (chain.ofKind(runDir, 'consent').length) {
    console.error('ledger consent: this run already recorded its publish answers; they are asked once, at the start');
    process.exit(1);
  }
  if (!reason || !reason.trim()) {
    console.error('ledger consent: need a reason — who answered, and where');
    process.exit(1);
  }
  const allowed = publishAllowed(runDir);
  const acts = {};
  for (const act of PUBLISH_ACTS) {
    const raw = String(answers[act] || 'no').toLowerCase();
    if (!['yes', 'no'].includes(raw)) {
      console.error(`ledger consent: --${act} must be yes or no`);
      process.exit(1);
    }
    if (raw === 'yes' && !allowed.includes(act)) {
      console.error(`ledger consent: the profile does not allow "${act}" (publish.allowed is [${allowed.join(', ')}]); a run cannot be given more than the repo allows`);
      process.exit(1);
    }
    acts[act] = raw === 'yes';
  }
  const approval = approvalSeq !== undefined ? usableApproval(runDir, approvalSeq, 'consent') : null;
  chain.append(runDir, 'consent', { acts, reason: reason.trim(), ...(approval ? { approvalSeq: approval.seq, approvedVia: approval.payload.channel } : {}) });
  console.log(`ledger: publish consent recorded — ${PUBLISH_ACTS.map((a) => `${a} ${acts[a] ? 'yes' : 'no'}`).join(', ')}`);
}

function cmdRaise(runDir, tokensArg, reason, approvalSeq) {
  requireChain(runDir);
  requireOpen(runDir, 'raise');
  const tokens = Number(tokensArg);
  if (!Number.isInteger(tokens) || tokens <= 0) {
    console.error('ledger raise: --tokens must be a whole number above zero');
    process.exit(1);
  }
  if (!reason || !reason.trim()) {
    console.error('ledger raise: need a reason — who agreed to spend more, and on what');
    process.exit(1);
  }
  const approval = approvalSeq !== undefined ? usableApproval(runDir, approvalSeq, 'raise') : null;
  chain.append(runDir, 'raise', { tokens, reason: reason.trim(), ...(approval ? { approvalSeq: approval.seq, approvedVia: approval.payload.channel } : {}) });
  const { tokensUsed, maxRunTokens } = tokenCeiling(runDir);
  console.log(`ledger: token ceiling raised by ${tokens} — ${tokensUsed} of ${maxRunTokens === null ? 'no ceiling' : maxRunTokens} used`);
}

// GATE A/C clearance for a risk-tier area. freeze_guard denies edits under riskPaths until one
// of these exists, so this is the recorded act that unlocks it — and it lands in the sealed
// chain, so the report shows exactly what was cleared and why. The orchestrator is told never
// to run this without asking a human; that part is not mechanical, and the receipt is what
// makes skipping it visible afterwards.
function cmdClear(runDir, glob, reason, approvalSeq) {
  requireChain(runDir);
  requireOpen(runDir, 'clear');
  if (!glob) {
    console.error('ledger clear: need the riskPaths glob to clear, e.g. "lib/ui/auth/**"');
    process.exit(1);
  }
  // Only a glob the profile actually declares may be cleared. Without this, `clear "**"`
  // would grant one blanket exemption over every risk area, and the per-glob guarantee would
  // hold for the literals in the README and nothing else.
  const declared = riskPathsFromConfig(runDir);
  if (!declared.includes(glob)) {
    console.error(
      `ledger clear: "${glob}" is not one of the profile's riskPaths, so there is nothing to ` +
        `clear.\n  Declared: ${declared.length ? declared.map((g) => `"${g}"`).join(', ') : '(none)'}\n` +
        `  Clear an area exactly as the profile spells it — a broader pattern would open the rest.`
    );
    process.exit(1);
  }
  if (!reason || !reason.trim()) {
    console.error('ledger clear: need a reason — what did the human approve, and why is it safe?');
    process.exit(1);
  }
  let approval = null;
  if (approvalSeq !== undefined) {
    approval = usableApproval(runDir, approvalSeq, 'clearance');
    if (!String(approval.payload.question).includes(glob)) {
      console.error(`ledger clear: the approval at seq ${approvalSeq} asked "${approval.payload.question}", which does not name ${glob}`);
      process.exit(1);
    }
  }
  chain.append(runDir, 'clearance', { glob, reason: reason.trim(), ...(approval ? { approvalSeq: approval.seq, approvedVia: approval.payload.channel } : {}) });
  mirrorClearances(runDir);
  console.log(`ledger: cleared "${glob}" — recorded in the chain and mirrored for the hooks`);
}

function cmdSlice(runDir, id, globs) {
  requireChain(runDir);
  requireOpen(runDir, 'slice');
  const sliceId = String(id || '').trim();
  const files = [
    ...new Set(
      (globs || [])
        .flatMap((g) => String(g).split(','))
        .map((g) => g.trim().replace(/\\/g, '/'))
        .filter(Boolean)
    ),
  ];
  if (!sliceId) {
    console.error('ledger slice: a slice needs an id — the criterion it implements, e.g. C3');
    process.exit(1);
  }
  if (!files.length) {
    console.error('ledger slice: name the files or globs the slice is expected to touch with --files');
    process.exit(1);
  }
  chain.append(runDir, 'slice', { id: sliceId, files });
  console.log(`ledger: slice ${sliceId} declared over ${files.join(', ')}`);
}

function gitLines(tree, args) {
  const res = spawnSync('git', ['-C', tree, ...args], { encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0) return null;
  return (res.stdout || '').split('\n').filter((l) => l.trim());
}

// A verdict with no scope receipt before it yields nothing; the next review is sized from scratch.
function deltaSinceVerdict(runDir, tree, riskPaths) {
  const verdict = chain.last(runDir, 'verdict');
  if (!verdict) return null;
  const judged = chain.ofKind(runDir, 'scope').filter((r) => r.seq < verdict.seq).pop();
  if (!judged || !judged.payload.head) return null;
  const changed = gitLines(tree, ['diff', '--name-only', judged.payload.head]);
  if (changed === null) return null;
  const files = changed.map((f) => f.replace(/\\/g, '/'));
  const judgedFiles = new Set(judged.payload.files || []);
  return {
    since: judged.payload.head,
    priorVerdictSeq: verdict.seq,
    judgedCount: judgedFiles.size,
    files,
    outside: files.filter((f) => !judgedFiles.has(f)),
    risk: files.filter((f) => riskPaths.some((g) => globToRegExp(g).test(f))),
  };
}

// What the QA judge should READ, decided here rather than eyeballed. Two rules, and the second
// is the one prose got wrong: a diff is sized by what it ADDED. Deleting a 68-line component is
// not 68 lines of new surface to review, but a line count that sums insertions and deletions
// says it is, so every removal bought a full-codebase sweep it did not need. A risk path still
// forces FULL at any size, because there the question is never "how much".
// `--base <ref>` judges a diff with no run behind it, for the standalone review. Everything
// else is identical, deliberately: a review outside a run should size and fence a change the
// same way one inside it does.
function cmdQaScope(runDir, worktree, baseRef) {
  const withRun = !baseRef;
  if (withRun) {
    requireChain(runDir);
    requireOpen(runDir, 'qascope');
  }
  const cfg = readConfig(withRun ? runDir : null);
  const limit = Number((cfg.qaScope || {}).smallDiffLines);
  const threshold = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_SMALL_DIFF_LINES;
  const baseSha = baseRef || caps(runDir).baseSha;
  const tree = worktree || '.';

  const ranges = [];
  if (baseSha) ranges.push(gitLines(tree, ['diff', '--numstat', `${baseSha}..HEAD`]));
  ranges.push(gitLines(tree, ['diff', '--numstat', 'HEAD']));

  let added = 0;
  let removed = 0;
  const files = new Set();
  let readable = false;
  for (const lines of ranges) {
    if (lines === null) continue;
    readable = true;
    for (const line of lines) {
      const [a, r, file] = line.split('\t');
      if (a !== '-') added += Number(a) || 0;
      if (r !== '-') removed += Number(r) || 0;
      if (file) files.add(file.replace(/\\/g, '/'));
    }
  }
  const headLines = gitLines(tree, ['rev-parse', 'HEAD']);
  const head = headLines && headLines[0] ? headLines[0].trim() : null;

  const riskPaths = riskPathsFromConfig(withRun ? runDir : null);
  const touchedRiskPaths = [...files].filter((f) => riskPaths.some((g) => globToRegExp(g).test(f)));

  // The files a focused read must include beyond the diff itself.
  const graph = importersOf(tree, [...files]);
  const consumers = Object.fromEntries(Object.entries(graph.importers).filter(([, list]) => list.length));
  const consumerFiles = [...new Set(Object.values(consumers).flat())].filter((f) => !files.has(f)).sort();

  let declaredScope = null;
  let outsideScope = null;
  if (withRun) {
    const globs = [...new Set(chain.ofKind(runDir, 'slice').flatMap((r) => r.payload.files || []))];
    if (globs.length) {
      declaredScope = globs;
      outsideScope = [...files].filter((f) => !globs.some((g) => globToRegExp(g).test(f))).sort();
    }
  }

  // An unreadable diff is not a small one. Nothing about the change is known, so the judge
  // reads widely rather than narrowly.
  const reasons = [];
  if (!readable) reasons.push('the diff could not be read, so its size is unknown');
  if (touchedRiskPaths.length) reasons.push(`risk paths touched: ${touchedRiskPaths.join(', ')}`);
  if (added > threshold) reasons.push(`${added} inserted line(s) exceeds qaScope.smallDiffLines (${threshold})`);

  // Risk is judged since the verdict, not since base.
  const delta = withRun && readable ? deltaSinceVerdict(runDir, tree, riskPaths) : null;
  let scope;
  let why;
  if (delta && !delta.outside.length && !delta.risk.length) {
    scope = 'DELTA';
    why = [
      `re-review after verdict seq ${delta.priorVerdictSeq}: ${delta.files.length} file(s) changed since the judged tree ` +
        `${delta.since.slice(0, 12)}, all inside the ${delta.judgedCount} file(s) that judge read`,
    ];
  } else {
    scope = reasons.length ? 'FULL' : 'FOCUSED';
    why = reasons.length ? reasons : [`${added} inserted line(s) is within qaScope.smallDiffLines (${threshold}), no risk path touched`];
    if (delta && delta.outside.length) {
      why.push(`re-review after verdict seq ${delta.priorVerdictSeq} escalated: ${delta.outside.join(', ')} were not in the judged set`);
    }
    if (delta && delta.risk.length) {
      why.push(`re-review after verdict seq ${delta.priorVerdictSeq} escalated: risk paths changed since that judge read them: ${delta.risk.join(', ')}`);
    }
  }

  const out = {
    scope,
    why,
    insertions: added,
    deletions: removed,
    filesChanged: files.size,
    threshold,
    touchedRiskPaths,
    head,
    declaredScope,
    outsideScope,
    since: scope === 'DELTA' ? delta.since : null,
    deltaFiles: scope === 'DELTA' ? delta.files : null,
    priorVerdictSeq: delta ? delta.priorVerdictSeq : null,
    consumers,
    consumerFiles,
    consumersTruncated: graph.truncated,
    label: `qa: contract [${scope.toLowerCase()}]`,
  };
  if (withRun) {
    chain.append(runDir, 'scope', {
      scope,
      head,
      files: [...files].sort(),
      insertions: added,
      deletions: removed,
      touchedRiskPaths,
      outsideScope,
      consumerFiles,
      since: out.since,
      priorVerdictSeq: out.priorVerdictSeq,
    });
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// The profile a run is governed by: its repo's, under the policy sealed at its init. With no
// run, the profile in the working directory under the policy the environment names.
function readConfig(runDir) {
  const root = runDir ? repoRootOf(runDir) : '.';
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), 'utf8'));
  } catch {
    raw = {};
  }
  const loaded = runDir && chain.exists(runDir) ? runPolicy(runDir) : policy.readPolicy();
  return policy.applyPolicy(raw, loaded).cfg;
}

function riskPathsFromConfig(runDir) {
  const cfg = readConfig(runDir);
  return Array.isArray(cfg.riskPaths) ? cfg.riskPaths : [];
}

// What the subagents were handed, from the sizes the hook recorded. Dispatches with no
// recorded size are counted separately rather than folded in as zero.
function promptStats(runDir) {
  const budget = Number((readConfig(runDir).dispatchPolicy || {}).promptBudgetChars) || DEFAULT_PROMPT_BUDGET;
  const pairs = dispatchPairs(runDir);
  const sizes = pairs.map((d) => d.promptChars).filter((n) => Number.isFinite(n));
  if (sizes.length === 0) return { measured: 0, unmeasured: pairs.length, total: null, max: null, avg: null, overBudget: 0, budget };
  const total = sizes.reduce((a, b) => a + b, 0);
  return {
    measured: sizes.length,
    unmeasured: pairs.length - sizes.length,
    total,
    max: Math.max(...sizes),
    avg: Math.round(total / sizes.length),
    overBudget: sizes.filter((n) => n > budget).length,
    budget,
  };
}

function clearancesPath(runDir) {
  return path.join(runDir, 'clearances.json');
}

// Fast mirror for freeze_guard: it runs on EVERY edit, so it must not spawn a process to ask
// the chain. Written only here, hook-protected, and rebuilt from the chain each time so it
// cannot drift into granting something the chain does not hold.
function mirrorClearances(runDir) {
  const cleared = chain.ofKind(runDir, 'clearance').map((r) => ({
    glob: r.payload.glob,
    reason: r.payload.reason,
    at: r.at,
  }));
  try {
    fs.writeFileSync(clearancesPath(runDir), JSON.stringify({ cleared }, null, 2) + '\n');
  } catch (e) {
    console.error(`ledger: could not write the clearance mirror (${e.message}) — hooks will keep denying`);
  }
}

function cmdCost(runDir, worktree) {
  // The command whose whole purpose is making claims checkable must not report numbers off an
  // unverified history: on a missing chain the counts would read as a confident zero.
  requireChain(runDir);
  const { baseSha } = caps(runDir);
  const recs = chain.records(runDir);
  const stamp = (r) => Date.parse(r.at);
  const first = recs.length ? stamp(recs[0]) : null;
  const last = recs.length ? stamp(recs[recs.length - 1]) : null;

  const byKind = {};
  for (const r of recs) byKind[r.kind] = (byKind[r.kind] || 0) + 1;

  // Wall-clock between consecutive receipts, attributed to the receipt that ends the span.
  const spans = [];
  for (let i = 1; i < recs.length; i++) {
    const label = recs[i].kind === 'gate' ? `gate:${recs[i].payload.stage}` : recs[i].kind;
    spans.push({ label, ms: stamp(recs[i]) - stamp(recs[i - 1]) });
  }
  const slowest = [...spans].sort((a, b) => b.ms - a.ms).slice(0, 5);

  let diff = null;
  if (baseSha) {
    const res = spawnSync('git', ['-C', worktree || '.', 'diff', '--numstat', `${baseSha}..HEAD`], {
      encoding: 'utf8',
      timeout: 30000,
    });
    if (res.status === 0) {
      let added = 0;
      let removed = 0;
      let files = 0;
      for (const line of (res.stdout || '').split('\n').filter((l) => l.trim())) {
        const [a, r] = line.split('\t');
        if (a !== '-') added += Number(a) || 0;
        if (r !== '-') removed += Number(r) || 0;
        files++;
      }
      diff = { files, added, removed, net: added - removed };
    }
  }

  const dispatches = dispatchCount(runDir).count;
  const tokens = tokenStats(runDir);
  process.stdout.write(
    JSON.stringify(
      {
        note:
          'tokens are the subagent totals the Agent tool reported, sealed on dispatch outcomes; tokensFloor is what the ' +
          'prompts alone cost (characters / 4), and the ceiling charges each dispatch the larger of the two. The ' +
          'orchestrator\'s own turns are not observable, so every figure is a floor. Everything else is a proxy from the chain and git',
        dispatches,
        dispatchesDied: diedCount(runDir),
        tokensFloor: tokens.floor,
        tokens,
        subagentPrompts: promptStats(runDir),
        evidence: evidenceStats(runDir),
        replans: byKind.replan || 0,
        receiptsByKind: byKind,
        wallClockMs: first != null && last != null ? last - first : null,
        slowestSpans: slowest,
        diffVsBase: diff,
        linesPerDispatch: diff && dispatches ? Math.round((diff.added + diff.removed) / dispatches) : null,
      },
      null,
      2
    ) + '\n'
  );
}

function cmdStatus(runDir) {
  requireChain(runDir);
  process.stdout.write(JSON.stringify(counters(runDir), null, 2) + '\n');
}

// The Stage-7 integrity report: chain intact? mirror in step? frozen artifacts unchanged
// since their receipts? This is what makes "no tampering" checkable instead of asserted.
function integrityReport(runDir) {
  const v = chain.verify(runDir);
  const problems = [...v.problems];
  const revisions = [];

  if (v.ok) {
    const c = counters(runDir);
    try {
      const mirror = JSON.parse(fs.readFileSync(budgetPath(runDir), 'utf8'));
      if (mirror.dispatches !== c.dispatches || mirror.replans !== c.replans) {
        problems.push(
          `budget.json disagrees with the sealed chain (mirror says ${mirror.dispatches}/${mirror.replans}, ` +
            `chain says ${c.dispatches}/${c.replans}) — the mirror was edited; the chain governs`
        );
      }
      if (mirror.maxDispatches !== c.maxDispatches || mirror.maxReplans !== c.maxReplans) {
        problems.push(`budget.json caps were edited (chain caps are ${c.maxDispatches}/${c.maxReplans})`);
      }
    } catch {
      problems.push('budget.json missing or unreadable (mirror only — not fatal)');
    }

    // Records added after the run ended seal and link perfectly, so nothing else notices them.
    // The close marker is the only record of where the chain stood when the gates were lifted.
    try {
      const marker = JSON.parse(fs.readFileSync(closedPath(runDir), 'utf8'));
      const last = v.records.length ? v.records[v.records.length - 1].hmac : null;
      if (marker.chainRecords !== v.records.length || (marker.lastSeal || null) !== last) {
        problems.push(
          `records were appended after the run was closed: the close marker recorded ` +
            `${marker.chainRecords} record(s) ending ${(marker.lastSeal || 'none').toString().slice(0, 12)}…, ` +
            `the chain now holds ${v.records.length} ending ${(last || 'none').toString().slice(0, 12)}…`
        );
      }
    } catch {
      // No marker means the run is still open; freeze_guard protects it from ordinary writes.
    }
    const closeRec = v.records.find((r) => r.kind === 'close');
    if (closeRec) {
      if (!fs.existsSync(closedPath(runDir))) {
        problems.push(
          `close marker removed: the chain closed this run at seq ${closeRec.seq}, but closed.json is gone, so the hooks read it as open again`
        );
      }
      const after = v.records.filter((r) => r.seq > closeRec.seq);
      if (after.length) {
        problems.push(
          `records after the close record (seq ${closeRec.seq}): ${after.map((r) => `${r.kind} seq ${r.seq}`).join(', ')}`
        );
      }
    }

    // freeze_guard trusts the clearance mirror without consulting the chain, because it runs on
    // every edit. So verify does what the hook cannot: confirm every glob the mirror grants is
    // backed by a sealed record. A mirror written around ledger.js forges a human's GATE A/C
    // approval, and this is the only place that becomes evident. Only over-granting matters —
    // a missing entry just makes the hook deny.
    const sealedClearances = new Set(chain.ofKind(runDir, 'clearance').map((r) => r.payload.glob));
    try {
      const cm = JSON.parse(fs.readFileSync(clearancesPath(runDir), 'utf8'));
      for (const entry of cm.cleared || []) {
        if (!sealedClearances.has(entry.glob)) {
          problems.push(
            `FORGED CLEARANCE: clearances.json grants "${entry.glob}", which no sealed clearance record backs — ` +
              `the mirror was written around ledger.js. Risk-tier edits under it were let through on a clearance that never happened`
          );
        }
      }
    } catch {
      // No mirror, or an unreadable one, grants nothing: the hook denies without it, so there
      // is no forged exemption to report.
    }

    // Claims that carry no weight. These are not tampering — they are a run whose receipts do
    // not support what the report will say, which reads identically unless verify says so.
    const verdictRec = chain.last(runDir, 'verdict');
    if (verdictRec) {
      if (verdictRec.payload.dispatchSource !== 'hook') {
        problems.push(
          `the QA verdict is backed by a SCRIPT-recorded dispatch (seq ${verdictRec.payload.dispatchSeq || '?'}), ` +
            `not one counted by the dispatch_guard hook — the judge's independence is unverified for this run`
        );
      }
    } else if (chain.ofKind(runDir, 'gate').some((r) => r.payload.stage === 'qa')) {
      problems.push('a "qa" stage receipt exists but no verdict was ever sealed — the QA pass did not happen');
    }
    for (const o of openDispatches(runDir)) problems.push(describeOpen(o));
    problems.push(...modelProblems(runDir));
    const verdictsBySeq = new Map();
    for (const r of chain.ofKind(runDir, 'verdict')) {
      const list = verdictsBySeq.get(r.payload.dispatchSeq) || [];
      list.push(r.payload.verdict);
      verdictsBySeq.set(r.payload.dispatchSeq, list);
    }
    for (const [seq, list] of verdictsBySeq) {
      if (list.length > 1) {
        problems.push(
          `the dispatch at seq ${seq} sealed ${list.length} verdicts (${list.join(', ')}) — one judge, one verdict; ` +
            `which of these the judge meant is not in the record`
        );
      }
    }
    for (const r of chain.ofKind(runDir, 'gate')) {
      if (!(r.payload.evidence || []).length && !(STAGE_PROOF[r.payload.stage] || {}).receipt) {
        problems.push(`gate "${r.payload.stage}" (seq ${r.seq}) sealed no evidence — recorded before this was required`);
      }
    }

    // Every sealed evidence file must still hash to what its receipt recorded, unless a later
    // `revise` or `addition` receipt names exactly the content now on disk.
    const reviseRecords = v.records.filter((r) => r.kind === 'revise' || r.kind === 'addition');
    const counted = new Set();
    for (const r of v.records) {
      for (const e of (r.payload && (r.payload.evidence || r.payload.inputs)) || []) {
        const abs = sealedFile(runDir, e.file);
        let now = null;
        try {
          now = chain.sha256File(abs);
        } catch {
          problems.push(`TAMPERED: ${e.file}, sealed by the ${r.kind}${r.payload.stage ? ` "${r.payload.stage}"` : ''} receipt (seq ${r.seq}), is now missing`);
          continue;
        }
        if (now === e.sha256) continue;

        const accounted = reviseRecords
          .filter((rv) => rv.seq > r.seq && rv.payload.sha256 === now && samePath(sealedFile(runDir, rv.payload.file), abs))
          .pop();
        if (!accounted) {
          problems.push(`TAMPERED: ${e.file} changed after it was sealed by the ${r.kind} receipt (seq ${r.seq})`);
          continue;
        }
        const key = `${accounted.seq}|${e.file}`;
        if (counted.has(key)) continue;
        counted.add(key);
        revisions.push({
          file: e.file,
          reason: accounted.payload.reason,
          seq: accounted.seq,
          sealedBy: `${r.kind}${r.payload.stage ? ` "${r.payload.stage}"` : ''} (seq ${r.seq})`,
        });
      }
    }
  }

  const report = {
    runDir,
    chainDir: chain.resolveChainDir(runDir).dir,
    records: v.records.length,
    intact: problems.length === 0,
    problems,
    // Accounted-for edits to sealed documents — not problems, but the report prints them.
    revisions,
    counters: v.ok ? counters(runDir) : null,
    completeness: v.ok ? completeness(runDir) : null,
  };
  return report;
}

// Whether the run did what it set out to, which `intact` does not say: a run that closed with
// every criterion FAILED, or with only a report gate, has an intact record of not passing.
// Close stays permissive — an unfinished run must still be closable — so this is read by
// whatever acts on a pass (export's attestation, publish, CI).
function completeness(runDir) {
  const verdict = (chain.last(runDir, 'verdict') || { payload: {} }).payload.verdict || null;
  const checks = chain.ofKind(runDir, 'check');
  const criteria = frozenCriteria(runDir).map((c) => {
    const last = checks.filter((r) => r.payload.id === c.id).pop();
    return { id: c.id, result: last ? last.payload.result : 'unchecked', by: last ? last.payload.by : null };
  });
  const passed =
    PASSING_VERDICTS.includes(verdict) &&
    criteria.length > 0 &&
    criteria.every((c) => c.result === 'PASS' && c.by !== 'asserted');
  return { verdict, frozenCriteria: criteria.length, criteria, passed };
}

function cmdVerify(runDir) {
  const report = integrityReport(runDir);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.intact ? 0 : 4);
}

function cmdKeygen() {
  const made = attest.keygen();
  if (made.error) {
    console.error(`ledger keygen: ${made.error}`);
    process.exit(1);
  }
  console.log(`ledger: signing key written to ${made.priv}\n  public key: ${made.pub}\n  key id: ${made.keyId}`);
  console.log('  Give the key id to whoever verifies your bundles; keep the private key off shared machines.');
}

function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// A closed run, signed. The HMAC seals prove the record to this machine; the signature proves
// the same records to anyone holding the public key, from the moment of export.
function cmdExport(runDir, out, worktree) {
  if (!out) {
    console.error('ledger export: --out <file> is required');
    process.exit(1);
  }
  if (!chain.exists(runDir)) {
    console.error(`ledger export: no receipt chain for ${runDir}`);
    process.exit(1);
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(closedPath(runDir), 'utf8'));
  } catch {
    console.error(`ledger export: ${runDir} is not closed — only a finished run is attested. Close it first.`);
    process.exit(3);
  }
  const v = chain.verify(runDir);
  if (!v.ok) {
    console.error(`ledger export: the chain does not verify, so there is nothing trustworthy to sign:\n- ${v.problems.join('\n- ')}`);
    process.exit(4);
  }
  const signer = attest.loadSigner();
  if (signer.error) {
    console.error(`ledger export: ${signer.error}`);
    process.exit(1);
  }
  // Seals and links verifying is not enough: a run whose evidence changed after it was sealed
  // would be signed as it now stands, and the signature would launder the change.
  const integrity = integrityReport(runDir);
  if (!integrity.intact) {
    console.error(`ledger export: the run's integrity check is not intact, so nothing is signed:\n- ${integrity.problems.join('\n- ')}`);
    process.exit(4);
  }
  const c = counters(runDir);
  const ticket = path.basename(path.resolve(runDir));
  const headLines = gitLines(worktree || '.', ['rev-parse', '--verify', '--quiet', `ticket/${ticket}`]);
  const reportFile = path.join(runDir, 'report.md');
  const records = v.records;
  const attestation = {
    format: ATTESTATION_FORMAT,
    ticket,
    pluginVersion: pluginVersion(),
    baseSha: c.baseSha,
    headSha: headLines && headLines[0] ? headLines[0].trim() : null,
    closedAt: marker.closedAt || null,
    records: records.length,
    chainDigest: digestOf(records),
    lastSeal: records.length ? records[records.length - 1].hmac : null,
    report: fs.existsSync(reportFile) ? { file: 'report.md', sha256: chain.sha256File(reportFile) } : null,
    verdict: c.verdict,
    dispatches: c.dispatches,
    dispatchesDied: c.dispatchesDied,
    integrity: { intact: integrity.intact, problems: integrity.problems },
    completeness: integrity.completeness,
    signedAt: new Date().toISOString(),
    keyId: signer.keyId,
  };
  const bundle = {
    attestation,
    signature: attest.sign(signer.privateKey, chain.canonical(attestation)),
    publicKey: signer.publicKey,
    records,
  };
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n');
  console.log(
    `ledger: ${ticket} exported to ${out} — ${records.length} record(s), verdict ${c.verdict || 'none'}, integrity intact, ` +
      `${integrity.completeness.passed ? 'passed' : 'did not pass'}, signed by key ${signer.keyId}`
  );
}

// Collect repeated "--flag value" pairs and strip them from the positional args.
function takeFlag(argv, flag) {
  const values = [];
  for (let i = argv.length - 1; i >= 0; i--) {
    if (argv[i] === flag && argv[i + 1] !== undefined) {
      values.unshift(argv[i + 1]);
      argv.splice(i, 2);
    }
  }
  return values;
}

function main() {
  const argv = process.argv.slice(2);
  const restart = argv.includes('--restart');
  if (restart) argv.splice(argv.indexOf('--restart'), 1);
  const offBase = takeFlag(argv, '--off-base')[0];
  const source = takeFlag(argv, '--source')[0];
  const promptChars = takeFlag(argv, '--prompt-chars')[0];
  const checkMethod = takeFlag(argv, '--by')[0];
  const checkCwd = takeFlag(argv, '--cwd')[0];
  const timeoutMs = takeFlag(argv, '--timeout-ms')[0];
  const worktree = takeFlag(argv, '--worktree')[0];
  const baseRef = takeFlag(argv, '--base')[0];
  const evidence = takeFlag(argv, '--evidence');
  const inputs = takeFlag(argv, '--inputs');
  const revisionReason = takeFlag(argv, '--reason')[0];
  const tokens = takeFlag(argv, '--tokens')[0];
  const ms = takeFlag(argv, '--ms')[0];
  const agentId = takeFlag(argv, '--agent')[0];
  const agentType = takeFlag(argv, '--type')[0];
  const messageChars = takeFlag(argv, '--message-chars')[0];
  const session = takeFlag(argv, '--session')[0];
  const forgeable = argv.includes('--forgeable');
  if (forgeable) argv.splice(argv.indexOf('--forgeable'), 1);
  const approvalArgs = {
    question: takeFlag(argv, '--question')[0],
    choice: takeFlag(argv, '--choice')[0],
    choiceText: takeFlag(argv, '--choice-text')[0],
    channel: takeFlag(argv, '--channel')[0],
    sender: takeFlag(argv, '--sender')[0],
    nonce: takeFlag(argv, '--nonce')[0],
    forgeable,
  };
  const approvalSeq = takeFlag(argv, '--approval')[0];
  const consentAnswers = { push: takeFlag(argv, '--push')[0], pr: takeFlag(argv, '--pr')[0], ticket: takeFlag(argv, '--ticket')[0] };
  const model = takeFlag(argv, '--model')[0];
  const outFile = takeFlag(argv, '--out')[0];
  const sliceFiles = takeFlag(argv, '--files');
  const [cmd, runDir, ...rest] = argv;

  // Takes no runDir: it is the compatibility probe the hooks run before trusting this script.
  if (cmd === 'protocol') {
    process.stdout.write(`${LEDGER_PROTOCOL}\n`);
    return;
  }
  if (cmd === 'keygen') return cmdKeygen();

  // `qascope --base <ref>` reviews a diff with no run behind it, so it takes no runDir.
  if (!cmd || (!runDir && !(cmd === 'qascope' && baseRef))) {
    console.error(
      'usage: ledger.js init <runDir> [baseSha] [--restart] | dispatch <runDir> [label] | replan <runDir> [reason]\n' +
        '       ledger.js qascope <runDir> | qascope --base <ref> [--worktree <path>]\n' +
        '       ledger.js gate <runDir> <stage> [--evidence <file>]... | require <runDir> <stage>\n' +
        '       ledger.js check <runDir> <id> <PASS|FAIL|SKIPPED> --by <command|observed|human|asserted> [note]\n' +
        '                 --by command also takes --cwd <dir> [--timeout-ms <n>]: the ledger runs the frozen run: command\n' +
        '       ledger.js verdict <runDir> <verdict> [--inputs <file>]...\n' +
        '       ledger.js close <runDir> | archive <runDir> | status <runDir> | verify <runDir> | protocol\n' +
        '       ledger.js keygen | export <runDir> --out <file> [--worktree <path>]\n' +
        '       ledger.js approval <runDir> --question <q> --choice <n> --channel <c> --sender <s> --nonce <x> [--forgeable]\n' +
        '       ledger.js raise <runDir> --tokens <n> "<reason>" [--approval <seq>]\n' +
        '       ledger.js consent <runDir> --push yes|no --pr yes|no --ticket yes|no "<who answered>" [--approval <seq>]\n' +
        '       ledger.js cost <runDir> [--worktree <path>] | clear <runDir> <glob> <reason>\n' +
        '       ledger.js revise <runDir> <file> --reason "<why>"\n' +
        '       ledger.js outcome <runDir> <dispatchSeq> <ok|died> [note] [--tokens <n>] [--ms <n>]\n' +
        '       ledger.js returned <runDir> [--agent <id>] [--type <agentType>] [--message-chars <n>] [--session <id>]\n' +
        '       ledger.js slice <runDir> <id> --files <glob>[,<glob>]...\n' +
        '       ledger.js addition <runDir> "- [ ] C<n> (kind): <criterion> | run: <command>"'
    );
    process.exit(1);
  }

  switch (cmd) {
    case 'init':
      return cmdInit(runDir, rest[0], { restart, offBase });
    case 'dispatch':
      return cmdDispatch(runDir, rest.join(' '), { source, promptChars, session, model });
    case 'replan':
      return cmdReplan(runDir, rest.join(' '));
    case 'gate':
      return cmdGate(runDir, rest[0], evidence);
    case 'require':
      return cmdRequire(runDir, rest[0]);
    case 'check':
      return cmdCheck(runDir, rest[0], rest[1], checkMethod, rest.slice(2).join(' '), { cwd: checkCwd, timeoutMs });
    case 'verdict':
      return cmdVerdict(runDir, rest[0], inputs);
    case 'close':
      return cmdClose(runDir);
    case 'archive':
      return cmdArchive(runDir);
    case 'status':
      return cmdStatus(runDir);
    case 'cost':
      return cmdCost(runDir, worktree);
    case 'qascope':
      return cmdQaScope(runDir, worktree, baseRef);
    case 'clear':
      return cmdClear(runDir, rest[0], rest.slice(1).join(' '), approvalSeq);
    case 'approval':
      return cmdApproval(runDir, approvalArgs);
    case 'consent':
      return cmdConsent(runDir, consentAnswers, rest.join(' '), approvalSeq);
    case 'raise':
      return cmdRaise(runDir, tokens, rest.join(' '), approvalSeq);
    case 'revise':
      return cmdRevise(runDir, rest[0], revisionReason);
    case 'outcome':
      return cmdOutcome(runDir, rest[0], rest[1], rest.slice(2).join(' '), { tokens, ms });
    case 'returned':
      return cmdReturned(runDir, { agentId, agentType, messageChars, session });
    case 'slice':
      return cmdSlice(runDir, rest[0], sliceFiles);
    case 'addition':
      return cmdAddition(runDir, rest.join(' '));
    case 'verify':
      return cmdVerify(runDir);
    case 'export':
      return cmdExport(runDir, outFile, worktree);
    default:
      console.error(`ledger.js: unknown command "${cmd}"`);
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  counters,
  caps,
  dispatchCount,
  openDispatches,
  closedPath,
  isClosed,
  integrityReport,
  completeness,
  readConfig,
  publishAllowed,
  PUBLISH_ACTS,
  PASSING_VERDICTS,
  STAGES,
  VERDICTS,
  LEDGER_PROTOCOL,
};
