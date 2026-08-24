#!/usr/bin/env node
// Reuse the main repo's installed dependencies in a fresh worktree, instead of installing them
// again.
//
//   worktree_deps.js <worktreePath> [--main <repoRoot>]
//
// A fresh worktree has no dependency directory, so `verify.pubGet` runs on every run: minutes
// of install before a single line changes, and for a two-file ticket that is most of the run.
// Linking the parent's directory removes it.
//
// The reuse happens ONLY when the lockfile in the worktree is byte-identical to the main
// repo's. That is the whole safety argument: identical lockfiles mean identical resolved
// dependencies, so the tree that gets verified is the tree that would have been installed. Any
// difference at all — a changed lockfile, a missing one, no configured deps block, a link that
// will not create — falls back to installing, because a wrong dependency tree turns every
// downstream check into a lie.
//
// Stack-agnostic: the directory and lockfile come from the profile's `deps` block
// (`node_modules`/`package-lock.json`, `.venv`/`requirements.txt`, `.dart_tool`/`pubspec.lock`).
// With no `deps` block configured this always says `install`, which is the old behaviour.
'use strict';
const fs = require('fs');
const path = require('path');
const { resolve: resolveProfile } = require('./load_config.js');

function report(action, reason, extra = {}) {
  process.stdout.write(JSON.stringify({ action, reason, ...extra }, null, 2) + '\n');
  return action;
}

function sameFile(a, b) {
  try {
    const left = fs.readFileSync(a);
    const right = fs.readFileSync(b);
    return left.length === right.length && left.equals(right);
  } catch {
    return false;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const worktree = argv.find((a) => !a.startsWith('--'));
  const mainIdx = argv.indexOf('--main');
  if (!worktree) {
    console.error('worktree_deps: usage: worktree_deps.js <worktreePath> [--main <repoRoot>]');
    process.exit(1);
  }

  const cfg = resolveProfile();
  const root = path.resolve(mainIdx !== -1 && argv[mainIdx + 1] ? argv[mainIdx + 1] : cfg._meta.repoRoot);
  const tree = path.resolve(worktree);
  const deps = cfg.deps || {};

  if (!deps.dir || !deps.lockfile) {
    return report('install', 'no deps block in the profile — nothing to reuse, run verify.pubGet');
  }

  const source = path.join(root, deps.dir);
  const target = path.join(tree, deps.dir);
  const lockMain = path.join(root, deps.lockfile);
  const lockTree = path.join(tree, deps.lockfile);

  if (fs.existsSync(target)) {
    return report('present', `${deps.dir} already exists in the worktree`, { target });
  }
  if (!fs.existsSync(source)) {
    return report('install', `the main repo has no ${deps.dir} to reuse`, { source });
  }
  if (!sameFile(lockMain, lockTree)) {
    return report(
      'install',
      `${deps.lockfile} differs between the worktree and the main repo, so the installed tree is not the one this branch resolves to`,
      { lockMain, lockTree }
    );
  }

  try {
    // 'junction' is the Windows form that needs no elevation; POSIX takes a directory symlink.
    fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    return report('install', `could not link ${deps.dir} (${e.code || e.message}) — falling back to a real install`, {
      source,
      target,
    });
  }
  return report('linked', `${deps.lockfile} is identical, so the main repo's ${deps.dir} is reused`, { source, target });
}

if (require.main === module) main();
module.exports = { sameFile };
