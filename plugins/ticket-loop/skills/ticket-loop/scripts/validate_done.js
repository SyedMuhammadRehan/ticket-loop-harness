#!/usr/bin/env node
// Mechanical validation of a done-list draft, of the approach contract behind it, and — on
// success — the receipt that lets freeze_done.js accept the draft.
//
// WHY the extra checks: the earlier version accepted a contract that was green by
// construction. Two identical analyzer criteria plus a non-empty out-of-scope line passed as
// "valid" with no behavioural test anywhere, criteria could be pre-ticked before any code
// existed, and ids could repeat. Those are hard failures now.
//
// WHAT THE `run:` CHECK DOES NOT CATCH — do not read it as more than it is. It compares only the
// first token's basename against the profile's verify binary, so it rejects the WRONG tool and
// accepts any neutered invocation of the right one:
//     run: {verify.test} --grep no-such-test     passes, runs zero tests
//     run: {verify.test} || true                 passes, cannot fail
//     run: true    for an (analyzer) criterion    passes whenever verify.analyze is null
//     run: playwright:<id>                       not checked at all (NON_COMMAND_RUNNERS)
// Catching those needs the criterion to be executed and observed failing, which this script
// cannot do. The QA judge is asked to look for it (prompts/qa_agent.md, "a criterion whose run:
// command could not actually detect the behaviour failing") — that is judgement, not a check.
'use strict';
const fs = require('fs');
const path = require('path');
const chain = require('./chain.js');
const { resolve: resolveConfig } = require('./load_config.js');

const KINDS = ['test', 'analyzer', 'runtime', 'token', 'manual'];
const MIN_OUT_OF_SCOPE_REASON = 8;
// Non-shell criterion runners that are checked by a tool rather than a config command.
const NON_COMMAND_RUNNERS = /^(playwright|browser|manual):/i;

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: validate_done.js <runDir>');
  process.exit(1);
}
const draftPath = path.join(runDir, 'done.draft.md');
if (!fs.existsSync(draftPath)) {
  console.error(`missing ${draftPath}`);
  process.exit(1);
}

const text = fs.readFileSync(draftPath, 'utf8');

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
const kindOf = (l) => {
  const m = l.match(/\((test|analyzer|runtime|token|manual)\)/);
  return m ? m[1] : null;
};
const idOf = (l) => {
  const m = l.match(/-\s*\[[ xX]\]\s*(C\d+)\b/);
  return m ? m[1].toUpperCase() : null;
};
const runOf = (l) => {
  const m = l.match(/\|\s*run:\s*(.+)$/);
  return m ? m[1].trim() : null;
};

const nonManual = criteria.filter((l) => kindOf(l) && kindOf(l) !== 'manual');
const manual = criteria.filter((l) => kindOf(l) === 'manual');
const unkinded = criteria.filter((l) => !kindOf(l));

if (nonManual.length < 2) errors.push(`need >=2 non-manual criteria, found ${nonManual.length}`);
if (manual.length > 1) errors.push(`max 1 manual criterion, found ${manual.length}`);
if (unkinded.length > 0) errors.push(`criteria missing (kind): ${unkinded.join(' | ')}`);

// A contract with nothing that exercises behaviour is not a contract. Analyzer-only
// done-lists were the cheapest way to make a run trivially green.
const behavioural = criteria.filter((l) => ['test', 'runtime'].includes(kindOf(l)));
if (behavioural.length < 1) {
  errors.push(
    'no (test) or (runtime) criterion — a done-list of analyzer/token checks proves nothing about behaviour'
  );
}

// Ids must exist, be well-formed, and be unique: duplicates make evidence ambiguous and let
// one passing check stand in for another in the report.
const seen = new Map();
criteria.forEach((l) => {
  const id = idOf(l);
  if (!id) {
    errors.push(`criterion has no "C<n>" id: ${l}`);
    return;
  }
  if (seen.has(id)) errors.push(`duplicate criterion id ${id} — ids must be unique: ${l}`);
  seen.set(id, l);
});

