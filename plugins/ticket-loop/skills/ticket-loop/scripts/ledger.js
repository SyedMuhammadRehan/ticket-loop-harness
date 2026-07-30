#!/usr/bin/env node
// Mechanical budget + stage-receipt enforcement (zero deps).
//
// The counters are derived from the HMAC-sealed receipt chain in <gitdir>/ticket-loop/,
// NOT from budget.json. budget.json is a human-readable MIRROR: editing it changes
// nothing, and `verify` reports the disagreement. The caps themselves are recorded in the
// chain's init receipt, so raising them by editing a file no longer works.
//
//   ledger.js init <runDir> [baseSha] [--restart]  create the chain (refuses to reset)
//   ledger.js dispatch <runDir> [label]            +1 dispatch; exit 2 at the cap
//   ledger.js replan <runDir> [reason]             +1 re-plan;  exit 2 at the cap
//   ledger.js gate <runDir> <stage> [--evidence f] record that a stage completed
//   ledger.js require <runDir> <stage>             exit 3 unless that stage was recorded
//   ledger.js check <runDir> <id> <PASS|FAIL> [n]  record a verification result
//   ledger.js verdict <runDir> <v> [--inputs f]    record the QA verdict + what it judged
//   ledger.js close <runDir>                       end the run (needs a report receipt)
//   ledger.js archive <runDir>                     sanctioned CLEAN-RESTART move
//   ledger.js status <runDir>                      counters as JSON
//   ledger.js verify <runDir>                      chain integrity + tamper report
//   ledger.js protocol                             compatibility probe for the hooks
'use strict';
const fs = require('fs');
const path = require('path');
const chain = require('./chain.js');

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

