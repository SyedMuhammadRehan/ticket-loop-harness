'use strict';
// The stop gate's verdict IS the exit code of verify.test, so a command that cannot exit
// non-zero reports every turn-end green while proving nothing. These are the shapes that do
// that, and the near-misses that must stay silent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkFakeRepo, rmDir, runScript } = require('./helpers.js');

const SCRIPT = path.join(SCRIPTS_DIR, 'load_config.js');
const MARKER = 'cannot report a failure';

function warningsFor(repo, opts = {}) {
  const res = runScript(SCRIPT, [], { cwd: repo, env: opts.env });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout)._meta.warnings.filter((w) => w.includes(MARKER));
}

// A repo whose suite is real: an entrypoint, plus one named test for a filter to match.
function mkRepoWithSuite(verifyTest, opts = {}) {
  const repo = mkFakeRepo({ verify: { test: verifyTest } });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'tests', 'run.js'),
    opts.entrypoint === undefined ? "spawnSync(process.execPath, ['--test']);\n" : opts.entrypoint
  );
  fs.writeFileSync(
    path.join(repo, 'tests', 'sample.test.js'),
    (opts.testNames || ['adds two numbers']).map((n) => `test('${n}', () => {});`).join('\n')
  );
  return repo;
}

test('a filter matching no test in the repo is reported as unfalsifiable', () => {
  const repo = mkRepoWithSuite('node tests/run.js --test-name-pattern=no-such-test-exists');
  try {
    const found = warningsFor(repo);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.ok(found[0].includes('node tests/run.js --test-name-pattern=no-such-test-exists'), found[0]);
    assert.ok(found[0].includes('no-such-test-exists'), found[0]);
  } finally {
    rmDir(repo);
  }
});

// The rule is "matches nothing", not "has a filter" — a filter that selects real tests can
// still go red, and warning about it would train the reader to ignore the warning.
test('a filter that does match a test in the repo is left alone', () => {
  const repo = mkRepoWithSuite('node tests/run.js --test-name-pattern=adds');
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

test('an entrypoint that exits 0 when an unset env var is absent is reported', () => {
  const repo = mkRepoWithSuite('node tests/run.js', {
    entrypoint: "if (!process.env.RUN_TESTS) process.exit(0);\nrequire('./sample.test.js');\n",
  });
  try {
    const found = warningsFor(repo);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.ok(found[0].includes('node tests/run.js'), found[0]);
    assert.ok(found[0].includes('RUN_TESTS'), found[0]);
  } finally {
    rmDir(repo);
  }
});

// Same repo, same command: only the environment preflight can actually see decides it.
test('the same entrypoint is not reported when the env var is set at preflight', () => {
  const repo = mkRepoWithSuite('node tests/run.js', {
    entrypoint: "if (!process.env.RUN_TESTS) process.exit(0);\nrequire('./sample.test.js');\n",
  });
  try {
    assert.deepStrictEqual(warningsFor(repo, { env: { RUN_TESTS: '1' } }), []);
  } finally {
    rmDir(repo);
  }
});

// --- the exit code never reaches the caller -------------------------------------------

test('a || true tail is reported as unfalsifiable', () => {
  const repo = mkRepoWithSuite('node tests/run.js || true');
  try {
    const found = warningsFor(repo);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.ok(found[0].includes('node tests/run.js || true'), found[0]);
    assert.ok(found[0].includes('|| true'), found[0]);
  } finally {
    rmDir(repo);
  }
});

test('a trailing ; exit 0 is reported as unfalsifiable', () => {
  const repo = mkRepoWithSuite('node tests/run.js ; exit 0');
  try {
    const found = warningsFor(repo);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.ok(found[0].includes('node tests/run.js ; exit 0'), found[0]);
    assert.ok(found[0].includes('exit 0'), found[0]);
  } finally {
    rmDir(repo);
  }
});

test('an inline -e program is reported as unfalsifiable', () => {
  const repo = mkRepoWithSuite('node -e "process.exit(0)"');
  try {
    const found = warningsFor(repo);
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.ok(found[0].includes('node -e "process.exit(0)"'), found[0]);
  } finally {
    rmDir(repo);
  }
});

// A conditional the suite can still fail out of is not the same as a discarded exit code.
test('a && tail that depends on the suite passing is left alone', () => {
  const repo = mkRepoWithSuite('node tests/run.js && echo ok');
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});
