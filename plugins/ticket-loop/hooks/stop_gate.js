#!/usr/bin/env node
// Stop hook: before a "done" claim, verify every tree the session may have touched.
//
// "Did this session change code?" = changes since the BRANCH POINT (merge-base against the
// base ref) UNION anything uncommitted. A working-tree-only check is not enough: Stage 4
// commits after every green slice, so mid-run every tree is clean and the gate would pass
// without running a single test.
//
// Driven by the per-repo profile (.agents/ticket-loop.config.json -> hooks.stopGate);
// with no config (or no stopGate block) it is inert. Example block (Flutter):
//   "hooks": {
//     "stopGate": {
//       "extensions": [".dart"],
//       "exclude": "\\.(g|freezed|tailor|gr|config|gen)\\.dart$",
//       "mode": "targeted",                          // "targeted" | "full"
//       "worktrees": "all",                          // "all" | "ticket" | "cwd"
//       "baseRef": "main",                           // branch point for committed changes
//       "branchPrefixes": ["refs/heads/ticket/"],    // only used by worktrees:"ticket"
//       "requireMatchingTest": false,                // targeted: block if a source file has no test
//       "testDir": "test",                           // targeted mode only
//       "testSuffix": "_test.dart",                  //   "
//       "excludeTests": ["test/golden/", "_golden_test.dart"],
//       "testCommand": "flutter test {targets} --reporter compact",
//       "flakeSignatures": ["PathExistsException", "errno = 183"],
//       "failureMarkers": ["Some tests failed", "Expected:", "Actual:"],
//       "timeoutMs": 240000                          // floored at 30s; a timeout BLOCKS
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
// A config-supplied timeout of 50ms would turn every run into a "could not verify" pass.
const MIN_TEST_TIMEOUT_MS = 30000;
const DEFAULT_BRANCH_PREFIXES = ['refs/heads/ticket/'];
const BASE_REF_CANDIDATES = ['origin/HEAD', 'origin/main', 'main', 'origin/master', 'master'];
const MISSING_COMMAND = /command not found|not recognized as an internal or external|is not recognized as|No such file or directory/i;

function git(cwd, args, timeout = 15000) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout });
}

// State is scoped to the session: a stale file from another session, or one without the
// session marker this gate always writes, must not pre-open the escape valve. The count is
// also clamped, so a seeded absurd value cannot bank future releases.
//
// Residual, documented in the README: when the harness supplies no session_id the fallback
// marker is guessable, so a seed planted BEFORE the run starts can still shorten the valve.
// freeze_guard denies writes here once a run is active, releasing the valve prints loudly
// that the suite is not green, and no green `verify` receipt is created either way — so the
// abuse buys a noisy stop, not a clean report.
function readState(root, sessionId) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8'));
    if (s.sessionId !== sessionId) return { sessionId, consecutiveBlocks: 0 };
    const n = Number(s.consecutiveBlocks);
    if (!Number.isInteger(n) || n < 0) return { sessionId, consecutiveBlocks: 0 };
    return { sessionId, consecutiveBlocks: Math.min(n, MAX_CONSECUTIVE_BLOCKS) };
  } catch {
    return { sessionId, consecutiveBlocks: 0 };
  }
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
      current = { path: line.slice('worktree '.length).trim(), branch: null, detached: false };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    } else if (current && line.trim() === 'detached') {
      current.detached = true;
    } else if (line.trim() === '' && current) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out;
}

// Default "all" so a detached-HEAD worktree, or one on feature/* rather than ticket/*, is
// still covered. Clean trees cost nothing to include.
function treesToCheck(root, conf) {
  const mode = conf.worktrees || 'all';
  const trees = [path.resolve(root)];
  if (mode === 'cwd') return trees;

  const res = git(root, ['worktree', 'list', '--porcelain']);
  if (res.status !== 0) return trees;

  const prefixes = conf.branchPrefixes || DEFAULT_BRANCH_PREFIXES;
  for (const wt of parseWorktrees(res.stdout || '')) {
    if (mode === 'ticket' && !(wt.branch && prefixes.some((p) => wt.branch.startsWith(p)))) continue;
    const abs = path.resolve(wt.path);
    if (!trees.includes(abs) && fs.existsSync(abs)) trees.push(abs);
  }
  return trees;
}

function resolveBaseRef(tree, conf) {
  const candidates = [conf.baseRef, ...BASE_REF_CANDIDATES].filter(Boolean);
  for (const ref of candidates) {
    if (git(tree, ['rev-parse', '--verify', '--quiet', ref]).status === 0) return ref;
  }
  return null;
}

function applyFilters(files, conf) {
  let exclude = null;
  if (conf.exclude) {
    try {
      exclude = new RegExp(conf.exclude);
    } catch {
      exclude = null;
    }
  }
  return files
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => (conf.extensions || []).some((ext) => f.endsWith(ext)))
    .filter((f) => !(exclude && exclude.test(f)));
}