// What each stage must show before its receipt is recorded. Evidence used to be optional, so
// all ten gates plus an APPROVE verdict were eleven free commands that left `verify` reporting
// `intact: true, problems: []` over a run in which nothing happened — and `require <stage>`
// proved only that someone had typed `ledger.js gate`.
//
// `artifact` = the file the stage cannot have happened without, which must be among --evidence
// (hashEvidence already refuses files that do not exist). `receipt` = a stage whose product is
// another sealed record rather than a file, bound to that record instead.
const STAGE_PROOF = {
  intake: { artifact: 'ticket-brief.md' },
  survey: { artifact: 'codebase-map.md' },
  design: { artifact: 'design-spec.md' },
  approach: { artifact: 'approach.md' },
  validate: { receipt: 'validate', how: 'run validate_done.js against the draft — it seals the receipt' },
  freeze: { artifact: 'done.md' },
  implement: { anyEvidence: true, how: 'seal the diff, the ledger, or the files the slices touched' },
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
// It is deliberately NOT report.md. The hooks used to read the presence of report.md as "the
// run is over", which meant the one file Stage 7 tells the orchestrator to write first also
// switched off the budget, unlocked the hook sources and made the stop gate's missing-config
// block inert — reachable with an ordinary Write, uncounted, and invisible to `verify`. Ending
// a run is now an explicit act that requires a report receipt in the sealed chain, and the
// marker itself is write-protected by freeze_guard.
function closedPath(runDir) {
  return path.join(runDir, 'closed.json');
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

function counters(runDir) {
  const { maxDispatches, maxReplans, baseSha } = caps(runDir);
  const d = dispatchCount(runDir);
  return {
    dispatches: d.count,
    replans: chain.ofKind(runDir, 'replan').length,
    maxDispatches,
    maxReplans,
    baseSha,
    dispatchesByHook: d.byHook,
    dispatchesByScript: d.byScript,
    gates: chain.ofKind(runDir, 'gate').map((r) => r.payload.stage),
    verdict: (chain.last(runDir, 'verdict') || { payload: {} }).payload.verdict || null,
  };
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
  return v;
}

function cmdInit(runDir, baseSha, opts) {
  fs.mkdirSync(runDir, { recursive: true });

  // A chain that is GONE is not the same as a run that never started. `rm -rf` on the chain dir
  // followed by `init` used to zero every counter and every receipt and still report
  // `intact: true` — the refusal below only fired when a chain was present. budget.json is the
  // one trace the chain leaves inside the run dir, and freeze_guard protects it, so its presence
  // without a chain is the signature of a deleted history.
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

  const { inGit } = chain.resolveChainDir(runDir);
  chain.append(runDir, 'init', {
    baseSha: baseSha || null,
    maxDispatches: MAX_DISPATCHES,
    maxReplans: MAX_REPLANS,
    evidence: configSealed,
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
  const { maxDispatches } = caps(runDir);
  const { count } = dispatchCount(runDir);
  if (count >= maxDispatches) {
    console.error(
      `HARD BUDGET: ${count}/${maxDispatches} dispatches used — do NOT dispatch. Go to Stage 7 with status INCOMPLETE.`
    );
    process.exit(2);
  }
  chain.append(runDir, 'dispatch', { label: label || null, source: opts && opts.source ? opts.source : 'script' });
  mirrorBudget(runDir);
  console.log(`ledger: dispatch OK — ${dispatchCount(runDir).count}/${maxDispatches} used`);
}

function cmdReplan(runDir, reason) {
  requireChain(runDir);
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
  if (proof.artifact && !hashed.some((e) => path.basename(e.file) === proof.artifact)) {
    refuse(
      `no ${proof.artifact} among the sealed evidence. Pass it: ` +
        `--evidence ${path.join(runDir, proof.artifact)}. A stage receipt with nothing attached ` +
        `attests only that this command ran.`
    );
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

function cmdCheck(runDir, id, result, note) {
  requireChain(runDir);
  const normalized = String(result || '').toUpperCase();
  if (!CHECK_RESULTS.includes(normalized)) {
    console.error(`ledger check: result must be one of ${CHECK_RESULTS.join(', ')}`);
    process.exit(1);
  }
  chain.append(runDir, 'check', { id, result: normalized, note: note || null });
  const history = chain.ofKind(runDir, 'check').filter((r) => r.payload.id === id).map((r) => r.payload.result);
  console.log(`ledger: check ${id} ${normalized} — history: ${history.join(' → ')}`);
}

// A verdict is a claim that an independent judge read the frozen contract. Two things now have
// to hold: the frozen contract is among the sealed inputs, and a subagent was actually
// dispatched after the freeze. Neither proves WHICH process typed the verdict — process
// identity is not available here — but together they rule out the cheap version, which was
// `ledger.js verdict <run> APPROVE` with no inputs and no judge.
function cmdVerdict(runDir, verdict, inputs) {
  requireChain(runDir);
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
  if (!hashed.some((e) => path.basename(e.file) === 'done.approved.md')) {
    console.error(
      `ledger verdict: refusing to record a verdict that does not seal the frozen contract.\n` +
        `  Pass --inputs ${path.join(runDir, 'done.approved.md')} (and done-additions.md). ` +
        `A verdict over nothing cannot show which contract was judged.`
    );
    process.exit(1);
  }

  const freeze = chain.ofKind(runDir, 'gate').find((r) => r.payload.stage === 'freeze');
  if (!freeze) {
    console.error(`ledger verdict: refusing — nothing has been frozen yet, so there is no contract to judge.`);
    process.exit(1);
  }
  const judgeDispatch = chain.ofKind(runDir, 'dispatch').filter((r) => r.seq > freeze.seq).pop();
  if (!judgeDispatch) {
    console.error(
      `ledger verdict: refusing — no subagent was dispatched after the freeze (seq ${freeze.seq}), ` +
        `so no fresh-context judge can have run.\n` +
        `  Dispatch the QA agent with prompts/qa_agent.md and let it record the verdict itself.`
    );
    process.exit(3);
  }

  const source = (judgeDispatch.payload && judgeDispatch.payload.source) || 'script';
  chain.append(runDir, 'verdict', {
    verdict: normalized,
    inputs: hashed,
    dispatchSeq: judgeDispatch.seq,
    dispatchSource: source,
  });
  console.log(
    `ledger: verdict ${normalized} recorded (${hashed.length} judged input(s) sealed, ` +
      `backed by the dispatch at seq ${judgeDispatch.seq}${source === 'hook' ? '' : ' — SCRIPT-sourced, see verify'})`
  );
}

// Ending the run has to cost a receipt, or it is just another file the orchestrator can write
// to get out from under the gates.
function cmdClose(runDir) {
  requireChain(runDir);
  if (fs.existsSync(closedPath(runDir))) {
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
  const records = chain.records(runDir);
  const marker = {
    '//': 'END-OF-RUN MARKER — written only by ledger.js close. Deleting it re-opens the run under the hooks; forging it is a tampering event, not a shortcut.',
    closedAt: new Date().toISOString(),
    reportGateSeq: reportGate.seq,
    chainRecords: records.length,
    lastSeal: records.length ? records[records.length - 1].hmac : null,
  };
  fs.writeFileSync(closedPath(runDir), JSON.stringify(marker, null, 2) + '\n');
  console.log(
    `ledger: closed ${runDir} (report receipt seq ${reportGate.seq}, ${records.length} records). ` +
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

function cmdStatus(runDir) {
  requireChain(runDir);
  process.stdout.write(JSON.stringify(counters(runDir), null, 2) + '\n');
}

// The Stage-7 integrity report: chain intact? mirror in step? frozen artifacts unchanged
// since their receipts? This is what makes "no tampering" checkable instead of asserted.
function cmdVerify(runDir) {
  const v = chain.verify(runDir);
  const problems = [...v.problems];

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
    for (const r of chain.ofKind(runDir, 'gate')) {
      if (!(r.payload.evidence || []).length && !(STAGE_PROOF[r.payload.stage] || {}).receipt) {
        problems.push(`gate "${r.payload.stage}" (seq ${r.seq}) sealed no evidence — recorded before this was required`);
      }
    }

    // Every sealed evidence file must still hash to what its receipt recorded.
    for (const r of v.records) {
      for (const e of (r.payload && (r.payload.evidence || r.payload.inputs)) || []) {
        const abs = path.isAbsolute(e.file) ? e.file : path.join(process.cwd(), e.file);
        let now = null;
        try {
          now = chain.sha256File(abs);
        } catch {
          problems.push(`${r.kind}${r.payload.stage ? ` "${r.payload.stage}"` : ''} sealed ${e.file}, which is now missing`);
          continue;
        }
        if (now !== e.sha256) {
          problems.push(`TAMPERED: ${e.file} changed after it was sealed by the ${r.kind} receipt (seq ${r.seq})`);
        }
      }
    }
  }

  const report = {
    runDir,
    chainDir: chain.resolveChainDir(runDir).dir,
    records: v.records.length,
    intact: problems.length === 0,
    problems,
    counters: v.ok ? counters(runDir) : null,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(problems.length === 0 ? 0 : 4);
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
  const source = takeFlag(argv, '--source')[0];
  const evidence = takeFlag(argv, '--evidence');
  const inputs = takeFlag(argv, '--inputs');
  const [cmd, runDir, ...rest] = argv;

  // Takes no runDir: it is the compatibility probe the hooks run before trusting this script.
  if (cmd === 'protocol') {
    process.stdout.write(`${LEDGER_PROTOCOL}\n`);
    return;
  }

  if (!cmd || !runDir) {
    console.error(
      'usage: ledger.js init <runDir> [baseSha] [--restart] | dispatch <runDir> [label] | replan <runDir> [reason]\n' +
        '       ledger.js gate <runDir> <stage> [--evidence <file>]... | require <runDir> <stage>\n' +
        '       ledger.js check <runDir> <id> <PASS|FAIL|SKIPPED> [note] | verdict <runDir> <verdict> [--inputs <file>]...\n' +
        '       ledger.js close <runDir> | archive <runDir> | status <runDir> | verify <runDir> | protocol'
    );
    process.exit(1);
  }

  switch (cmd) {
    case 'init':
      return cmdInit(runDir, rest[0], { restart });
    case 'dispatch':
      return cmdDispatch(runDir, rest.join(' '), { source });
    case 'replan':
      return cmdReplan(runDir, rest.join(' '));
    case 'gate':
      return cmdGate(runDir, rest[0], evidence);
    case 'require':
      return cmdRequire(runDir, rest[0]);
    case 'check':
      return cmdCheck(runDir, rest[0], rest[1], rest.slice(2).join(' '));
    case 'verdict':
      return cmdVerdict(runDir, rest[0], inputs);
    case 'close':
      return cmdClose(runDir);
    case 'archive':
      return cmdArchive(runDir);
    case 'status':
      return cmdStatus(runDir);
    case 'verify':
      return cmdVerify(runDir);
    default:
      console.error(`ledger.js: unknown command "${cmd}"`);
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { counters, caps, dispatchCount, closedPath, STAGES, VERDICTS, LEDGER_PROTOCOL };
