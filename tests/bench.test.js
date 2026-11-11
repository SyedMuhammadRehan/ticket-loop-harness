'use strict';
// The bench scores a ticket-loop run against tests the agent never saw. That only means
// something if the bench itself is right: the app starts green with every planted defect
// undetected, each hidden test fails before the fix and passes after the reference one, and
// the answer key never reaches the repo the agent works in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT, mkTmpDir, rmDir } = require('./helpers.js');
const bench = require(path.join(REPO_ROOT, 'bench', 'lib.js'));

function repo() {
  const base = mkTmpDir('tl-bench');
  return { base, dir: bench.makeRepo(path.join(base, 'depot')) };
}

test('the generated repo is committed, green and lint-clean, with its planted defects undetected', () => {
  const { base, dir } = repo();
  try {
    assert.strictEqual(bench.git(dir, ['status', '--porcelain']), '');
    const suite = bench.runSuite(dir);
    assert.ok(suite.ok && suite.pass >= 30, suite.out);
    assert.ok(bench.runLint(dir).ok);
    const profile = JSON.parse(fs.readFileSync(path.join(dir, '.agents', 'ticket-loop.config.json'), 'utf8'));
    assert.deepStrictEqual(profile.riskPaths, ['src/auth/**', 'package.json']);
  } finally {
    rmDir(base);
  }
});

test('the answer key stays out of the repo the agent works in', () => {
  const { base, dir } = repo();
  try {
    const shipped = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else shipped.push(path.relative(dir, full).replace(/\\/g, '/'));
      }
    };
    walk(dir);
    for (const leak of ['oracle', 'solutions', 'expected.json', 'score.js']) {
      assert.ok(!shipped.some((f) => f.includes(leak)), `${leak} was copied into the generated repo`);
    }
    const text = shipped.filter((f) => /\.(js|md|json)$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.ok(!/planted|\boracle\b|the trap/i.test(text), 'nothing in the repo hints at what is being tested');
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'tickets')).sort(), bench.ticketIds().map((t) => `${t}.md`));
  } finally {
    rmDir(base);
  }
});

for (const ticket of bench.oracleIds()) {
  test(`${ticket}: the hidden tests fail on the app as found and pass with the reference fix`, () => {
    const { base, dir } = repo();
    try {
      const before = bench.runOracle(ticket, dir);
      assert.strictEqual(before.ok, false, `${ticket}'s oracle passes before any fix, so it tests nothing`);
      assert.ok(before.fail >= 1, before.out);

      bench.applySolution(dir, ticket);
      const after = bench.runOracle(ticket, dir);
      assert.ok(after.ok, `${ticket}'s oracle is not satisfied by its own reference fix:\n${after.out}`);
      assert.strictEqual(after.fail, 0);

      const suite = bench.runSuite(dir);
      assert.ok(suite.ok, `the reference fix for ${ticket} breaks the app's own suite:\n${suite.out}`);
      assert.ok(bench.runLint(dir).ok, `the reference fix for ${ticket} fails the linter`);

      const touched = bench.git(dir, ['diff', '--name-only']).split('\n').filter(Boolean);
      const allowed = bench.expected()[ticket].mayTouch.map((g) => g.replace('/**', '/'));
      for (const file of touched) assert.ok(allowed.some((a) => file === a || file.startsWith(a)), `${ticket}'s reference fix touches ${file}, outside what the answer key allows`);
    } finally {
      rmDir(base);
    }
  });
}

test('every ticket has an entry in the answer key, and the ones with no oracle must not finish', () => {
  const key = bench.expected();
  const withOracle = bench.oracleIds();
  for (const ticket of bench.ticketIds()) {
    assert.ok(key[ticket], `${ticket} has no expected behaviour`);
    assert.ok(Array.isArray(key[ticket].humanChecks) && key[ticket].humanChecks.length, `${ticket} names nothing for a person to check`);
    assert.strictEqual(key[ticket].shouldFinish, withOracle.includes(ticket), `${ticket}: a ticket finishes exactly when it has hidden tests to pass`);
    if (!key[ticket].shouldFinish) assert.ok(key[ticket].mustAskHuman, `${ticket} should stop, so the key says what it must ask`);
  }
});

