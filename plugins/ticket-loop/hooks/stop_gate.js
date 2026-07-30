#!/usr/bin/env node
// Stop hook: before a "done" claim, verify every tree the session may have touched —
// the MAIN repo AND every active ticket/* worktree (the loop implements in worktrees,
// so a cwd-only check would verify the wrong tree and never fire during a run).
// Driven by the per-repo profile (.agents/ticket-loop.config.json -> hooks.stopGate);
// with no config (or no stopGate block) it is inert. Example block (Flutter):
//   "hooks": {
//     "stopGate": {
//       "extensions": [".dart"],
//       "exclude": "\\.(g|freezed|tailor|gr|config|gen)\\.dart$",
//       "mode": "targeted",                          // "targeted" | "full"
//       "testDir": "test",                           // targeted mode only
//       "testSuffix": "_test.dart",                  //   "
//       "excludeTests": ["test/golden/", "_golden_test.dart"],
//       "testCommand": "flutter test {targets} --reporter compact",
//       "flakeSignatures": ["PathExistsException", "errno = 183"],
//       "failureMarkers": ["Some tests failed", "Expected:", "Actual:"],
//       "timeoutMs": 240000
//     }
//   }
// mode "full" ignores testDir/testSuffix/testCommand and runs verify.test per dirty tree.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./hook_lib.js');

const STATE_FILE = path.join('.claude', 'hooks', 'state', 'stop-state.json');
const MAX_CONSECUTIVE_BLOCKS = 3;
const TAIL_LINES = 80;
const DEFAULT_TEST_TIMEOUT_MS = 240000;
const TICKET_BRANCH_PREFIX = 'refs/heads/ticket/';

function readState(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8')); } catch { return { consecutiveBlocks: 0 }; }
}
function writeState(root, s) {
  const p = path.join(root, STATE_FILE);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s));
  } catch {
    console.error('stop_gate: state write failed - escape valve may not engage');
  }
}

function parseWorktrees(porcelain) {
  const out = [];
  let current = null;
  for (const line of String(porcelain).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) out.push(current);
      current = { path: line.slice('worktree '.length).trim(), branch: null };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.trim() === '' && current) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out;
}

function treesToCheck(root) {
  const trees = [path.resolve(root)];
  const res = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (res.status === 0) {
    for (const wt of parseWorktrees(res.stdout || '')) {
      if (wt.branch && wt.branch.startsWith(TICKET_BRANCH_PREFIX)) {
        const abs = path.resolve(wt.path);
        if (!trees.includes(abs)) trees.push(abs);
      }
    }
  }
  return trees;
}

