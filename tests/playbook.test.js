'use strict';
// The playbook is read top to bottom by the orchestrator, and every command it names is run
// verbatim. Neither property survives editing by accident: a stage inserted as "5.5" lands
// after the failure loop that routes to it, and a renamed subcommand keeps reading fine while
// the run dies at that line.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, SCRIPTS_DIR } = require('./helpers.js');

const PLUGIN = path.join(REPO_ROOT, 'plugins', 'ticket-loop');
const SKILL = path.join(PLUGIN, 'skills', 'ticket-loop', 'SKILL.md');

// The whole file loads into the orchestrator's context on every run, ahead of the ticket. The
// budget holds it to procedure; rationale goes in README.md.
const MAX_LINES = 350;
const MAX_DESCRIPTION_CHARS = 500;

const skill = () => fs.readFileSync(SKILL, 'utf8');
const stageHeadings = (body) => [...body.matchAll(/^## Stage (\S+)/gm)].map((m) => m[1]);

test('stage headings are whole numbers in the order a run executes them', () => {
  const stages = stageHeadings(skill());
  assert.ok(stages.length >= 8, `only ${stages.length} stage headings found`);
  const numbers = stages.map((s) => {
    assert.match(s, /^\d+$/, `stage "${s}" is not a whole number`);
    return Number(s);
  });
  for (let i = 1; i < numbers.length; i++) {
    assert.ok(
      numbers[i] === numbers[i - 1] + 1,
      `stage ${numbers[i]} follows stage ${numbers[i - 1]}; stages must run in reading order`
    );
  }
});

test('every ledger.js subcommand the playbook names exists', () => {
  const ledger = fs.readFileSync(path.join(SCRIPTS_DIR, 'ledger.js'), 'utf8');
  const implemented = new Set([...ledger.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]));
  const named = new Set([...skill().matchAll(/ledger\.js ([a-z]+)\b/g)].map((m) => m[1]));
  assert.ok(named.size >= 10, `only ${named.size} ledger subcommands named; the playbook lost its receipts`);
  for (const cmd of named) {
    assert.ok(implemented.has(cmd), `the playbook runs "ledger.js ${cmd}", which ledger.js does not implement`);
  }
});

test('every script the playbook names ships in scripts/', () => {
  for (const [, script] of skill().matchAll(/scripts\/([a-z_]+\.js)/g)) {
    assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, script)), `the playbook names scripts/${script}, which does not exist`);
  }
});

test('stage numbers cited outside the playbook point at stages that exist', () => {
  const stages = new Set(stageHeadings(skill()));
  const citing = [
    path.join(PLUGIN, 'agents', 'ticket-loop-qa.md'),
    path.join(PLUGIN, 'skills', 'qa-check', 'SKILL.md'),
    path.join(PLUGIN, 'skills', 'ticket-loop', 'report-template.md'),
    path.join(REPO_ROOT, 'README.md'),
    path.join(REPO_ROOT, 'INSTALL.md'),
  ];
  for (const file of citing) {
    const body = fs.readFileSync(file, 'utf8');
    for (const [, n] of body.matchAll(/\bStage (\d+(?:\.\d+)?)/g)) {
      assert.ok(stages.has(n), `${path.relative(REPO_ROOT, file)} cites Stage ${n}, which the playbook does not have`);
    }
  }
});

test('the playbook stays within its line budget', () => {
  const lines = skill().split('\n').length;
  assert.ok(lines <= MAX_LINES, `SKILL.md is ${lines} lines; the budget is ${MAX_LINES}. Move rationale to README.md`);
});

test('the description says when to use the skill and fits the frontmatter budget', () => {
  const m = skill().match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, 'no YAML frontmatter');
  const description = (m[1].match(/description:\s*(.*)/) || [])[1] || '';
  assert.match(description, /^Use when/, 'description must open with the triggering condition');
  assert.ok(
    description.length <= MAX_DESCRIPTION_CHARS,
    `description is ${description.length} chars; the budget is ${MAX_DESCRIPTION_CHARS}`
  );
});
