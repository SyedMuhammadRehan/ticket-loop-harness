'use strict';
// The sample is the first thing a newcomer runs, so it has to work exactly as the walkthrough
// says: one command makes a committed repo with a green suite, the setup tools accept it, and
// its ticket has criteria the loop can turn into a contract.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT, SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');

const NEW_SAMPLE = path.join(REPO_ROOT, 'examples', 'new-sample.js');

function sample() {
  const base = mkTmpDir('tl-sample');
  const dir = path.join(base, 'todo-sample');
  const res = spawnSync(process.execPath, [NEW_SAMPLE, dir], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  return { base, dir };
}

test('one command makes a committed sample repo whose suite is green', () => {
  const { base, dir } = sample();
  try {
    const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout.trim();
    assert.strictEqual(git(['status', '--porcelain']), '', 'everything is committed');
    assert.strictEqual(git(['rev-list', '--count', 'HEAD']), '1');
    assert.strictEqual(git(['branch', '--show-current']), 'main');
    // Under this variable a nested `node --test` runs nothing and still exits 0.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const suite = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', env });
    assert.strictEqual(suite.status, 0, suite.stdout);
    assert.match(suite.stdout, /^[ℹ#] pass 4$/m, 'the four sample tests really ran');

    const again = spawnSync(process.execPath, [NEW_SAMPLE, dir], { encoding: 'utf8' });
    assert.strictEqual(again.status, 1, 'an existing folder is never written over');
    assert.match(again.stderr, /already exists and is not empty/);
  } finally {
    rmDir(base);
  }
});

test('the setup tools accept the sample as it comes', () => {
  const { base, dir } = sample();
  try {
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const env = { HOME: home, USERPROFILE: home };
    const init = runScript(path.join(SCRIPTS_DIR, 'init.js'), [], { cwd: dir, env });
    assert.strictEqual(init.status, 0, init.stderr);
    const cfg = JSON.parse(runScript(path.join(SCRIPTS_DIR, 'load_config.js'), [], { cwd: dir, env }).stdout);
    assert.strictEqual(cfg.stack, 'node');
    assert.strictEqual(cfg.verify.test, 'npm test');
    assert.strictEqual(cfg.verify.pubGet, null, 'a repo with no dependencies has nothing to install');
    assert.deepStrictEqual(cfg._meta.warnings, [], cfg._meta.warnings.join('\n'));
  } finally {
    rmDir(base);
  }
});

test('the sample ticket has numbered acceptance criteria and the walkthrough names real files', () => {
  const ticket = fs.readFileSync(path.join(REPO_ROOT, 'examples', 'sample-app', 'TICKET.md'), 'utf8');
  assert.ok((ticket.match(/^\d+\. /gm) || []).length >= 3, 'the loop needs criteria to write a contract from');
  assert.match(ticket, /^## Out of scope$/m);
  const walkthrough = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'first-run.md'), 'utf8');
  for (const named of ['examples/new-sample.js', '/ticket-loop:setup', 'ledger.js next', 'ledger.js verify', 'ledger.js archive']) {
    assert.ok(walkthrough.includes(named), `the walkthrough no longer mentions ${named}`);
  }
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'TROUBLESHOOTING.md')), 'the walkthrough links to it');
});