function changedSourceFiles(tree, conf) {
  const res = spawnSync('git', ['-C', tree, 'status', '--porcelain'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (res.status !== 0) return [];
  let exclude = null;
  if (conf.exclude) {
    try { exclude = new RegExp(conf.exclude); } catch { exclude = null; }
  }
  return (res.stdout || '')
    .split('\n')
    .map((l) => l.slice(3).trim().replace(/"/g, ''))
    .map((f) => (f.includes(' -> ') ? f.split(' -> ').pop() : f))
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => (conf.extensions || []).some((ext) => f.endsWith(ext)))
    .filter((f) => !(exclude && exclude.test(f)));
}

function walkTests(dir, suffix, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkTests(full, suffix, acc);
    else if (e.name.endsWith(suffix)) acc.push(full.replace(/\\/g, '/'));
  }
  return acc;
}

// Targeted mode: map changed files to test files (tree-relative paths).
// A changed test file is its own target; a changed source file maps by basename
// to <testDir>/**/<basename><testSuffix>.
function mapTargets(tree, changed, conf) {
  const suffix = conf.testSuffix || '_test';
  const testDirAbs = path.join(tree, conf.testDir || 'test').replace(/\\/g, '/');
  const excludeTests = conf.excludeTests || [];
  const all = walkTests(testDirAbs, suffix, [])
    .map((t) => path.relative(tree, t).replace(/\\/g, '/'))
    .filter((t) => !excludeTests.some((pat) => t.includes(pat)));
  const targets = new Set();
  for (const f of changed) {
    if (f.endsWith(suffix) && all.includes(f)) {
      targets.add(f);
      continue;
    }
    const base = path.basename(f).replace(/\.[^.]+$/, '');
    all.filter((t) => t.endsWith(`/${base}${suffix}`) || t === `${base}${suffix}`)
      .forEach((t) => targets.add(t));
  }
  return { targets: [...targets], allTests: all };
}

function looksLikeFlake(output, conf) {
  const sigs = conf.flakeSignatures || [];
  const markers = conf.failureMarkers || [];
  if (sigs.length === 0) return false;
  return sigs.some((s) => output.includes(s)) && !markers.some((m) => output.includes(m));
}

// Run the verification for one tree. Returns { ok, skipped?, note?, tail? }.
function verifyTree(tree, conf, verifyTest) {
  const changed = changedSourceFiles(tree, conf);
  if (changed.length === 0) return { ok: true, skipped: true };

  const timeoutMs = conf.timeoutMs || DEFAULT_TEST_TIMEOUT_MS;
  let run;
  if ((conf.mode || 'full') === 'full') {
    if (!verifyTest) {
      return { ok: true, skipped: true, note: `stop_gate: ${tree}: source files changed but no verify.test configured — NOT verified.` };
    }
    run = () => lib.runShell(verifyTest, { cwd: tree, timeoutMs });
  } else {
    const { targets } = mapTargets(tree, changed, conf);
    if (targets.length === 0) {
      return {
        ok: true,
        skipped: true,
        note: `stop_gate: NOTE — ${tree}: source files changed with no matching test files. Not blocking, but consider adding a test (or confirm none is needed).`,
      };
    }
    if (!conf.testCommand) {
      return { ok: true, skipped: true, note: `stop_gate: ${tree}: targeted mode without hooks.stopGate.testCommand — NOT verified.` };
    }
    const argv = lib.buildArgv(conf.testCommand, { '{targets}': targets });
    run = () => lib.runArgv(argv, { cwd: tree, timeoutMs });
  }

  let res = run();
  if (res.error) {
    return { ok: true, skipped: true, note: `stop_gate: ${tree}: test command failed to run (${res.error.message}) — NOT verified.` };
  }
  if (res.status === 0) return { ok: true };

  if (looksLikeFlake(lib.combinedOutput(res), conf)) {
    res = run();
    if (res.error) {
      return { ok: true, skipped: true, note: `stop_gate: ${tree}: test command failed to run on retry (${res.error.message}) — NOT verified.` };
    }
    if (res.status === 0) return { ok: true };
    if (looksLikeFlake(lib.combinedOutput(res), conf)) {
      return {
        ok: true,
        skipped: true,
        note: `stop_gate: ${tree}: tests could not run cleanly twice (tooling flake) — NOT blocking, but the suite was NOT verified. Re-run manually.`,
      };
    }
  }
  return { ok: false, tail: lib.tail(lib.combinedOutput(res), TAIL_LINES) };
}

function main() {
  const input = lib.readStdinJson() || {};
  const { found, root, config, error } = lib.loadConfig();
  if (error) console.error(`stop_gate: ${error} — gate is inert until the config parses.`);
  const conf = found && config.hooks && config.hooks.stopGate;
  if (!conf) process.exit(0);

  const state = readState(root);
  if (input.stop_hook_active && state.consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
    console.error(`stop_gate: still red after ${state.consecutiveBlocks} blocks — allowing stop. Suite is NOT green.`);
    writeState(root, { consecutiveBlocks: 0 });
    process.exit(0);
  }

  const verifyTest = config.verify && config.verify.test;
  const failures = [];
  for (const tree of treesToCheck(root)) {
    const result = verifyTree(tree, conf, verifyTest);
    if (result.note) console.error(result.note);
    if (!result.ok) failures.push({ tree, tail: result.tail });
  }

  if (failures.length === 0) {
    writeState(root, { consecutiveBlocks: 0 });
    process.exit(0);
  }
  writeState(root, { consecutiveBlocks: state.consecutiveBlocks + 1 });
  for (const f of failures) {
    console.error(`stop_gate: tests FAILED in ${f.tree}:\n${f.tail}`);
  }
  process.exit(2);
}

if (require.main === module) main();
module.exports = { parseWorktrees, changedSourceFiles, mapTargets, looksLikeFlake, verifyTree };
