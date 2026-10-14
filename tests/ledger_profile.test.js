'use strict';
// A run is judged by the profile it ran under. An edit made after it closed is the repo moving on,
// not tampering; an edit made while it ran is tampering, whatever the file says now.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SCRIPTS_DIR, mkTmpDir, mkRun, rmDir, ledger, settleDispatches, RUNNABLE_CONFIG, freezeRun, judge } = require('./helpers.js');
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

const PROFILE_REL = path.join('.agents', 'ticket-loop.config.json');
const AT_RUN = { ...RUNNABLE_CONFIG, dispatchPolicy: { maxRunTokens: 1000 } };
const LATER = { ...RUNNABLE_CONFIG, dispatchPolicy: { maxRunTokens: 5000 } };

function ok(root, args) {
  const res = ledger(root, args);
  assert.strictEqual(res.status, 0, `ledger ${args[0]} failed: ${res.stderr}`);
  return res;
}

function writeProfile(root, profile) {
  fs.writeFileSync(path.join(root, PROFILE_REL), JSON.stringify(profile, null, 2) + '\n');
}

function closedRun(beforeClose = () => {}) {
  const { root, runDir } = mkRun(AT_RUN);
  ok(root, ['init', runDir, 'abc']);
  freezeRun(root, runDir);
  assert.strictEqual(judge(root, runDir, 'APPROVE').status, 0);
  settleDispatches(root, runDir);
  beforeClose(root, runDir);
  fs.writeFileSync(path.join(runDir, 'report.md'), '# Report\n');
  ok(root, ['gate', runDir, 'report', '--evidence', path.join(runDir, 'report.md')]);
  ok(root, ['close', runDir]);
  return { root, runDir };
}

const verify = (root, runDir) => JSON.parse(ledger(root, ['verify', runDir]).stdout);
const status = (root, runDir) => JSON.parse(ok(root, ['status', runDir]).stdout);
const profileProblems = (report) => report.problems.filter((p) => p.includes('ticket-loop.config.json'));

test('a profile edited after the run closed is not tampering, and the run keeps the profile it ran under', () => {
  const { root, runDir } = closedRun();
  try {
    writeProfile(root, LATER);
    const report = verify(root, runDir);
    assert.deepStrictEqual(report.problems, [], 'the run verifies clean');
    assert.strictEqual(report.intact, true);
    assert.strictEqual(status(root, runDir).maxRunTokens, 1000, 'the ceiling is the one the run ran under');
  } finally {
    rmDir(root);
  }
});

test('a profile edited while the run was open is still TAMPERED after it closes', () => {
  const { root, runDir } = closedRun((r) => writeProfile(r, LATER));
  try {
    writeProfile(root, AT_RUN);
    const problems = profileProblems(verify(root, runDir));
    assert.strictEqual(problems.length, 1, 'restoring the file after close does not hide an edit made during the run');
    assert.match(problems[0], /TAMPERED/);
    assert.match(problems[0], /during the run/);
  } finally {
    rmDir(root);
  }
});

test('an open run is governed by its sealed profile, and an edit to the file is TAMPERED', () => {
  const { root, runDir } = mkRun(AT_RUN);
  try {
    ok(root, ['init', runDir, 'abc']);
    writeProfile(root, LATER);
    assert.strictEqual(status(root, runDir).maxRunTokens, 1000, 'editing the file mid-run does not raise the ceiling');
    assert.match(profileProblems(verify(root, runDir)).join('\n'), /TAMPERED/);
  } finally {
    rmDir(root);
  }
});

// Runs from before the profile was sealed whole carry only its hash. Their profile is recovered
// from git: the copy committed as of the close, accepted only when it hashes to the seal.
function git(root, args, date) {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const res = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
}

function legacyRun(sealed) {
  const root = mkTmpDir('tl-legacy');
  spawnSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  writeProfile(root, AT_RUN);
  git(root, ['add', '-A'], '2026-01-01T00:00:00Z');
  git(root, ['commit', '-qm', 'profile v1'], '2026-01-01T00:00:00Z');
  const runDir = path.join(root, '.agents', 'ticket-runs', 'T-1');
  fs.mkdirSync(runDir, { recursive: true });
  chain.create(runDir);
  if (!sealed) writeProfile(root, LATER);
  const init = chain.append(runDir, 'init', {
    baseSha: 'abc',
    maxDispatches: 25,
    maxReplans: 3,
    evidence: chain.hashEvidence([path.join(root, PROFILE_REL)]),
  });
  if (!sealed) writeProfile(root, AT_RUN);
  fs.writeFileSync(
    path.join(runDir, 'closed.json'),
    JSON.stringify({ closedAt: '2026-02-01T00:00:00.000Z', chainRecords: 1, lastSeal: init.hmac })
  );
  writeProfile(root, LATER);
  git(root, ['commit', '-qam', 'profile v2'], '2026-03-01T00:00:00Z');
  if (!sealed) writeProfile(root, { ...RUNNABLE_CONFIG, dispatchPolicy: { maxRunTokens: 9000 } });
  return { root, runDir };
}

test('a run from before whole-profile sealing is judged by the profile committed as of its close', () => {
  const { root, runDir } = legacyRun(true);
  try {
    assert.deepStrictEqual(profileProblems(verify(root, runDir)), []);
    assert.strictEqual(status(root, runDir).maxRunTokens, 1000);
  } finally {
    rmDir(root);
  }
});

test('a committed copy that does not match the seal recovers nothing, and the change is still reported', () => {
  const { root, runDir } = legacyRun(false);
  try {
    assert.match(profileProblems(verify(root, runDir)).join('\n'), /TAMPERED/);
  } finally {
    rmDir(root);
  }
});
