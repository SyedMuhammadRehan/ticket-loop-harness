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

// --- declared slice scope: a change outside it is listed, never inferred ---

function commitAll(root, msg) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', msg);
}

test('a changed file outside every declared slice scope is listed for the judge', () => {
  const { root, runDir } = mkRepo(CONFIG);
  try {
    assert.strictEqual(ledger(root, ['slice', runDir, 'C1', '--files', 'src/**']).status, 0);
    fs.appendFileSync(path.join(root, 'src', 'big.js'), '\nconst extra = 1;\n');
    fs.writeFileSync(path.join(root, 'lib', 'stray.js'), 'module.exports = 1;\n');
    git(root, 'add', '-A');
    const out = scopeOf(root, runDir);
    assert.deepStrictEqual(out.declaredScope, ['src/**']);
    assert.deepStrictEqual(out.outsideScope, ['lib/stray.js']);
  } finally {
    rmDir(root);
  }
});

test('with no slice declared, outside-scope is null rather than an empty list', () => {
  const { root, runDir } = mkRepo(CONFIG);
  try {
    fs.appendFileSync(path.join(root, 'src', 'big.js'), '\nconst extra = 1;\n');
    const out = scopeOf(root, runDir);
    assert.strictEqual(out.declaredScope, null);
    assert.strictEqual(out.outsideScope, null);
  } finally {
    rmDir(root);
  }
});

test('slice refuses an empty id and a declaration with no files', () => {
  const { root, runDir } = mkRepo(CONFIG);
  try {
    assert.strictEqual(ledger(root, ['slice', runDir, '', '--files', 'src/**']).status, 1);
    assert.strictEqual(ledger(root, ['slice', runDir, 'C1']).status, 1);
    assert.strictEqual(ledger(root, ['slice', runDir, 'C1', '--files', 'src/a.js', '--files', 'lib/**']).status, 0);
  } finally {
    rmDir(root);
  }
});

// --- delta re-review: a fix that stays inside the judged files is read as the change since ---

function judged(root, runDir, verdict) {
  fs.writeFileSync(path.join(root, runDir, 'done.md'), '# Done\n');
  fs.writeFileSync(path.join(root, runDir, 'done.approved.md'), '# Done\n');
  if (!JSON.parse(ledger(root, ['status', runDir]).stdout).gates.includes('freeze')) {
    assert.strictEqual(ledger(root, ['gate', runDir, 'freeze', '--evidence', path.join(runDir, 'done.md')]).status, 0);
  }
  assert.strictEqual(ledger(root, ['dispatch', runDir, 'qa: contract [focused]', '--source', 'hook']).status, 0);
  const res = ledger(root, ['verdict', runDir, verdict, '--inputs', path.join(runDir, 'done.approved.md')]);
  assert.strictEqual(res.status, 0, res.stderr);
  const seq = JSON.parse(ledger(root, ['status', runDir]).stdout).open[0].seqs[0];
  assert.strictEqual(ledger(root, ['outcome', runDir, String(seq), 'ok', verdict]).status, 0);
}

function sliceRepo() {
  const made = mkRepo(CONFIG);
  fs.writeFileSync(path.join(made.root, 'src', 'a.js'), Array.from({ length: 30 }, (_, i) => `const a${i} = ${i};`).join('\n'));
  commitAll(made.root, 'slice C1');
  return made;
}

test('a fix confined to the files a judge already read is scoped as a DELTA since that verdict', () => {
  const { root, runDir } = sliceRepo();
  try {
    const first = scopeOf(root, runDir);
    assert.strictEqual(first.scope, 'FOCUSED');
    judged(root, runDir, 'BLOCK');
    fs.appendFileSync(path.join(root, 'src', 'a.js'), '\nconst fixed = true;\n');
    commitAll(root, 'fix per findings');
    const second = scopeOf(root, runDir);
    assert.strictEqual(second.scope, 'DELTA', JSON.stringify(second));
    assert.strictEqual(second.since, first.head);
    assert.deepStrictEqual(second.deltaFiles, ['src/a.js']);
    assert.ok(Number.isInteger(second.priorVerdictSeq));
    assert.strictEqual(second.label, 'qa: contract [delta]');
    assert.strictEqual(ledger(root, ['verify', runDir]).status, 0, 'scope receipts must keep the chain intact');
  } finally {
    rmDir(root);
  }
});

test('a fix that touches a file the judge never read escalates back to a size-based scope', () => {
  const { root, runDir } = sliceRepo();
  try {
    scopeOf(root, runDir);
    judged(root, runDir, 'BLOCK');
    fs.writeFileSync(path.join(root, 'src', 'helper.js'), 'module.exports = () => 1;\n');
    commitAll(root, 'fix reached a new file');
    const out = scopeOf(root, runDir);
    assert.notStrictEqual(out.scope, 'DELTA', JSON.stringify(out));
    assert.ok(out.why.some((w) => w.includes('src/helper.js')), JSON.stringify(out.why));
  } finally {
    rmDir(root);
  }
});

test('a fix that touches a risk path is FULL even when the judge read that file before', () => {
  const { root, runDir } = sliceRepo();
  try {
    fs.appendFileSync(path.join(root, 'lib', 'auth.js'), '// touched\n');
    commitAll(root, 'slice touches auth');
    assert.strictEqual(scopeOf(root, runDir).scope, 'FULL');
    judged(root, runDir, 'BLOCK');
    fs.appendFileSync(path.join(root, 'lib', 'auth.js'), '// fixed\n');
    commitAll(root, 'fix in auth');
    const out = scopeOf(root, runDir);
    assert.strictEqual(out.scope, 'FULL', JSON.stringify(out));
  } finally {
    rmDir(root);
  }
});

// Only a risk path changed SINCE the judge read it escalates.
test('a risk path judged in an earlier round does not force FULL on an unrelated later fix', () => {
  const { root, runDir } = sliceRepo();
  try {
    fs.appendFileSync(path.join(root, 'lib', 'auth.js'), '// touched\n');
    commitAll(root, 'slice touches auth');
    assert.strictEqual(scopeOf(root, runDir).scope, 'FULL');
    judged(root, runDir, 'BLOCK');
    fs.appendFileSync(path.join(root, 'src', 'a.js'), '\nconst fixed = true;\n');
    commitAll(root, 'fix elsewhere');
    const out = scopeOf(root, runDir);
    assert.strictEqual(out.scope, 'DELTA', JSON.stringify(out));
    assert.deepStrictEqual(out.deltaFiles, ['src/a.js']);
  } finally {
    rmDir(root);
  }
});

test('without a prior verdict a second qascope is never a DELTA', () => {
  const { root, runDir } = sliceRepo();
  try {
    scopeOf(root, runDir);
    fs.appendFileSync(path.join(root, 'src', 'a.js'), '\nconst more = 1;\n');
    const out = scopeOf(root, runDir);
    assert.strictEqual(out.scope, 'FOCUSED', JSON.stringify(out));
  } finally {
    rmDir(root);
  }
});
