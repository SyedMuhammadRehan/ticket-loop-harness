#!/usr/bin/env node
// Mechanical validation of a done-list draft.
'use strict';
const fs = require('fs');
const path = require('path');

const runDir = process.argv[2];
if (!runDir) { console.error('usage: validate_done.js <runDir>'); process.exit(1); }
const draft = path.join(runDir, 'done.draft.md');
if (!fs.existsSync(draft)) { console.error(`missing ${draft}`); process.exit(1); }

const text = fs.readFileSync(draft, 'utf8');
const section = (name) => {
  const parts = text.split(/^## /m);
  const hit = parts.find((p) => p.startsWith(name));
  return hit ? hit.slice(name.length) : '';
};
const bullets = (s) => s.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '));

const errors = [];
const criteria = bullets(section('Criteria'));
const kindOf = (l) => { const m = l.match(/\((test|analyzer|runtime|token|manual)\)/); return m ? m[1] : null; };

const nonManual = criteria.filter((l) => kindOf(l) && kindOf(l) !== 'manual');
const manual = criteria.filter((l) => kindOf(l) === 'manual');
const unkinded = criteria.filter((l) => !kindOf(l));

if (nonManual.length < 2) errors.push(`need >=2 non-manual criteria, found ${nonManual.length}`);
if (manual.length > 1) errors.push(`max 1 manual criterion, found ${manual.length}`);
if (unkinded.length > 0) errors.push(`criteria missing (kind): ${unkinded.join(' | ')}`);
for (const l of nonManual) {
  if (!/\|\s*run:\s*\S/.test(l)) errors.push(`non-manual criterion missing "| run:" command: ${l}`);
}

const tokens = bullets(section('Tokens'));
for (const t of tokens) {
  if (!t.includes('(source: design-spec.md')) errors.push(`token without design-spec source: ${t}`);
}

if (bullets(section('Out of scope')).length < 1) errors.push('Out of scope section is empty');

if (errors.length) { console.error('done-list INVALID:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log('done-list valid');
process.exit(0);
