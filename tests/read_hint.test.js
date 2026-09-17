'use strict';
// The "read narrowly" rule lived in a prompt the implementer may or may not follow. This hook
// puts the file's outline in front of the model at the moment it reaches for the whole file,
// while a run is active and never otherwise.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkRun, rmDir, ledger, runScript, HOOKS_DIR } = require('./helpers.js');

const HOOK = path.join(HOOKS_DIR, 'read_hint.js');

function longSource() {
  const lines = ["'use strict';"];
  for (let i = 0; i < 60; i++) lines.push(`const filler${i} = ${i};`);
  lines.push('export function parseDuration(text) {', '  return text;', '}');
  for (let i = 0; i < 60; i++) lines.push(`const more${i} = ${i};`);
  lines.push('export class Cart {}');
  return lines.join('\n');
}

function repo({ active }) {
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'shop.js'), longSource());
  fs.writeFileSync(path.join(root, 'src', 'tiny.js'), 'export function small() {}\n');
  if (active) assert.strictEqual(ledger(root, ['init', runDir, 'abc123']).status, 0);
  return { root, runDir };
}

function runHook(input, root) {
  const res = runScript(HOOK, [], { cwd: root, input: JSON.stringify({ cwd: root, ...input }) });
  assert.strictEqual(res.status, 0, res.stderr);
  const line = (res.stdout || '').trim();
  return line ? JSON.parse(line).hookSpecificOutput.additionalContext : '';
}

test('a whole-file Read of a long source file gets its outline as context', () => {
  const { root } = repo({ active: true });
  try {
    const ctx = runHook({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'src', 'shop.js') } }, root);
    assert.ok(ctx.includes('function\tparseDuration'), ctx);
    assert.ok(ctx.includes('class\tCart'), ctx);
    assert.ok(/offset\/limit/.test(ctx), ctx);
  } finally {
    rmDir(root);
  }
});

test('a ranged Read, a short file, and a non-source file get nothing', () => {
  const { root } = repo({ active: true });
  try {
    fs.writeFileSync(path.join(root, 'notes.md'), longSource());
    assert.strictEqual(runHook({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'src', 'shop.js'), offset: 60, limit: 10 } }, root), '');
    assert.strictEqual(runHook({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'src', 'tiny.js') } }, root), '');
    assert.strictEqual(runHook({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'notes.md') } }, root), '');
  } finally {
    rmDir(root);
  }
});

test('a Grep for one identifier is answered with where it is declared', () => {
  const { root } = repo({ active: true });
  try {
    const ctx = runHook({ tool_name: 'Grep', tool_input: { pattern: 'parseDuration', path: path.join(root, 'src') } }, root);
    assert.ok(/shop\.js:62\tfunction\tparseDuration/.test(ctx), ctx);
    assert.strictEqual(runHook({ tool_name: 'Grep', tool_input: { pattern: 'parse.*Duration' } }, root), '', 'a regex is not one identifier');
  } finally {
    rmDir(root);
  }
});

test('outside a run the hook says nothing, and malformed stdin never wedges the session', () => {
  const { root } = repo({ active: false });
  try {
    assert.strictEqual(runHook({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'src', 'shop.js') } }, root), '');
    const bad = runScript(HOOK, [], { cwd: root, input: '{not json' });
    assert.strictEqual(bad.status, 0);
    assert.strictEqual((bad.stdout || '').trim(), '');
  } finally {
    rmDir(root);
  }
});
