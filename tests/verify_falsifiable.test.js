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
    opts.sample || (opts.testNames || ['adds two numbers']).map((n) => `test('${n}', () => {});`).join('\n')
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

// --- no false positives ----------------------------------------------------------------

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
  for (const command of ['pytest -q', 'go test ./...', 'x']) {
    const repo = mkFakeRepo({ verify: { test: command } });
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

// --- advisory, and unable to break preflight -------------------------------------------

test('an unfalsifiable profile still resolves completely and exits 0', () => {
  for (const command of [
    'node tests/run.js || true',
    'node tests/run.js ; exit 0',
    'node -e "process.exit(0)"',
    'node tests/run.js --test-name-pattern=no-such-test-exists',
  ]) {
    const repo = mkRepoWithSuite(command);
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

test('an entrypoint that cannot be read yields no warning and no crash', () => {
  const cases = {
    missing: (repo) => fs.mkdirSync(path.join(repo, 'tests'), { recursive: true }),
    directory: (repo) => fs.mkdirSync(path.join(repo, 'tests', 'run.js'), { recursive: true }),
    oversized: (repo) => {
      fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, 'tests', 'run.js'),
        `if (!process.env.NOT_SET_ANYWHERE) process.exit(0);\n${'a'.repeat(300 * 1024)}`
      );
    },
  };
  for (const [label, build] of Object.entries(cases)) {
    const repo = mkFakeRepo({ verify: { test: 'node tests/run.js' } });
    try {
      build(repo);
      const res = runScript(SCRIPT, [], { cwd: repo });
      assert.strictEqual(res.status, 0, `${label}: ${res.stderr}`);
      assert.deepStrictEqual(JSON.parse(res.stdout)._meta.warnings.filter((w) => w.includes(MARKER)), [], label);
    } finally {
      rmDir(repo);
    }
  }
});

// --- the near-misses that decide whether silence is trustworthy ------------------------

// -e and -p mean unrelated things to other tools: pytest's plugin flag, Go's parallelism
// flag, Maven's error flag, RSpec's example filter. Every one of these runs a real suite.
test('an eval-shaped flag belonging to another tool is left alone', () => {
  for (const command of [
    'pytest -p no:cacheprovider',
    'pytest -q -p no:randomly',
    'go test ./... -p 4',
    'mvn -e test',
    'bundle exec rspec -e login',
  ]) {
    const repo = mkRepoWithSuite(command);
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

test('an inline program is still reported for the interpreters that have one', () => {
  for (const command of ['node -e "process.exit(0)"', 'python -c "pass"', 'bash -c "true"']) {
    const repo = mkRepoWithSuite(command);
    try {
      assert.strictEqual(warningsFor(repo).length, 1, command);
    } finally {
      rmDir(repo);
    }
  }
});

test('an env reference that does not guard the exit is left alone', () => {
  const repo = mkRepoWithSuite('node tests/run.js', {
    entrypoint:
      "const level = process.env.LOG_LEVEL || 'info';\n" +
      'const res = runSuite(level);\n' +
      'if (res.failures === 0) process.exit(0);\n' +
      'process.exit(1);\n',
  });
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

test('a && exit 0 tail is left alone, because a failing suite never reaches it', () => {
  const repo = mkRepoWithSuite('node tests/run.js && exit 0');
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

// Silence when no test names could be collected is a decision, so it needs a test that fails
// if the clause is removed.
test('a filter is not reported when the repo declares no test names at all', () => {
  const repo = mkFakeRepo({ verify: { test: 'node tests/run.js --test-name-pattern=anything' } });
  try {
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tests', 'run.js'), 'runSuite();\n');
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

test('an entrypoint resolving outside the repo is not treated as the entrypoint', () => {
  const repo = mkFakeRepo({ verify: { test: 'node ../outside/run.js' } });
  const outside = path.join(repo, '..', 'outside');
  try {
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'run.js'), 'if (!process.env.RUN_TESTS) process.exit(0);\n');
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(outside);
    rmDir(repo);
  }
});

// C6 otherwise cannot see row 48 disappear: load_config.js is already cited by row 30, so
// invariants.test.js stays green without it.
test('INVARIANTS.md carries a row for this mechanism', () => {
  const table = fs.readFileSync(path.join(REPO_ROOT, 'INVARIANTS.md'), 'utf8');
  assert.ok(
    /^\|.*`verify_falsifiable\.js` → `verifyTestWarnings`.*$/m.test(table),
    'no INVARIANTS row cites verifyTestWarnings'
  );
});

// --- filter values are shell tokens, not bare strings -----------------------------------

test('a quoted filter that does match is left alone, in both quoting forms', () => {
  for (const command of [
    'node --test --test-name-pattern "adds" tests/',
    'node --test --test-name-pattern="adds" tests/',
  ]) {
    const repo = mkRepoWithSuite(command);
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

// -k takes a boolean expression and -run a regex over a surface that includes subtests, so
// neither is a name this can look up.
test('a selection expression is left alone rather than matched as a name', () => {
  for (const command of [
    'pytest -q -k "not slow"',
    'pytest tests -k "smoke and not slow"',
    "go test ./... -run 'TestAlpha|TestBeta'",
  ]) {
    const repo = mkRepoWithSuite(command, { testNames: ['TestAlpha', 'TestBeta', 'smoke path'] });
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

// --- an inline program that runs the real suite can still go red ------------------------

test('a shell wrapper around the real suite is left alone', () => {
  for (const command of [
    'sh -c "node tests/run.js"',
    'bash -c "npm test"',
    'python -c "import pytest; pytest.main()"',
    'ruby -e "require \'./spec\'"',
  ]) {
    const repo = mkRepoWithSuite(command);
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

// --- a bound that cut the walk short cannot tell "no match" from "never looked" ----------

test('a filter is not reported when the tree is deeper than the scan bound', () => {
  const repo = mkFakeRepo({ verify: { test: 'node tests/run.js --test-name-pattern=no-such-test' } });
  try {
    const deep = path.join(repo, 'tests', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(repo, 'tests', 'run.js'), 'runSuite();\n');
    fs.writeFileSync(path.join(deep, 'deep.test.js'), "test('buried case', () => {});");
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

test('a filter is not reported when the file budget ran out before the tree did', () => {
  const repo = mkFakeRepo({ verify: { test: 'node tests/run.js --test-name-pattern=no-such-test' } });
  try {
    const dir = path.join(repo, 'tests');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.js'), 'runSuite();\n');
    for (let i = 0; i < 205; i++) {
      fs.writeFileSync(path.join(dir, `case${i}.test.js`), `test('case ${i}', () => {});`);
    }
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

// --- AC 2e, written the ways people actually write it -----------------------------------

test('an env-guarded exit(0) is reported however the guard is spelled', () => {
  const spellings = {
    braceless: 'if (!process.env.RUN_TESTS) process.exit(0);\nrunSuite();\n',
    'braced one-line': 'if (!process.env.RUN_TESTS) { process.exit(0); }\nrunSuite();\n',
    'braced block': 'if (!process.env.RUN_TESTS) {\n  process.exit(0);\n}\nrunSuite();\n',
    'guard variable': 'const enabled = process.env.RUN_TESTS;\nif (!enabled) {\n  process.exit(0);\n}\nrunSuite();\n',
    'no semicolons': 'if (!process.env.RUN_TESTS)\n  process.exit(0)\n\nrunSuite()\n',
  };
  for (const [label, entrypoint] of Object.entries(spellings)) {
    const repo = mkRepoWithSuite('node tests/run.js', { entrypoint });
    try {
      const found = warningsFor(repo);
      assert.strictEqual(found.length, 1, `${label}: ${JSON.stringify(found)}`);
      assert.ok(found[0].includes('RUN_TESTS'), `${label}: ${found[0]}`);
    } finally {
      rmDir(repo);
    }
  }
});

// An exit(0) whose condition is not about the environment says nothing about whether the
// command can fail, so the rule does not speak.
test('an exit(0) under a non-environment condition is left alone', () => {
  const entrypoints = {
    'python summary line':
      'import os, sys\n' +
      'res = run()\n' +
      'if res.failed:\n    sys.exit(1)\n' +
      'print(os.environ.get("SUMMARY_PATH", "-"))\n' +
      'sys.exit(0)\n',
    'semicolon-free js':
      'const level = process.env.LOG_LEVEL || "info"\n' +
      'const res = runSuite(level)\n' +
      'if (res.failures) process.exit(1)\n' +
      'process.exit(0)\n',
  };
  for (const [label, entrypoint] of Object.entries(entrypoints)) {
    const repo = mkRepoWithSuite('node tests/run.js', { entrypoint });
    try {
      assert.deepStrictEqual(warningsFor(repo), [], label);
    } finally {
      rmDir(repo);
    }
  }
});

// A failing path the guard jumps over is not a path the command can take.
test('a red path after a guard that fires does not make the command falsifiable', () => {
  const entrypoints = {
    throws: 'if (!process.env.RUN_TESTS) process.exit(0);\nif (failed) throw new Error("red");\n',
    'exit code assigned': 'if (!process.env.RUN_TESTS) process.exit(0);\nprocess.exitCode = failures;\n',
  };
  for (const [label, entrypoint] of Object.entries(entrypoints)) {
    const repo = mkRepoWithSuite('node tests/run.js', { entrypoint });
    try {
      const found = warningsFor(repo);
      assert.strictEqual(found.length, 1, `${label}: ${JSON.stringify(found)}`);
      assert.ok(found[0].includes('RUN_TESTS'), `${label}: ${found[0]}`);
    } finally {
      rmDir(repo);
    }
  }
});

// An env read that merely sits near an exit(0) is not a guard on it.
test('an env read outside the exit conditional is left alone', () => {
  const repo = mkRepoWithSuite('node tests/run.js', {
    entrypoint:
      'const level = process.env.LOG_LEVEL || "info";\n' +
      'const res = runSuite(level);\n' +
      'if (res.failures === 0) process.exit(0);\n',
  });
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

// --- the filter rule only speaks about the runner whose surface it can reconstruct -------

test('a pattern matching a describe block is left alone', () => {
  const repo = mkFakeRepo({ verify: { test: 'node --test --test-name-pattern=Widget tests/' } });
  try {
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tests', 'ui.test.js'), "describe('Widget', () => { it('renders', () => {}); });");
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

test('filters belonging to runners whose match surface is not reconstructable are left alone', () => {
  for (const command of [
    'pytest -k TestLogin',
    'pytest -k test_login',
    'go test ./... -run TestAlpha/sub_case',
    'mocha --grep nothing-matches-this',
  ]) {
    const repo = mkRepoWithSuite(command);
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

// Without the per-binary map, -e would match here and the constant-success body would carry
// the rule the whole way — so this is what makes the map load-bearing.
test('an eval flag on a binary that has no inline mode is left alone', () => {
  const repo = mkRepoWithSuite('bundle exec rspec -e pass');
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

// --- which way the guard points decides whether the exit is taken -----------------------

// The opt-out idiom exits 0 when the variable IS set, so with it unset the suite runs and the
// command can go red.
test('an opt-out guard is left alone while its variable is unset', () => {
  const repo = mkRepoWithSuite('node tests/run.js', {
    entrypoint: 'if (process.env.SKIP_TESTS) process.exit(0);\nrunSuite();\n',
  });
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

test('an opt-out guard is reported when its variable is set, and says so', () => {
  const repo = mkRepoWithSuite('node tests/run.js', {
    entrypoint: 'if (process.env.SKIP_TESTS) process.exit(0);\nrunSuite();\n',
  });
  try {
    const found = warningsFor(repo, { env: { SKIP_TESTS: '1' } });
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.ok(found[0].includes('$SKIP_TESTS is set'), found[0]);
    assert.ok(!found[0].includes('is unset'), found[0]);
  } finally {
    rmDir(repo);
  }
});

test('an env read in a conditional that does not contain the exit is left alone', () => {
  const repo = mkRepoWithSuite('node tests/run.js', {
    entrypoint: "if (process.env.VERBOSE) console.log('loud');\nprocess.exit(0);\n",
  });
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

// --- a name set with a hole in it cannot say "matches nothing" --------------------------

test('a filter is not reported when some test name cannot be read from source', () => {
  const samples = {
    'template substitution': 'for (const i of [1, 2, 3]) test(`case-${i}`, () => {});',
    'name from a variable': "const c = { name: 'case-3' };\ntest(c.name, () => {});",
    'table driven': "test.each([1, 2])('case-%i', () => {});",
  };
  for (const [label, sample] of Object.entries(samples)) {
    const repo = mkRepoWithSuite('node tests/run.js --test-name-pattern=case-3', { sample });
    try {
      assert.deepStrictEqual(warningsFor(repo), [], label);
    } finally {
      rmDir(repo);
    }
  }
});

test('a name declared through a modifier is collected, not treated as missing', () => {
  const repo = mkRepoWithSuite('node tests/run.js --test-name-pattern=only-case', {
    sample: "test.only('only-case', () => {});\ntest('other', () => {});",
  });
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

test("Node's regex-literal pattern spelling is matched as a regex", () => {
  const repo = mkRepoWithSuite('node tests/run.js --test-name-pattern=/adds/');
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

// --- an inline program only settles the verdict when it IS the command ------------------

test('a constant-success inline program followed by the real suite is left alone', () => {
  for (const command of ['sh -c "true" && node tests/run.js', 'bash -c "pass" ; node tests/run.js']) {
    const repo = mkRepoWithSuite(command);
    try {
      assert.deepStrictEqual(warningsFor(repo), [], command);
    } finally {
      rmDir(repo);
    }
  }
});

// A preload runs before the entrypoint and decides nothing about the entrypoint's exit code.
test('a preloaded module is not mistaken for the entrypoint', () => {
  const repo = mkFakeRepo({ verify: { test: 'node --require ./setup.js tests/run.js' } });
  try {
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'setup.js'), 'if (!process.env.NOT_SET_ANYWHERE) process.exit(0);\n');
    fs.writeFileSync(path.join(repo, 'tests', 'run.js'), 'const r = runSuite();\nprocess.exit(r.status);\n');
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

// --- the guard is evaluated, not pattern-matched ----------------------------------------

test('a value-comparison guard that does not hold is left alone', () => {
  const repo = mkRepoWithSuite('node tests/run.js', {
    entrypoint: "if (process.env.NODE_ENV === 'production') process.exit(0);\nrunSuite();\n",
  });
  try {
    assert.deepStrictEqual(warningsFor(repo, { env: { NODE_ENV: 'development' } }), []);
  } finally {
    rmDir(repo);
  }
});

test('a value-comparison guard that does hold is reported, and quotes the value', () => {
  const repo = mkRepoWithSuite('node tests/run.js', {
    entrypoint: "if (process.env.NODE_ENV === 'production') process.exit(0);\nrunSuite();\n",
  });
  try {
    const found = warningsFor(repo, { env: { NODE_ENV: 'production' } });
    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.ok(found[0].includes('"production"'), found[0]);
  } finally {
    rmDir(repo);
  }
});

test('a condition outside the supported grammar is left alone', () => {
  for (const condition of [
    "process.env.A === process.env.B",
    "process.env.MODE.startsWith('ci')",
    "process.env.RUN_TESTS && shouldSkip()",
  ]) {
    const repo = mkRepoWithSuite('node tests/run.js', {
      entrypoint: `if (${condition}) process.exit(0);\nrunSuite();\n`,
    });
    try {
      assert.deepStrictEqual(warningsFor(repo), [], condition);
    } finally {
      rmDir(repo);
    }
  }
});

// --- a name is read only when it is exactly a literal -----------------------------------

test('a concatenated test name marks the name set incomplete', () => {
  const repo = mkRepoWithSuite('node tests/run.js --test-name-pattern=renders-dark', {
    sample: "for (const v of ['light','dark']) test('renders-' + v, () => {});",
  });
  try {
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});

// The runner discovers more than *.test.js, and names missed there are names the filter
// would have matched.
test('test files the runner would load are scanned too', () => {
  const repo = mkFakeRepo({ verify: { test: 'node tests/run.js --test-name-pattern=creates' } });
  try {
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tests', 'run.js'), 'runSuite();\n');
    fs.writeFileSync(path.join(repo, 'tests', 'sample.test.js'), "test('adds two numbers', () => {});");
    fs.writeFileSync(path.join(repo, 'tests', 'test-api.js'), "test('creates user', () => {});");
    assert.deepStrictEqual(warningsFor(repo), []);
  } finally {
    rmDir(repo);
  }
});
