#!/usr/bin/env node
// Stop hook: run tests for changed .dart files; red tests block the done-claim.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join('.claude', 'hooks', 'state', 'stop-state.json');
const MAX_CONSECUTIVE_BLOCKS = 3;
const TAIL_LINES = 80;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { consecutiveBlocks: 0 }; }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {
    console.error('stop_gate: state write failed - escape valve may not engage');
  }
}
function changedDartFiles() {
  const res = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', timeout: 15000 });
  if (res.status !== 0) return [];
  return (res.stdout || '')
    .split('\n')
    .map((l) => l.slice(3).trim().replace(/"/g, ''))
    .map((f) => (f.includes(' -> ') ? f.split(' -> ').pop() : f))
    .filter((f) => f.endsWith('.dart'))
    .filter((f) => !/\.(g|freezed|tailor|gr|config|gen)\.dart$/.test(f));
}
function walkTests(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkTests(full, acc);
    else if (e.name.endsWith('_test.dart')) acc.push(full.replace(/\\/g, '/'));
  }
  return acc;
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
  const state = readState();

  const changed = changedDartFiles();
  if (changed.length === 0) { writeState({ consecutiveBlocks: 0 }); process.exit(0); }

  if (input.stop_hook_active && state.consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
    console.error(`stop_gate: still red after ${state.consecutiveBlocks} blocks — allowing stop. Suite is NOT green.`);
    writeState({ consecutiveBlocks: 0 });
    process.exit(0);
  }

  const allTests = walkTests('test', []);
  const goldenFree = allTests.filter((t) => !t.includes('test/golden/') && !t.endsWith('_golden_test.dart'));
  const targets = new Set();
  for (const f of changed) {
    const norm = f.replace(/\\/g, '/');
    if (norm.endsWith('_test.dart') && goldenFree.includes(norm)) targets.add(norm);
    else if (norm.startsWith('lib/')) {
      const base = path.basename(norm, '.dart');
      goldenFree.filter((t) => t.endsWith(`/${base}_test.dart`)).forEach((t) => targets.add(t));
    }
  }

  // A missing test is a soft signal (warn); only a red test blocks.
  const libChangedWithoutTests = changed.some((f) => f.replace(/\\/g, '/').startsWith('lib/')) && targets.size === 0;
  if (libChangedWithoutTests) {
    console.error(
      'stop_gate: NOTE — lib/ files changed with no matching *_test.dart. Not blocking, ' +
      'but consider adding a test (or confirm none is needed).'
    );
    writeState({ consecutiveBlocks: 0 });
    process.exit(0);
  }
  if (targets.size === 0) { writeState({ consecutiveBlocks: 0 }); process.exit(0); }

  // flutter is flutter.bat on Windows: shell-less .bat spawns throw EINVAL, but shell:true
  // space-joins argv into cmd.exe — so pre-quote our own (trusted) path args for space-safety.
  const isWindows = process.platform === 'win32';
  const rawArgs = ['test', ...targets, '--reporter', 'compact'];
  const args = isWindows
    ? rawArgs.map((a) => (a.startsWith('-') ? a : `"${a}"`))
    : rawArgs;

  // A non-zero exit from a build-cache/compiler collision is a tooling flake, not a red test.
  const FLAKE_SIGNATURES = [
    'PathExistsException',
    'errno = 183',
    'flutter_test_compiler',
    'Cannot create a file when that file already exists',
  ];
  const REAL_FAILURE_MARKERS = ['Some tests failed', 'Expected:', 'Actual:'];
  const runTests = () => spawnSync('flutter', args, { encoding: 'utf8', timeout: 240000, shell: isWindows });
  const combined = (r) => `${r.stdout || ''}\n${r.stderr || ''}`;
  const looksLikeFlake = (out) =>
    FLAKE_SIGNATURES.some((s) => out.includes(s)) &&
    !REAL_FAILURE_MARKERS.some((m) => out.includes(m));

  let res = runTests();
  if (res.status === 0) { writeState({ consecutiveBlocks: 0 }); process.exit(0); }

  if (looksLikeFlake(combined(res))) {
    res = runTests();
    if (res.status === 0) { writeState({ consecutiveBlocks: 0 }); process.exit(0); }
    if (looksLikeFlake(combined(res))) {
      console.error(
        'stop_gate: flutter test could not run cleanly twice (tooling flake, e.g. ' +
        'build/test_cache collision) — NOT blocking, but the suite was NOT verified. ' +
        'Re-run tests manually if you changed code.'
      );
      writeState({ consecutiveBlocks: 0 });
      process.exit(0);
    }
  }

  const tail = combined(res).split('\n').slice(-TAIL_LINES).join('\n');
  writeState({ consecutiveBlocks: state.consecutiveBlocks + 1 });
  console.error(`stop_gate: targeted tests FAILED (${[...targets].join(', ')}):\n${tail}`);
  process.exit(2);
}
main();
