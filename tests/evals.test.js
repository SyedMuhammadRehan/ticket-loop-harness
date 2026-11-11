'use strict';
// The eval suite costs model calls to run, so it cannot be part of this suite. What can be
// held here is its shape: a case that fails to load, or that grants a shell, would only be
// found on the next paid run, or would stop the suite running on Windows at all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./helpers.js');

const EVALS = path.join(REPO_ROOT, 'plugins', 'ticket-loop', 'evals');
const GRADER_TYPES = ['regex', 'tool_used', 'tool_order', 'file_exists', 'llm', 'baseline'];
const SHELL_TOOLS = /\b(Bash|PowerShell)\b/;

const cases = () => fs.readdirSync(EVALS, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'results' && e.name !== 'mocks').map((e) => e.name);
const frontmatter = (file) => (/^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, 'utf8')) || [])[1];

test('every eval case has a prompt and at least one grader of a known type', () => {
  const found = cases();
  assert.ok(found.length >= 4, `only ${found.length} eval cases found`);
  for (const name of found) {
    assert.match(name, /^[a-z0-9][a-z0-9._-]*$/, `${name} is not a valid case name`);
    const prompt = path.join(EVALS, name, 'prompt.md');
    assert.ok(fs.existsSync(prompt), `${name} has no prompt.md`);
    const head = frontmatter(prompt);
    assert.ok(head, `${name}/prompt.md has no frontmatter`);
    assert.ok(fs.readFileSync(prompt, 'utf8').split(/^---$/m)[2].trim().length > 20, `${name} has no prompt text`);
    const graders = fs.readdirSync(path.join(EVALS, name, 'graders')).filter((f) => f.endsWith('.md'));
    assert.ok(graders.length >= 1, `${name} has no grader, so it would fail to load`);
    for (const g of graders) {
      const type = (/^type:\s*(\S+)/m.exec(frontmatter(path.join(EVALS, name, 'graders', g)) || '') || [])[1];
      assert.ok(GRADER_TYPES.includes(type), `${name}/graders/${g} has type "${type}"`);
    }
  }
});

test('no eval case is granted a shell, so the suite runs without an OS sandbox', () => {
  for (const name of cases()) {
    const tools = (/^allowed_tools:\s*(.*)$/m.exec(frontmatter(path.join(EVALS, name, 'prompt.md'))) || [])[1] || '';
    assert.ok(!SHELL_TOOLS.test(tools), `${name} grants ${tools}; native Windows has no sandbox to run it under`);
  }
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'evals.yml'), 'utf8');
  assert.ok(!/--allow-tools[^\n]*\b(Bash|PowerShell)\b/.test(workflow));
  assert.match(workflow, /workflow_dispatch/, 'the paid suite is started by hand');
  assert.ok(!/^\s+(push|pull_request|schedule):/m.test(workflow), 'and never by a push, a pull request or a timer');
  assert.match(workflow, /--max-cost-usd/);
  assert.match(workflow, /--no-publish/);
});

test('a case that names a fixture script ships it, and every case is in the docs', () => {
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'evals.md'), 'utf8');
  for (const name of cases()) {
    assert.ok(doc.includes(`\`${name}\``), `docs/evals.md does not describe ${name}`);
    const yaml = path.join(EVALS, name, 'case.yaml');
    if (!fs.existsSync(yaml)) continue;
    const text = fs.readFileSync(yaml, 'utf8');
    assert.match(text, /^schema_version: "1\.1"$/m);
    assert.match(text, new RegExp(`^name: ${name}$`, 'm'), 'case.yaml names the case its directory is');
    const script = (/scaffold_script:\s*(\S+)/.exec(text) || [])[1];
    if (script) assert.ok(fs.existsSync(path.join(EVALS, name, script)), `${name} names ${script}, which is not there`);
  }
});
