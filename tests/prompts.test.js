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

const PROMPTS = path.join(REPO_ROOT, 'plugins', 'ticket-loop', 'skills', 'ticket-loop', 'prompts');

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
    required: ['TICKET', 'RUN_DIR', 'SCRIPTS_DIR', 'DIFF', 'CHECK_RESULTS', 'CONVENTIONS', 'QA_SCOPE'],
    perDispatch: ['DIFF', 'CHECK_RESULTS', 'CONVENTIONS', 'QA_SCOPE'],
  },
};

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

// A placeholder nobody fills reaches the subagent as the literal text "{FOO}", which reads
// as an instruction it cannot satisfy.
test('no template references a fill the skill does not document', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'plugins', 'ticket-loop', 'skills', 'ticket-loop', 'SKILL.md'), 'utf8');
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
