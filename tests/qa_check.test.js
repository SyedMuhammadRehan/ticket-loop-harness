'use strict';
// The standalone review is deliberately weaker than the loop's QA stage: no frozen contract, no
// sealed check history, no verdict receipt. That is fine as long as it never reads as though it
// were the strong one, and never writes into a run's evidence. Both of those live in text, so
// this is what holds them there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, SCRIPTS_DIR, runScript } = require('./helpers.js');

const SKILL_DIR = path.join(REPO_ROOT, 'plugins', 'ticket-loop', 'skills', 'qa-check');
const SKILL = path.join(SKILL_DIR, 'SKILL.md');
const PROMPT = path.join(SKILL_DIR, 'prompts', 'qa_check.md');

const skill = () => fs.readFileSync(SKILL, 'utf8');
const prompt = () => fs.readFileSync(PROMPT, 'utf8');

test('the skill has frontmatter that can be routed on', () => {
  const m = skill().match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, 'no YAML frontmatter');
  assert.match(m[1], /name:\s*qa-check/);
  const description = (m[1].match(/description:\s*(.*)/) || [])[1] || '';
  assert.ok(description.length > 40, 'description too thin to route on');
});

test('it dispatches the judge that cannot edit', () => {
  assert.ok(
    skill().includes('ticket-loop-qa'),
    'the standalone review must reuse the read-only judge, not a general-purpose agent'
  );
});

// The whole safety argument for a review with no contract behind it.
test('it forbids writing into a run receipt chain', () => {
  const body = skill();
  assert.ok(/No receipts, ever/i.test(body), 'the no-receipts rule is missing');
  assert.ok(/launder/i.test(body), 'the rule states the prohibition but not the reason it exists');
  assert.ok(
    /ticket-loop run is active/i.test(body),
    'it must defer to the loop when a run is in flight rather than reviewing alongside it'
  );
});

test('it refuses to review without a description', () => {
  assert.ok(
    /ask for one sentence|stop until you have it/i.test(skill()),
    'reviewing against no description is how a review becomes a rubber stamp'
  );
});

test('the prompt states what a standalone review cannot establish', () => {
  const body = prompt();
  assert.ok(/NOT A CONTRACT/i.test(body), 'the output banner must name what is missing');
  assert.ok(/written after the code/i.test(body), 'it must say the description followed the diff');
  for (const cannot of ['complete', 'actually executed', 'written to fit the diff']) {
    assert.ok(body.includes(cannot), `the prompt does not name "${cannot}" as an open question`);
  }
});

// Distinct vocabulary, so a standalone result cannot be pasted somewhere and read as a loop
// verdict.
test('its assessment words are not the loop verdict words', () => {
  const body = prompt();
  assert.ok(/SHIP IT \| FIX FIRST \| THINK AGAIN/.test(body), 'missing the standalone assessment scale');
  for (const loopVerdict of ['APPROVE_WITH_COMMENTS', 'VERDICT:']) {
    assert.ok(!body.includes(loopVerdict), `"${loopVerdict}" belongs to the loop's sealed verdict, not to this`);
  }
});

test('every placeholder the skill fills exists in the prompt', () => {
  const body = prompt();
  for (const slot of ['{DESCRIPTION}', '{DIFF_COMMANDS}', '{QA_SCOPE}', '{CONVENTIONS}', '{RISK_PATHS}']) {
    assert.ok(body.includes(slot), `prompt is missing ${slot}`);
  }
});

// The scope decision has to work with no run behind it, or the standalone review falls back to
// eyeballing the diff — the defect qascope was written to remove.
test('qascope runs without a receipt chain when given a base ref', () => {
  const res = runScript(path.join(SCRIPTS_DIR, 'ledger.js'), ['qascope', '--base', 'HEAD'], { cwd: REPO_ROOT });
  assert.strictEqual(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(['FOCUSED', 'FULL'].includes(out.scope), res.stdout);
  assert.ok(Number.isInteger(out.insertions), res.stdout);
});
