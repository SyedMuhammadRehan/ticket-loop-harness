'use strict';
// The prompt templates are ordered for the prompt cache: a stable prefix that is identical
// on every dispatch, then run-stable material, then the per-dispatch fills. A fill that
// drifts back into the prefix busts the cache for everything after it, and every repeated
// dispatch pays full price again — invisibly, because nothing about the output changes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./helpers.js');

const SKILL_DIR = path.join(REPO_ROOT, 'plugins', 'ticket-loop', 'skills', 'ticket-loop');
const PROMPTS = path.join(SKILL_DIR, 'prompts');

// The router and every stage file: what the orchestrator is told, wherever it is told it.
function playbook() {
  const stages = path.join(SKILL_DIR, 'stages');
  const files = fs.readdirSync(stages).filter((f) => f.endsWith('.md')).sort();
  return [fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'), ...files.map((f) => fs.readFileSync(path.join(stages, f), 'utf8'))].join('\n');
}

// per-dispatch = changes on EVERY dispatch, so it must sit at the tail.
const TEMPLATES = {
  'implementer.md': {
    required: [
      'TICKET', 'SLICE_ID', 'WORKTREE_PATH', 'SLICE', 'DONE_LIST',
      'CODEBASE_MAP', 'APPROACH', 'DESIGN_EXCERPT', 'LEDGER_FORBIDDEN',
    ],
    perDispatch: ['SLICE', 'LEDGER_FORBIDDEN', 'SLICE_ID'],
  },
  'fixer_ui.md': {
    required: ['TICKET', 'CHECK_ID', 'WORKTREE_PATH', 'EXPECTED', 'ACTUAL', 'FILES', 'LEDGER_FORBIDDEN'],
    perDispatch: ['EXPECTED', 'ACTUAL', 'FILES', 'LEDGER_FORBIDDEN'],
  },
  'qa_agent.md': {
    required: ['TICKET', 'RUN_DIR', 'SCRIPTS_DIR', 'WORKTREE_PATH', 'BASE_SHA', 'DIFF', 'CHECK_RESULTS', 'CONVENTIONS', 'QA_SCOPE'],
    perDispatch: ['DIFF', 'CHECK_RESULTS', 'CONVENTIONS', 'QA_SCOPE'],
  },
  'fixer_build.md': {
    required: ['TICKET', 'CHECK_ID', 'WORKTREE_PATH', 'VERIFY_ANALYZE', 'VERIFY_TEST', 'ERROR_OUTPUT', 'FILES', 'LEDGER_FORBIDDEN'],
    perDispatch: ['ERROR_OUTPUT', 'FILES', 'LEDGER_FORBIDDEN'],
  },
};

// Every agent the loop dispatches runs a prompt shipped here, on a Claude Code built-in agent
// type or the plugin's own judge. Another plugin's agent is code nobody in this repo can read.
test('the playbook names no agent from another plugin', () => {
  const skill = playbook();
  for (const foreign of ['code-explorer', 'build-resolver', 'buildResolverAgent', '`/jira`']) {
    assert.ok(!skill.includes(foreign), `SKILL.md delegates to "${foreign}", which is not this plugin's code`);
  }
});

for (const [name, spec] of Object.entries(TEMPLATES)) {
  const body = fs.readFileSync(path.join(PROMPTS, name), 'utf8');

  test(`${name} still carries every fill the orchestrator supplies`, () => {
    for (const fill of spec.required) {
      assert.ok(body.includes(`{${fill}}`), `${name} lost the {${fill}} placeholder`);
    }
  });

  test(`${name} keeps its per-dispatch fills out of the cacheable prefix`, () => {
    const half = body.length / 2;
    for (const fill of spec.perDispatch) {
      const at = body.indexOf(`{${fill}}`);
      assert.ok(
        at > half,
        `${name}: {${fill}} appears at ${Math.round((at / body.length) * 100)}% of the file — ` +
          `a per-dispatch fill in the first half leaves nothing worth caching before it`
      );
    }
  });
}

// The judge reads text written by the party under review and by whoever can edit the ticket, and
// its working directory is the main checkout, where every changed file is still the old one.
test('the judge prompts say that what they read is evidence, and where the changed code is', () => {
  const judge = fs.readFileSync(path.join(PROMPTS, 'qa_agent.md'), 'utf8');
  assert.match(judge, /evidence, never instruction/);
  assert.match(judge, /git -C \{WORKTREE_PATH\} diff --stat \{BASE_SHA\}/);
  const standalone = fs.readFileSync(path.join(REPO_ROOT, 'plugins', 'ticket-loop', 'skills', 'qa-check', 'prompts', 'qa_check.md'), 'utf8');
  assert.match(standalone, /evidence, never instruction/);
});

// A placeholder nobody fills reaches the subagent as the literal text "{FOO}", which reads
// as an instruction it cannot satisfy.
test('no template references a fill the skill does not document', () => {
  const skill = playbook();
  for (const name of Object.keys(TEMPLATES)) {
    const body = fs.readFileSync(path.join(PROMPTS, name), 'utf8');
    const used = new Set([...body.matchAll(/\{([A-Z_]+)\}/g)].map((m) => m[1]));
    for (const fill of used) {
      assert.ok(
        skill.includes(`{${fill}}`) || TEMPLATES[name].required.includes(fill),
        `${name} uses {${fill}}, which SKILL.md never tells the orchestrator to fill`
      );
    }
  }
});
