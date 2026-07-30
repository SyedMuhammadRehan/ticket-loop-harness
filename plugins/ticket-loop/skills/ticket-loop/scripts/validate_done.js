#!/usr/bin/env node
// Mechanical validation of a done-list draft — and, when the run produced an
// approach.md (Stage 2.5), of the approach's contract with it: every recorded failure
// mode must be covered by a criterion or explicitly out-of-scope.
'use strict';
const fs = require('fs');
const path = require('path');

const runDir = process.argv[2];
if (!runDir) { console.error('usage: validate_done.js <runDir>'); process.exit(1); }
const draft = path.join(runDir, 'done.draft.md');
if (!fs.existsSync(draft)) { console.error(`missing ${draft}`); process.exit(1); }

const text = fs.readFileSync(draft, 'utf8');
const section = (name, src = text) => {
  const parts = src.split(/^## /m);
  const hit = parts.find((p) => p.toLowerCase().startsWith(name.toLowerCase()));
  return hit ? hit.slice(name.length) : '';
};
// A duplicated heading would let a second, unvalidated block hide behind the first.
const duplicateHeadings = (names, src) =>
  names.filter((n) => {
    const re = new RegExp(`^## ${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'gim');
    return (src.match(re) || []).length > 1;
  });
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

for (const dup of duplicateHeadings(['Criteria', 'Tokens', 'Out of scope'], text)) {
  errors.push(`done.draft.md: duplicate "## ${dup}" heading — only the first would be validated`);
}

// --- Approach contract (only when Stage 2.5 produced one) ---
const approachFile = path.join(runDir, 'approach.md');
if (fs.existsSync(approachFile)) {
  const aText = fs.readFileSync(approachFile, 'utf8');

  for (const dup of duplicateHeadings(['Options', 'Chosen', 'Failure modes'], aText)) {
    errors.push(`approach.md: duplicate "## ${dup}" heading — new findings go under "## Revisions", not a second block`);
  }

  const options = bullets(section('Options', aText));
  if (options.length < 2) {
    errors.push(`approach.md: need >=2 options (a design with no considered alternative is a guess), found ${options.length}`);
  }
  if (bullets(section('Chosen', aText)).length < 1) {
    errors.push('approach.md: "## Chosen" is empty — record which option won and why');
  }

  const failureModes = bullets(section('Failure modes', aText));
  if (failureModes.length < 1) {
    errors.push('approach.md: "## Failure modes" is empty — name at least one, or one out-of-scope with reason');
  }
  for (const fm of failureModes) {
    // out-of-scope REQUIRES a parenthesized reason — a bare tag is a silent opt-out.
    const m = fm.match(/\|\s*covered-by:\s*(C\d+\b|out-of-scope\s*\(.+\))/i);
    if (!m) {
      errors.push(`approach.md: failure mode needs "| covered-by: C<n>" or "| covered-by: out-of-scope (<reason>)": ${fm}`);
      continue;
    }
    const target = m[1].toUpperCase();
    if (target.startsWith('C') && !criteria.some((c) => new RegExp(`\\b${target}\\b`).test(c))) {
      errors.push(`approach.md: failure mode covered-by ${target}, but the draft has no criterion ${target}: ${fm}`);
    }
  }
}

if (errors.length) { console.error('done-list INVALID:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log(fs.existsSync(approachFile) ? 'done-list valid (approach contract checked)' : 'done-list valid');
process.exit(0);