// A frozen contract describes work that has NOT happened yet.
const preTicked = criteria.filter((l) => /-\s*\[[xX]\]/.test(l));
if (preTicked.length) {
  errors.push(`criteria are already ticked before the freeze: ${preTicked.map((l) => idOf(l) || l).join(', ')}`);
}

for (const l of nonManual) {
  if (!/\|\s*run:\s*\S/.test(l)) errors.push(`non-manual criterion missing "| run:" command: ${l}`);
}

// `run:` must name the command the repo actually verifies with, so a criterion cannot
// self-certify via a stand-in like `run: true` or `run: echo ok`.
const cfg = resolveConfig();
const firstToken = (cmd) => String(cmd).trim().split(/\s+/)[0].replace(/^.*[\/\\]/, '');
const expectedFor = { test: cfg.verify && cfg.verify.test, analyzer: cfg.verify && cfg.verify.analyze };
// The bare verify command reports absolute state, so against a non-empty baseline it fails
// whether or not this change added anything — the criterion cannot decide itself.
const BASELINE_RELATIVE = /\b(no new|not grow|doesn't grow|does not grow|subset of|baseline|branch[- ]?point|pre-existing)\b/i;
const TRIVIAL_RUNNER = /^(true|false|:|echo|exit|ls|cd)\b/;
// firstToken reads both `npx eslint .` and `npx eslint-delta` as "npx", so find the tool.
const LAUNCHERS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'bun', 'node', 'python', 'python3', 'dotnet', 'run', 'exec']);
const toolOf = (cmd) => {
  const tokens = String(cmd).trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
  const tool = tokens.find((t, i) => i > 0 || !LAUNCHERS.has(firstToken(t))) || tokens[0] || '';
  return firstToken(tool);
};
for (const l of nonManual) {
  const kind = kindOf(l);
  const run = runOf(l);
  if (!run) continue;
  if (NON_COMMAND_RUNNERS.test(run)) continue;
  const expected = expectedFor[kind === 'token' ? 'test' : kind];
  if (!expected) continue; // nothing configured to compare against; load_config already warns
  const id = idOf(l) || '?';
  const field = kind === 'analyzer' ? 'verify.analyze' : 'verify.test';

  if (BASELINE_RELATIVE.test(l)) {
    // Exempt from the same-command rule below: this is the case that needs a different one.
    if (toolOf(run) === toolOf(expected)) {
      errors.push(
        `criterion ${id} is measured against a baseline, but "${run}" reports absolute state and ` +
          `cannot decide it — on a repo with pre-existing findings it fails either way. Name a ` +
          `command that performs the comparison, or restate the criterion so the command's own ` +
          `result settles it`
      );
    } else if (TRIVIAL_RUNNER.test(run)) {
      errors.push(`criterion ${id} runs "${run}", which decides nothing`);
    }
    continue;
  }

  if (firstToken(run) !== firstToken(expected)) {
    errors.push(
      `criterion ${id} (${kind}) runs "${run}" but this repo's ${field} ` +
        `is "${expected}" — a criterion must be checked by the real command, not a stand-in`
    );
  }
}

// "No tokens" must be sayable: without a marker, the only way past the source-required rule
// is to un-bullet the line until this check stops seeing it. Anchored so it is the WHOLE
// bullet — `- none: #B00020` is a token whose name happens to be "none", not a declaration.
const NO_TOKENS = /^-\s*none\s*(\(.*\))?\s*$/i;
const tokens = bullets(section('Tokens'));
const declaredNone = tokens.filter((t) => NO_TOKENS.test(t));
const realTokens = tokens.filter((t) => !NO_TOKENS.test(t));
if (declaredNone.length && realTokens.length) {
  errors.push(
    `Tokens declares "none" and then lists ${realTokens.length} token(s) — say one or the other`
  );
}
// The marker is for a run with no visual contract. Where the profile names a design source,
// "none" would waive every token binding the design stage exists to produce.
if (declaredNone.length && cfg.designSource && cfg.designSource !== 'none') {
  errors.push(
    `Tokens declares "none" but the profile's designSource is "${cfg.designSource}" — ` +
      `a run with a design source must bind its tokens to design-spec.md`
  );
}
for (const t of realTokens) {
  if (!t.includes('(source: design-spec.md')) errors.push(`token without design-spec source: ${t}`);
}

