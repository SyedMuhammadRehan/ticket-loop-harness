'use strict';
// INVARIANTS.md claims that each guarantee has enforcing code and a test that kills it. That
// claim is itself prose, so it gets the same treatment as any other: this parses the table and
// fails when a cited symbol or test name no longer exists.
//
// What it establishes: every reference RESOLVES. What it cannot: that the cited test still
// proves what the row claims. A row whose test was gutted still passes here — that is what
// review and the mutation runs are for.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./helpers.js');

const PLUGIN = path.join(REPO_ROOT, 'plugins', 'ticket-loop');
const SEARCH_DIRS = [path.join(PLUGIN, 'hooks'), path.join(PLUGIN, 'skills', 'ticket-loop', 'scripts')];

// | n | invariant | `file.js` → `symbol` | `file.test.js` :: `test name` | why |
const ROW = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*→\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*::\s*`([^`]+)`\s*\|/;

function parseRows() {
  const body = fs.readFileSync(path.join(REPO_ROOT, 'INVARIANTS.md'), 'utf8');
  return body
    .split(/\r?\n/)
    .map((line) => line.match(ROW))
    .filter(Boolean)
    .map((m) => ({ n: Number(m[1]), claim: m[2], file: m[3], symbol: m[4], testFile: m[5], testName: m[6] }));
}

const rows = parseRows();

test('INVARIANTS.md parses and covers the enforcement layer', () => {
  assert.ok(rows.length >= 25, `only ${rows.length} invariant rows parsed — the table or the row format drifted`);
  const seen = new Set();
  for (const r of rows) {
    assert.ok(!seen.has(r.n), `duplicate invariant number ${r.n}`);
    seen.add(r.n);
  }
});

test('every invariant cites a source file that exists and contains the named symbol', () => {
  for (const r of rows) {
    const found = SEARCH_DIRS.map((d) => path.join(d, r.file)).find((p) => fs.existsSync(p));
    assert.ok(found, `invariant ${r.n} cites ${r.file}, which is not in hooks/ or scripts/`);
    const src = fs.readFileSync(found, 'utf8');
    assert.ok(
      src.includes(r.symbol),
      `invariant ${r.n} cites ${r.file} → ${r.symbol}, which no longer appears in that file`
    );
  }
});

test('every invariant cites a test that exists', () => {
  const cache = new Map();
  for (const r of rows) {
    const file = path.join(REPO_ROOT, 'tests', r.testFile);
    assert.ok(fs.existsSync(file), `invariant ${r.n} cites ${r.testFile}, which does not exist`);
    if (!cache.has(file)) cache.set(file, fs.readFileSync(file, 'utf8'));
    assert.ok(
      cache.get(file).includes(`test('${r.testName}'`),
      `invariant ${r.n} cites "${r.testName}" in ${r.testFile}, which has no such test`
    );
  }
});

// The table is the map of the enforcement layer; a source file missing from it is a mechanism
// nobody wrote down. New enforcement files must either earn a row or be listed here as
// deliberately uncovered.
test('every enforcement source is represented in the table', () => {
  // Only files that genuinely enforce no guarantee belong here. A file that HAS rows must not
  // be listed: it would then pass this check even if every one of its rows were deleted.
  const EXEMPT = new Set([
    'hook_lib.js', // I/O shims, exercised through the hooks that use them
    'post_edit.js', // formatting/analysis convenience, enforces no guarantee
    'memory.js', // cross-run notes, explicitly advisory
  ]);
  const cited = new Set(rows.map((r) => r.file));
  for (const dir of SEARCH_DIRS) {
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      assert.ok(
        cited.has(name) || EXEMPT.has(name),
        `${name} enforces something but has no row in INVARIANTS.md and is not listed as exempt`
      );
    }
  }
});
