#!/usr/bin/env node
// Freeze a VALIDATED draft: done.draft.md -> done.md + done.approved.md.
//
// The freeze now requires a validation receipt sealing the exact bytes being frozen. Before,
// validate_done.js was advisory: nothing stopped a draft from being frozen unvalidated, or
// from being edited in between validating and freezing. Both are refused here.
'use strict';
const fs = require('fs');
const path = require('path');
const chain = require('./chain.js');

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: freeze_done.js <runDir>');
  process.exit(1);
}
const draft = path.join(runDir, 'done.draft.md');
const done = path.join(runDir, 'done.md');
const approved = path.join(runDir, 'done.approved.md');
const additions = path.join(runDir, 'done-additions.md');

if (fs.existsSync(done)) {
  console.error(`refusing: ${done} already exists (already frozen)`);
  process.exit(1);
}
if (!fs.existsSync(draft)) {
  console.error(`missing ${draft}`);
  process.exit(1);
}

if (!chain.exists(runDir)) {
  console.error(
    `refusing to freeze: no receipt chain for ${runDir}. Run "ledger.js init ${runDir} <baseSha>" first — ` +
      `a contract that cannot be verified later is not a contract.`
  );
  process.exit(1);
}

const draftHash = chain.sha256File(draft);
const receipts = chain.ofKind(runDir, 'validate');
const matching = receipts.find((r) => r.payload && r.payload.sha256 === draftHash);

if (!matching) {
  if (receipts.length === 0) {
    console.error(
      `refusing to freeze: ${draft} has never been validated. Run ` +
        `"validate_done.js ${runDir}" and fix what it reports.`
    );
  } else {
    console.error(
      `refusing to freeze: ${draft} changed after it was validated ` +
        `(validated ${receipts[receipts.length - 1].payload.sha256.slice(0, 12)}…, now ${draftHash.slice(0, 12)}…). ` +
        `Re-run "validate_done.js ${runDir}" against the current draft.`
    );
  }
  process.exit(1);
}

fs.renameSync(draft, done);
fs.copyFileSync(done, approved);
if (!fs.existsSync(additions)) {
  fs.writeFileSync(additions, '# Done additions (additive only — never remove or weaken criteria)\n');
}

// Seal what was frozen. Stage 7's integrity check compares the files against this receipt,
// so post-freeze edits surface as TAMPERED instead of needing a self-reported diff.
chain.append(runDir, 'gate', {
  stage: 'freeze',
  evidence: chain.hashEvidence([done, approved]),
  validatedBy: matching.seq,
});

console.log(`frozen: ${done} + ${approved} (sealed by validation receipt seq ${matching.seq})`);
process.exit(0);
