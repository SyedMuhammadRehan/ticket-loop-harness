'use strict';
// Reusing the main repo's dependency directory saves the largest fixed cost in a run. The whole
// safety argument is the lockfile check: identical lockfiles mean the tree that gets verified is
// the tree that would have been installed. Every case where that cannot be established must
// fall back to installing, because a wrong dependency tree makes every downstream check a lie.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');

const SCRIPT = path.join(SCRIPTS_DIR, 'worktree_deps.js');
const DEPS = { dir: 'node_modules', lockfile: 'package-lock.json' };

// A main repo with installed deps, plus a sibling worktree directory.
function mkPair({ deps = DEPS, lockMain = '{"v":1}', lockTree = '{"v":1}', installed = true } = {}) {
  const base = mkTmpDir('tl-wd');
  const root = path.join(base, 'main');
  const tree = path.join(base, 'wt');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'ticket-loop.config.json'),
    JSON.stringify({ verify: { test: 'x' }, ...(deps ? { deps } : {}) })
  );
  if (installed) {
    fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  }
  if (lockMain !== null) fs.writeFileSync(path.join(root, 'package-lock.json'), lockMain);
  if (lockTree !== null) fs.writeFileSync(path.join(tree, 'package-lock.json'), lockTree);
  return { base, root, tree };
}

function run(root, tree) {
  const res = runScript(SCRIPT, [tree, '--main', root], { cwd: root });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('an identical lockfile reuses the installed tree', () => {
  const env = mkPair();
  try {
    const out = run(env.root, env.tree);
    assert.strictEqual(out.action, 'linked', JSON.stringify(out));
    // The reuse has to be real: the package must be readable through the worktree.
    const viaWorktree = path.join(env.tree, 'node_modules', 'left-pad', 'index.js');
    assert.ok(fs.existsSync(viaWorktree), 'the linked directory does not resolve to the installed one');
    assert.strictEqual(fs.readFileSync(viaWorktree, 'utf8').trim(), 'module.exports = 1;');
  } finally {
    rmDir(env.base);
  }
});

// The one case that must never be optimised away.
test('a different lockfile installs instead of reusing', () => {
  const env = mkPair({ lockTree: '{"v":2}' });
  try {
    const out = run(env.root, env.tree);
    assert.strictEqual(out.action, 'install', JSON.stringify(out));
    assert.ok(/differs/.test(out.reason), out.reason);
    assert.ok(!fs.existsSync(path.join(env.tree, 'node_modules')), 'it linked a tree the lockfile does not describe');
  } finally {
    rmDir(env.base);
  }
});

test('a missing lockfile on either side installs', () => {
  for (const missing of [{ lockTree: null }, { lockMain: null }]) {
    const env = mkPair(missing);
    try {
      assert.strictEqual(run(env.root, env.tree).action, 'install', JSON.stringify(missing));
    } finally {
      rmDir(env.base);
    }
  }
});

test('nothing installed in the main repo installs', () => {
  const env = mkPair({ installed: false });
  try {
    const out = run(env.root, env.tree);
    assert.strictEqual(out.action, 'install', JSON.stringify(out));
    assert.ok(/no node_modules/.test(out.reason), out.reason);
  } finally {
    rmDir(env.base);
  }
});

// With no deps block this is the old behaviour, unchanged.
test('a profile with no deps block installs', () => {
  const env = mkPair({ deps: null });
  try {
    const out = run(env.root, env.tree);
    assert.strictEqual(out.action, 'install', JSON.stringify(out));
    assert.ok(/no deps block/.test(out.reason), out.reason);
  } finally {
    rmDir(env.base);
  }
});

test('an already-populated worktree is left alone', () => {
  const env = mkPair();
  try {
    fs.mkdirSync(path.join(env.tree, 'node_modules'), { recursive: true });
    const out = run(env.root, env.tree);
    assert.strictEqual(out.action, 'present', JSON.stringify(out));
  } finally {
    rmDir(env.base);
  }
});

test('it never exits non-zero, whatever it decides', () => {
  const env = mkPair({ lockTree: '{"v":9}' });
  try {
    const res = runScript(SCRIPT, [env.tree, '--main', env.root], { cwd: env.root });
    assert.strictEqual(res.status, 0, 'a fallback to installing is a decision, not a failure');
  } finally {
    rmDir(env.base);
  }
});