// Uncommitted work (git status) UNION committed-on-this-branch work (merge-base..HEAD).
// Returns { files, baseRef } — a null baseRef means only uncommitted work could be seen.
function changedSourceFiles(tree, conf) {
  const found = new Set();

  const status = git(tree, ['status', '--porcelain']);
  if (status.status === 0) {
    const uncommitted = (status.stdout || '')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.slice(3).trim().replace(/"/g, ''))
      .map((f) => (f.includes(' -> ') ? f.split(' -> ').pop() : f));
    applyFilters(uncommitted, conf).forEach((f) => found.add(f));
  }

  const baseRef = resolveBaseRef(tree, conf);
  if (baseRef) {
    const mb = git(tree, ['merge-base', 'HEAD', baseRef]);
    if (mb.status === 0 && mb.stdout.trim()) {
      const diff = git(tree, ['diff', '--name-only', `${mb.stdout.trim()}..HEAD`], 30000);
      if (diff.status === 0) {
        applyFilters((diff.stdout || '').split('\n').filter(Boolean), conf).forEach((f) => found.add(f));
      }
    }
  }

  return { files: [...found], baseRef };
}

function walkTests(dir, suffix, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
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
  const unmatched = [];
  for (const f of changed) {
    if (f.endsWith(suffix) && all.includes(f)) {
      targets.add(f);
      continue;
    }
    const base = path.basename(f).replace(/\.[^.]+$/, '');
    const hits = all.filter((t) => t.endsWith(`/${base}${suffix}`) || t === `${base}${suffix}`);
    if (hits.length === 0) unmatched.push(f);
    hits.forEach((t) => targets.add(t));
  }
  return { targets: [...targets], allTests: all, unmatched };
}

function looksLikeFlake(output, conf) {
  const sigs = conf.flakeSignatures || [];
  const markers = conf.failureMarkers || [];
  if (sigs.length === 0) return false;
  return sigs.some((s) => output.includes(s)) && !markers.some((m) => output.includes(m));
}

// Run the verification for one tree. Returns { ok, skipped?, note?, tail? }.
function verifyTree(tree, conf, verifyTest) {
  const { files: changed, baseRef } = changedSourceFiles(tree, conf);
  if (changed.length === 0) return { ok: true, skipped: true };

  const notes = [];
  if (!baseRef) {
    notes.push(
      `stop_gate: ${tree}: no base ref resolved (tried hooks.stopGate.baseRef, ${BASE_REF_CANDIDATES.join(', ')}) — ` +
        `only UNCOMMITTED changes were considered. Set hooks.stopGate.baseRef so committed slices are seen.`
    );
  }

  const timeoutMs = Math.max(conf.timeoutMs || DEFAULT_TEST_TIMEOUT_MS, MIN_TEST_TIMEOUT_MS);
  let run;
  if ((conf.mode || 'full') === 'full') {
    if (!verifyTest) {
      return { ok: true, skipped: true, note: `stop_gate: ${tree}: source files changed but no verify.test configured — NOT verified.` };
    }
    run = () => lib.runShell(verifyTest, { cwd: tree, timeoutMs });
  } else {
    const { targets, unmatched } = mapTargets(tree, changed, conf);
    if (targets.length === 0) {
      const note =
        `stop_gate: ${tree}: ${changed.length} changed source file(s) with NO matching test file ` +
        `(${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}).`;
      if (conf.requireMatchingTest) {
        return { ok: false, tail: `${note}\nhooks.stopGate.requireMatchingTest is on — add a test or set it to false.` };
      }
      return { ok: true, skipped: true, note: `${note} Not blocking (set hooks.stopGate.requireMatchingTest to block), but this code is UNVERIFIED.` };
    }
    if (unmatched.length && conf.requireMatchingTest) {
      return { ok: false, tail: `stop_gate: ${tree}: no test maps to ${unmatched.join(', ')} (requireMatchingTest is on).` };
    }
    if (!conf.testCommand) {
      return { ok: true, skipped: true, note: `stop_gate: ${tree}: targeted mode without hooks.stopGate.testCommand — NOT verified.` };
    }
    const argv = lib.buildArgv(conf.testCommand, { '{targets}': targets });
    run = () => lib.runArgv(argv, { cwd: tree, timeoutMs });
  }

  const attempt = () => {
    const res = run();
    const output = lib.combinedOutput(res);
    // A timeout is NOT "could not verify" — an unbounded suite must block, or timeoutMs
    // becomes a one-line way to disable this gate.
    if (res.error && res.error.code === 'ETIMEDOUT') {
      return { verdict: 'timeout', res, output };
    }
    if (res.error) return { verdict: 'unrunnable', res, output, why: res.error.message };
    // shell:true reports a missing binary as a normal non-zero exit, so detect it by output.
    if (res.status !== 0 && (res.status === 127 || MISSING_COMMAND.test(output))) {
      return { verdict: 'unrunnable', res, output, why: 'test command not found' };
    }
    return { verdict: res.status === 0 ? 'pass' : 'fail', res, output };
  };

  const finish = (result) => (notes.length ? { ...result, note: [notes.join('\n'), result.note].filter(Boolean).join('\n') } : result);

  let a = attempt();
  if (a.verdict === 'timeout') {
    return finish({
      ok: false,
      tail: `stop_gate: ${tree}: test command exceeded ${timeoutMs}ms and was killed. An unverifiable suite is treated as RED.`,
    });
  }
  if (a.verdict === 'unrunnable') {
    return finish({ ok: true, skipped: true, note: `stop_gate: ${tree}: test command failed to run (${a.why}) — NOT verified.` });
  }
  if (a.verdict === 'pass') return finish({ ok: true });

  if (looksLikeFlake(a.output, conf)) {
    const b = attempt();
    if (b.verdict === 'pass') return finish({ ok: true });
    if (b.verdict === 'timeout') {
      return finish({ ok: false, tail: `stop_gate: ${tree}: test command timed out on the flake retry. Treated as RED.` });
    }
    if (b.verdict === 'unrunnable') {
      return finish({ ok: true, skipped: true, note: `stop_gate: ${tree}: test command failed to run on retry (${b.why}) — NOT verified.` });
    }
    if (looksLikeFlake(b.output, conf)) {
      return finish({
        ok: true,
        skipped: true,
        note: `stop_gate: ${tree}: tests could not run cleanly twice (tooling flake) — NOT blocking, but the suite was NOT verified. Re-run manually.`,
      });
    }
    a = b;
  }
  return finish({ ok: false, tail: lib.tail(a.output, TAIL_LINES) });
}

// A run dir that has been initialized and not CLOSED. Mirrors freeze_guard.activeRuns —
// closed.json, not report.md, because the run's own deliverable must not be its off switch.
function activeRuns(root) {
  const runsDir = path.join(root, '.agents', 'ticket-runs');
  try {
    return fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.includes('._old_'))
      .map((e) => path.join(runsDir, e.name))
      .filter((d) => fs.existsSync(path.join(d, 'budget.json')) && !fs.existsSync(path.join(d, 'closed.json')));
  } catch {
    return [];
  }
}

