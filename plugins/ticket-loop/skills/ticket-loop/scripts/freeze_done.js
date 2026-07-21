#!/usr/bin/env node
// Freeze a validated draft: done.draft.md -> done.md + done.approved.md.
'use strict';
const fs = require('fs');
const path = require('path');

const runDir = process.argv[2];
if (!runDir) { console.error('usage: freeze_done.js <runDir>'); process.exit(1); }
const draft = path.join(runDir, 'done.draft.md');
const done = path.join(runDir, 'done.md');
const approved = path.join(runDir, 'done.approved.md');
const additions = path.join(runDir, 'done-additions.md');

if (fs.existsSync(done)) { console.error(`refusing: ${done} already exists (already frozen)`); process.exit(1); }
if (!fs.existsSync(draft)) { console.error(`missing ${draft}`); process.exit(1); }

fs.renameSync(draft, done);
fs.copyFileSync(done, approved);
if (!fs.existsSync(additions)) {
  fs.writeFileSync(additions, '# Done additions (additive only — never remove or weaken criteria)\n');
}
console.log(`frozen: ${done} + ${approved}`);
process.exit(0);
