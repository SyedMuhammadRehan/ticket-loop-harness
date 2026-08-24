'use strict';
// How widely the QA judge reads used to be the orchestrator totalling `git diff --shortstat`
// by eye, insertions PLUS deletions. A field run deleted a 68-line component and got a
// full-codebase sweep for it: nothing was added to review. A diff is sized by what it ADDED,
// and a risk path forces FULL at any size, because there the question is never "how much".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpDir, rmDir, ledger } = require('./helpers.js');

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

// A real repo with a committed baseline, so base..HEAD means something.
function mkRepo(config) {
  const root = mkTmpDir('tl-qs');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@test');
  git(root, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'big.js'), Array.from({ length: 80 }, (_, i) => `const v${i} = ${i};`).join('\n'));
  fs.writeFileSync(path.join(root, 'lib', 'auth.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/ticket-runs/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  const runDir = '.agents/ticket-runs/T-1';
  fs.mkdirSync(path.join(root, runDir), { recursive: true });
  assert.strictEqual(ledger(root, ['init', runDir, base]).status, 0);
  return { root, runDir, base };
}

function scopeOf(root, runDir) {
  const res = ledger(root, ['qascope', runDir]);
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

const CONFIG = { verify: { test: 'x' }, qaScope: { smallDiffLines: 60 }, riskPaths: ['lib/auth.js', 'app/api/**'] };

test('a large deletion is FOCUSED — nothing was added to review', () => {
  const { root, runDir } = mkRepo(CONFIG);
  try {
    fs.rmSync(path.join(root, 'src', 'big.js'));
    const out = scopeOf(root, runDir);
    assert.strictEqual(out.scope, 'FOCUSED', JSON.stringify(out));
    assert.strictEqual(out.insertions, 0);
    assert.ok(out.deletions >= 80, `expected the deletion to be counted and reported: ${out.deletions}`);
  } finally {
    rmDir(root);
  }
});

test('a large insertion is FULL', () => {
  const { root, runDir } = mkRepo(CONFIG);
  try {
    fs.writeFileSync(path.join(root, 'src', 'new.js'), Array.from({ length: 90 }, (_, i) => `const n${i} = ${i};`).join('\n'));
    git(root, 'add', '-A');
    const out = scopeOf(root, runDir);
    assert.strictEqual(out.scope, 'FULL', JSON.stringify(out));
    assert.ok(out.why.some((w) => w.includes('exceeds')), JSON.stringify(out.why));
  } finally {
    rmDir(root);
  }
});

test('a small insertion is FOCUSED', () => {
  const { root, runDir } = mkRepo(CONFIG);
  try {
    fs.appendFileSync(path.join(root, 'src', 'big.js'), '\nconst extra = 1;\n');
    const out = scopeOf(root, runDir);
    assert.strictEqual(out.scope, 'FOCUSED', JSON.stringify(out));
  } finally {
    rmDir(root);
  }
});

// Size is the wrong question in a risk path, so it is not asked.
test('a one-line change in a risk path is FULL regardless of size', () => {
  const { root, runDir } = mkRepo(CONFIG);
  try {
    fs.appendFileSync(path.join(root, 'lib', 'auth.js'), '// one line\n');
    const out = scopeOf(root, runDir);
    assert.strictEqual(out.scope, 'FULL', JSON.stringify(out));
    assert.deepStrictEqual(out.touchedRiskPaths, ['lib/auth.js']);
  } finally {
    rmDir(root);
  }
});

test('a glob risk path matches at depth', () => {
  const { root, runDir } = mkRepo(CONFIG);
  try {
    fs.mkdirSync(path.join(root, 'app', 'api', 'orders'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'api', 'orders', 'route.js'), 'export const GET = () => {};\n');
    git(root, 'add', '-A');
    const out = scopeOf(root, runDir);
    assert.strictEqual(out.scope, 'FULL', JSON.stringify(out));
    assert.deepStrictEqual(out.touchedRiskPaths, ['app/api/orders/route.js']);
  } finally {
    rmDir(root);
  }
});

test('committed and uncommitted work are both counted', () => {
  const { root, runDir } = mkRepo(CONFIG);
  try {
    fs.writeFileSync(path.join(root, 'src', 'a.js'), Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`).join('\n'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'committed slice');
    fs.writeFileSync(path.join(root, 'src', 'b.js'), Array.from({ length: 40 }, (_, i) => `const b${i} = ${i};`).join('\n'));
    git(root, 'add', '-A');
    const out = scopeOf(root, runDir);
    assert.ok(out.insertions >= 80, `both spans must count: ${out.insertions}`);
    assert.strictEqual(out.scope, 'FULL', JSON.stringify(out));
  } finally {
    rmDir(root);
  }
});

test('the label carries the scope, so a focused review cannot pass itself off as full', () => {
  const { root, runDir } = mkRepo(CONFIG);
  try {
    assert.strictEqual(scopeOf(root, runDir).label, 'qa: contract [focused]');
  } finally {
    rmDir(root);
  }
});
