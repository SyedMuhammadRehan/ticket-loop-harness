'use strict';
// The stop gate's verdict IS the exit code of verify.test, so a command that cannot exit
// non-zero reports every turn-end green while proving nothing. These are the shapes that do
// that, and the near-misses that must stay silent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, SCRIPTS_DIR, mkFakeRepo, rmDir, runScript } = require('./helpers.js');

const SCRIPT = path.join(SCRIPTS_DIR, 'load_config.js');
const MARKER = 'cannot report a failure';

function warningsFor(repo) {
  const res = runScript(SCRIPT, [], { cwd: repo });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout)._meta.warnings.filter((w) => w.includes(MARKER));
}

function withProfile(command) {
  return mkFakeRepo({ verify: { test: command } });
}

// --- the exit code never reaches the caller ---------------------------------------------

test('a || true tail is reported as unfalsifiable', () => {
  const repo = withProfile('node tests/run.js || true');
  try {
    const found = warningsFor(repo);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.ok(found[0].includes('node tests/run.js || true'), found[0]);
    assert.ok(found[0].includes('|| true'), found[0]);
  } finally {
    rmDir(repo);
  }
});

test('every success-forcing tail is recognised', () => {
  for (const command of [
    'node tests/run.js || true',
    'node tests/run.js || :',
    'node tests/run.js || exit 0',
    'node tests/run.js || echo "tests failed"',
  ]) {
    const repo = withProfile(command);
    try {
      assert.strictEqual(warningsFor(repo).length, 1, command);
    } finally {
      rmDir(repo);
    }
  }
});

test('a trailing ; exit 0 is reported as unfalsifiable', () => {
  const repo = withProfile('node tests/run.js ; exit 0');
  try {
    const found = warningsFor(repo);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.ok(found[0].includes('node tests/run.js ; exit 0'), found[0]);
    assert.ok(found[0].includes('exit 0'), found[0]);
  } finally {
    rmDir(repo);
  }
});

// A conditional the suite can still fail out of is not the same as a discarded exit code.
test('a && tail that depends on the suite passing is left alone', () => {
  for (const command of ['node tests/run.js && echo ok', 'node tests/run.js && exit 0']) {
    const repo = withProfile(command);
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

// --- an inline program in place of the suite ---------------------------------------------

test('an inline -e program is reported as unfalsifiable', () => {
  const repo = withProfile('node -e "process.exit(0)"');
  try {
    const found = warningsFor(repo);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.ok(found[0].includes('node -e "process.exit(0)"'), found[0]);
  } finally {
    rmDir(repo);
  }
});

test('an inline program is reported for each interpreter that has one', () => {
  for (const command of ['node -e "process.exit(0)"', 'python -c "pass"', 'bash -c "true"']) {
    const repo = withProfile(command);
    try {
      assert.strictEqual(warningsFor(repo).length, 1, command);
    } finally {
      rmDir(repo);
    }
  }
});

// -e and -p mean unrelated things to other tools: pytest's plugin flag, Go's parallelism flag,
// Maven's error flag, RSpec's example filter. Every one of these runs a real suite.
test('an eval-shaped flag belonging to another tool is left alone', () => {
  for (const command of [
    'pytest -p no:cacheprovider',
    'pytest -q -p no:randomly',
    'go test ./... -p 4',
    'mvn -e test',
    'bundle exec rspec -e login',
    'bundle exec rspec -e pass',
  ]) {
    const repo = withProfile(command);
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

test('a shell wrapper around the real suite is left alone', () => {
  for (const command of [
    'sh -c "node tests/run.js"',
    'bash -c "npm test"',
    'python -c "import pytest; pytest.main()"',
    "ruby -e \"require './spec'\"",
  ]) {
    const repo = withProfile(command);
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

test('a constant-success inline program followed by the real suite is left alone', () => {
  for (const command of ['sh -c "true" && node tests/run.js', 'bash -c "pass" ; node tests/run.js']) {
    const repo = withProfile(command);
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

// --- no false positives ------------------------------------------------------------------

// The warning is only worth anything if a reader believes it, so the profiles already in this
// repo and its own suite have to stay silent.
test("this repo's own profile is not reported", () => {
  const res = runScript(SCRIPT, [], { cwd: REPO_ROOT });
  assert.strictEqual(res.status, 0, res.stderr);
  const cfg = JSON.parse(res.stdout);
  assert.strictEqual(cfg.verify.test, 'node tests/run.js');
  assert.deepStrictEqual(cfg._meta.warnings.filter((w) => w.includes(MARKER)), []);
});

test('the profiles used by the existing load_config tests are not reported', () => {
  for (const command of ['pytest -q', 'go test ./...', 'x', 'node check.js']) {
    const repo = withProfile(command);
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

// --- the shapes this deliberately does not decide -----------------------------------------

// Not misses to be fixed: deciding either one needs the runner's discovery and naming
// reconstructed, or a guard condition evaluated and every failing path ruled out. Six
// adversarial rounds each found one more spelling past whatever rule bounded them. Re-adding a
// rule here is a design decision, and this test is what makes that decision visible.
test('a filter that matches nothing is NOT decided, and stays silent', () => {
  const repo = withProfile('node tests/run.js --test-name-pattern=no-such-test-exists');
  try {
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tests', 'sample.test.js'), "test('adds two numbers', () => {});");
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

test('an entrypoint that disables itself is NOT decided, and stays silent', () => {
  const repo = withProfile('node tests/run.js');
  try {
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'tests', 'run.js'),
      'if (!process.env.RUN_TESTS) process.exit(0);\nrunSuite();\n'
    );
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

// --- advisory, and unable to break preflight ----------------------------------------------

test('an unfalsifiable profile still resolves completely and exits 0', () => {
  for (const command of ['node tests/run.js || true', 'node tests/run.js ; exit 0', 'node -e "process.exit(0)"']) {
    const repo = withProfile(command);
    try {
      const res = runScript(SCRIPT, [], { cwd: repo });
      assert.strictEqual(res.status, 0, res.stderr);
      const cfg = JSON.parse(res.stdout);
      assert.strictEqual(cfg.verify.test, command);
      assert.strictEqual(cfg._meta.configFound, true);
      assert.ok(Array.isArray(cfg.riskPaths));
      assert.ok(cfg._meta.warnings.some((w) => w.includes(MARKER)), command);
    } finally {
      rmDir(repo);
    }
  }
});

test('an exotic or malformed command yields no warning and no crash', () => {
  for (const command of ['', '   ', '-e', 'node -e', '|| true', '"unclosed', 'node\ttests/run.js']) {
    const repo = withProfile(command);
    try {
      const res = runScript(SCRIPT, [], { cwd: repo });
      assert.strictEqual(res.status, 0, `${JSON.stringify(command)}: ${res.stderr}`);
      JSON.parse(res.stdout);
    } finally {
      rmDir(repo);
    }
  }
});

// C6 needs a test of its own: load_config.js is already cited by row 30, so invariants.test.js
// stays green when row 48 is deleted.
test('INVARIANTS.md carries a row for this mechanism', () => {
  const table = fs.readFileSync(path.join(REPO_ROOT, 'INVARIANTS.md'), 'utf8');
  assert.ok(
    /^\|.*`verify_falsifiable\.js` → `verifyTestWarnings`.*$/m.test(table),
    'no INVARIANTS row cites verifyTestWarnings'
  );
});