const outOfScope = bullets(section('Out of scope'));
if (outOfScope.length < 1) errors.push('Out of scope section is empty');

for (const dup of duplicateHeadings(['Criteria', 'Tokens', 'Out of scope'], text)) {
  errors.push(`done.draft.md: duplicate "## ${dup}" heading — only the first would be validated`);
}

// --- Approach contract -----------------------------------------------------------------
// Presence of approach.md cannot be what enables the contract, or declaring a ticket
// "trivial" waives it for free. A survey artifact is the orchestrator's own judgement that
// the change is feature-sized, so it makes the approach mandatory.
const approachFile = path.join(runDir, 'approach.md');
const surveyFile = path.join(runDir, 'codebase-map.md');
if (!fs.existsSync(approachFile) && fs.existsSync(surveyFile)) {
  errors.push(
    'codebase-map.md exists (the survey ran, so this change was judged feature-sized) but there is no ' +
      'approach.md — record the design decision before freezing, or delete the survey if the ticket really is trivial'
  );
}

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
  let waived = 0;
  for (const fm of failureModes) {
    // out-of-scope REQUIRES a parenthesized reason — a bare tag is a silent opt-out.
    const m = fm.match(/\|\s*covered-by:\s*(C\d+\b|out-of-scope\s*\((.+)\))/i);
    if (!m) {
      errors.push(`approach.md: failure mode needs "| covered-by: C<n>" or "| covered-by: out-of-scope (<reason>)": ${fm}`);
      continue;
    }
    const target = m[1].toUpperCase();
    if (target.startsWith('OUT-OF-SCOPE')) {
      waived++;
      // "(.)" or "(later)" is not a reason; it is the absence of one wearing the syntax.
      const reason = (m[2] || '').trim();
      if (reason.replace(/[^a-z0-9]/gi, '').length < MIN_OUT_OF_SCOPE_REASON) {
        errors.push(`approach.md: out-of-scope reason "${reason}" is too thin to be a decision — say why, in words: ${fm}`);
      }
      // The done-list has to carry the exclusion too, or the judge never sees it.
      if (outOfScope.length === 0) {
        errors.push('approach.md waives a failure mode as out-of-scope but done.draft.md has no "## Out of scope" entry');
      }
      continue;
    }
    if (!criteria.some((c) => idOf(c) === target)) {
      errors.push(`approach.md: failure mode covered-by ${target}, but the draft has no criterion ${target}: ${fm}`);
    }
  }
  if (failureModes.length > 0 && waived === failureModes.length) {
    errors.push(
      `approach.md: all ${waived} failure mode(s) are waived as out-of-scope — then nothing this design can get ` +
        `wrong is covered by the contract. Cover at least one, or reconsider the scope.`
    );
  }
}

if (errors.length) {
  console.error('done-list INVALID:\n- ' + errors.join('\n- '));
  process.exit(1);
}

// The receipt is what freeze_done.js checks. It seals THIS draft, so editing the draft after
// validating invalidates the receipt and the freeze is refused.
let sealed = false;
if (chain.exists(runDir)) {
  try {
    chain.append(runDir, 'validate', { file: 'done.draft.md', sha256: chain.sha256File(draftPath), criteria: criteria.length });
    sealed = true;
  } catch (e) {
    console.error(`validate_done: could not record the validation receipt (${e.message})`);
    process.exit(1);
  }
}

console.log(
  (fs.existsSync(approachFile) ? 'done-list valid (approach contract checked)' : 'done-list valid') +
    (sealed ? ' — validation receipt sealed' : ' — WARNING: no receipt chain, run "ledger.js init" so the freeze can be verified')
);
process.exit(0);