function main() {
  const input = lib.readStdinJson() || {};
  const sessionId = input.session_id || 'no-session';
  const { found, root, config, error } = lib.loadConfig();
  if (error) console.error(`stop_gate: ${error} — gate is inert until the config parses.`);
  const conf = found && config.hooks && config.hooks.stopGate;

  // Being inert is fine when nobody is running a ticket. It is NOT fine mid-run: a missing,
  // unparsable, or stopGate-less profile is exactly what disarming this gate looks like, and
  // silently exiting 0 would let that pass as "verified".
  if (!conf) {
    const runs = activeRuns(root);
    if (runs.length > 0) {
      console.error(
        `stop_gate: a ticket run is ACTIVE (${runs.map((r) => path.basename(r)).join(', ')}) but there is no usable ` +
          `hooks.stopGate config${error ? ` (${error})` : ''} — refusing to confirm a "done" claim it cannot verify.\n` +
          `  Restore .agents/ticket-loop.config.json (its hash is sealed in the run's init receipt: ` +
          `"ledger.js verify <runDir>" will show the drift), or archive the run.`
      );
      process.exit(2);
    }
    process.exit(0);
  }

  const state = readState(root, sessionId);
  if (input.stop_hook_active && state.consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
    console.error(`stop_gate: still red after ${state.consecutiveBlocks} blocks — allowing stop. Suite is NOT green.`);
    writeState(root, { sessionId: state.sessionId, consecutiveBlocks: 0 });
    process.exit(0);
  }

  const verifyTest = config.verify && config.verify.test;
  const failures = [];
  for (const tree of treesToCheck(root, conf)) {
    const result = verifyTree(tree, conf, verifyTest);
    if (result.note) console.error(result.note);
    if (!result.ok) failures.push({ tree, tail: result.tail });
  }

  if (failures.length === 0) {
    writeState(root, { sessionId: state.sessionId, consecutiveBlocks: 0 });
    process.exit(0);
  }
  writeState(root, { sessionId: state.sessionId, consecutiveBlocks: state.consecutiveBlocks + 1 });
  for (const f of failures) {
    console.error(`stop_gate: tests FAILED in ${f.tree}:\n${f.tail}`);
  }
  process.exit(2);
}

if (require.main === module) main();
module.exports = { parseWorktrees, changedSourceFiles, mapTargets, looksLikeFlake, verifyTree, treesToCheck, readState };