// The scorer is the instrument, so it is checked against results whose quality is known.
test('the scorer tells a correct fix from a partial one, an untouched repo and a weakened suite', () => {
  const { score } = require(path.join(REPO_ROOT, 'bench', 'score.js'));
  const { base, dir } = repo();
  const byName = (s) => Object.fromEntries(s.checks.map((c) => [c.name, c.ok]));
  const commit = (message) => {
    bench.git(dir, ['add', '-A']);
    bench.git(dir, ['commit', '-q', '-m', message]);
  };
  try {
    bench.git(dir, ['checkout', '-q', '-b', 'ticket/T03']);
    const untouched = byName(score('T03', dir, { checkout: dir }));
    assert.strictEqual(untouched['hidden tests'], false, 'the app as found does not pass');
    assert.strictEqual(untouched['a test was added or changed'], false);

    // Half the fix: the example in the ticket, not the second site.
    const money = path.join(dir, 'src', 'money.js');
    fs.writeFileSync(money, fs.readFileSync(money, 'utf8').replace('(cents * percent) / 100', '(cents * percent + 50) / 100'));
    commit('fix: the example only');
    const partial = score('T03', dir, { checkout: dir });
    assert.strictEqual(byName(partial)['hidden tests'], false, 'a fix that misses the tax site does not pass');
    assert.match(partial.checks[0].detail, /^\d+ of \d+ pass$/);

    bench.git(dir, ['checkout', '-q', '--', '.']);
    bench.git(dir, ['reset', '-q', '--hard', 'main']);
    bench.applySolution(dir, 'T03');
    fs.appendFileSync(path.join(dir, 'test', 'money.test.js'), "\ntest('a half cent rounds up', () => {\n  assert.strictEqual(percentOf(10, 25), 3);\n});\n");
    commit('fix: percentages round half up');
    const good = byName(score('T03', dir, { checkout: dir }));
    for (const name of ['hidden tests', "the app's own suite", 'lint', 'stayed inside the files a fix needs', 'no existing test removed', 'a test was added or changed']) {
      assert.strictEqual(good[name], true, name);
    }
    assert.strictEqual(good['a run record exists'], false, 'a fix made by hand has no run behind it, and the scorecard says so');

    fs.writeFileSync(path.join(dir, 'README.md'), 'unrelated\n');
    fs.rmSync(path.join(dir, 'test', 'tokens.test.js'));
    commit('chore: drive-by');
    const sloppy = byName(score('T03', dir, { checkout: dir }));
    assert.strictEqual(sloppy['stayed inside the files a fix needs'], false);
    assert.strictEqual(sloppy['no existing test removed'], false);
  } finally {
    rmDir(base);
  }
});

test('a ticket that should stop is scored on having changed nothing', () => {
  const { score } = require(path.join(REPO_ROOT, 'bench', 'score.js'));
  const { base, dir } = repo();
  try {
    const asked = score('T05', dir, { checkout: dir });
    assert.strictEqual(asked.passed, asked.total);
    assert.match(asked.mustAskHuman, /GATE A/);
    fs.appendFileSync(path.join(dir, 'src', 'orders.js'), '\n// a guess at "better"\n');
    const built = score('T05', dir, { checkout: dir });
    assert.strictEqual(built.checks.find((c) => c.name === 'no source file was changed').ok, false);
  } finally {
    rmDir(base);
  }
});

test('the generator refuses to write over a folder', () => {
  const { base, dir } = repo();
  try {
    const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bench', 'new-bench.js'), dir], { encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /already exists and is not empty/);
  } finally {
    rmDir(base);
  }
});
