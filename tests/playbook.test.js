'use strict';
// The playbook is a short router plus one file per stage, and every command it names is run
// verbatim. Neither property survives editing by accident: a stage inserted as "5.5" lands
// after the failure loop that routes to it, a renamed subcommand keeps reading fine while the
// run dies at that line, and a router that grows back past what a compaction keeps loses its
// own loop.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, SCRIPTS_DIR } = require('./helpers.js');

const PLUGIN = path.join(REPO_ROOT, 'plugins', 'ticket-loop');
const SKILL = path.join(PLUGIN, 'skills', 'ticket-loop', 'SKILL.md');
const STAGES = path.join(PLUGIN, 'skills', 'ticket-loop', 'stages');

// After a compaction Claude Code re-attaches only the start of an invoked skill (the first
// 5,000 tokens). The router has to fit well inside that, so its loop is never the part cut off.
const MAX_ROUTER_LINES = 90;
const MAX_ROUTER_CHARS = 8000;
// One stage is read whole each time the run reaches it. Raise it for a new command, never for
// an explanation; rationale goes in README.md.
const MAX_STAGE_LINES = 60;
const MAX_DESCRIPTION_CHARS = 500;

const router = () => fs.readFileSync(SKILL, 'utf8');
const stageFiles = () => fs.readdirSync(STAGES).filter((f) => f.endsWith('.md')).sort();
const stageText = (file) => fs.readFileSync(path.join(STAGES, file), 'utf8');
const playbook = () => [router(), ...stageFiles().map(stageText)].join('\n');
const stageNumbers = () => stageFiles().map((f) => (/^# Stage (\S+)/m.exec(stageText(f)) || [])[1]);

test('each stage file is one whole-numbered stage, in the order a run executes them', () => {
  const files = stageFiles();
  assert.ok(files.length >= 8, `only ${files.length} stage files found`);
  stageNumbers().forEach((n, i) => {
    assert.match(String(n), /^\d+$/, `${files[i]} does not open with a whole-numbered "# Stage"`);
    assert.strictEqual(Number(n), i, `${files[i]} is stage ${n} but sorts at position ${i}; stages must run in file order`);
    assert.ok(files[i].startsWith(String(i).padStart(2, '0')), `${files[i]} is not named for stage ${i}`);
    assert.strictEqual((stageText(files[i]).match(/^# Stage /gm) || []).length, 1, `${files[i]} holds more than one stage`);
  });
});

test('every ledger.js subcommand the playbook names exists', () => {
  const ledger = fs.readFileSync(path.join(SCRIPTS_DIR, 'ledger.js'), 'utf8');
  const implemented = new Set([...ledger.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]));
  const named = new Set([...playbook().matchAll(/ledger\.js ([a-z]+)\b/g)].map((m) => m[1]));
  assert.ok(named.size >= 10, `only ${named.size} ledger subcommands named; the playbook lost its receipts`);
  for (const cmd of named) {
    assert.ok(implemented.has(cmd), `the playbook runs "ledger.js ${cmd}", which ledger.js does not implement`);
  }
});

test('every script the playbook names ships in scripts/', () => {
  for (const [, script] of playbook().matchAll(/scripts\/([a-z_]+\.js)/g)) {
    assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, script)), `the playbook names scripts/${script}, which does not exist`);
  }
});

test('stage numbers cited anywhere point at stages that exist', () => {
  const stages = new Set(stageNumbers());
  const citing = [
    SKILL,
    ...stageFiles().map((f) => path.join(STAGES, f)),
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

test('the router carries the loop near its top and fits inside what a compaction keeps', () => {
  const body = router();
  const lines = body.split('\n').length;
  assert.ok(lines <= MAX_ROUTER_LINES, `SKILL.md is ${lines} lines; the budget is ${MAX_ROUTER_LINES}. A stage's steps belong in its stage file`);
  assert.ok(body.length <= MAX_ROUTER_CHARS, `SKILL.md is ${body.length} chars; the budget is ${MAX_ROUTER_CHARS}`);
  const loopAt = body.indexOf('ledger.js next <runDir>');
  assert.ok(loopAt > 0 && loopAt < body.length / 3, 'the next-step command sits in the first third of the router');
  assert.ok(!/^## Stage \d/m.test(body), 'no stage procedure lives in the router');
});

test('no stage file outgrows one sitting', () => {
  for (const file of stageFiles()) {
    const lines = stageText(file).split('\n').length;
    assert.ok(lines <= MAX_STAGE_LINES, `${file} is ${lines} lines; the budget is ${MAX_STAGE_LINES}. Move rationale to README.md`);
  }
});

test('the description says when to use the skill and fits the frontmatter budget', () => {
  const m = router().match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, 'no YAML frontmatter');
  const description = (m[1].match(/description:\s*(.*)/) || [])[1] || '';
  assert.match(description, /^Use when/, 'description must open with the triggering condition');
  assert.ok(
    description.length <= MAX_DESCRIPTION_CHARS,
    `description is ${description.length} chars; the budget is ${MAX_DESCRIPTION_CHARS}`
  );
});
