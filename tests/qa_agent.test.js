'use strict';
// The QA judge is the one dispatch whose independence is the product. Running it as a
// general-purpose agent gave it Write and Edit, so a reviewer could quietly fix what it was
// asked to judge and then seal a verdict over a tree that no longer matched the diff. The tool
// list is the mechanism; this is the test that fails when someone widens it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./helpers.js');

const AGENT = path.join(REPO_ROOT, 'plugins', 'ticket-loop', 'agents', 'ticket-loop-qa.md');
const EDITING_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'MultiEdit'];

function frontmatter() {
  const src = fs.readFileSync(AGENT, 'utf8');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, 'the QA agent has no YAML frontmatter');
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

test('the QA agent declares a name and description', () => {
  const fields = frontmatter();
  assert.strictEqual(fields.name, 'ticket-loop-qa');
  assert.ok(fields.description && fields.description.length > 20, 'description is missing or too thin to route on');
});

test('the QA agent is granted no tool that can edit the tree', () => {
  const fields = frontmatter();
  assert.ok(fields.tools, 'no tools field — the agent would inherit every tool, including Write and Edit');
  const granted = fields.tools.split(',').map((t) => t.trim());
  for (const tool of EDITING_TOOLS) {
    assert.ok(
      !granted.includes(tool),
      `${tool} is granted to the QA judge: a reviewer that can edit what it judges seals a verdict over a tree that has moved`
    );
  }
  assert.ok(granted.includes('Read'), 'the judge must be able to read the contract from disk');
  assert.ok(granted.includes('Bash'), 'the judge must be able to run the diff and seal its verdict');
});

test('the playbook dispatches Stage 5.5 to that agent by name', () => {
  const skill = fs.readFileSync(
    path.join(REPO_ROOT, 'plugins', 'ticket-loop', 'skills', 'ticket-loop', 'SKILL.md'),
    'utf8'
  );
  assert.ok(
    skill.includes('ticket-loop-qa'),
    'SKILL.md never names the QA agent, so the narrowed tool list would not be used'
  );
});
