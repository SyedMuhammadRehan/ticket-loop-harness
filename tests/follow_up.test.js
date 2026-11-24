'use strict';
// A change asked for after a run closed is a run of its own, stacked on the first: the first
// record stays closed, and the follow-up re-checks every command criterion of the first run at
// its own tip, so the branch that ships is proven as a whole.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SCRIPTS_DIR, mkTmpDir, rmDir, ledger, runScript, freezeRun } = require('./helpers.js');
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

const PASSES = 'node -e "process.exit(0)"';
const LINT = 'node -e "process.exit(0)" lint';
const FIRST =
  `# Done\n## Criteria\n- [ ] C1 (test): the feature holds | run: ${PASSES}\n` +
  `- [ ] C2 (analyzer): clean | run: ${LINT}\n- [ ] C3 (manual): looks right to a person\n` +
  `## Tokens\n- none\n## Out of scope\n- the offline banner\n`;

function git(root, args) {
  const res = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  return res.stdout.trim();
}

// A real repo with the first run frozen and, unless told otherwise, closed.
function firstRun({ close = true } = {}) {
  const root = mkTmpDir('tl-fu');
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify({ verify: { test: 'node tests.js', analyze: 'node lint.js' }, hooks: { stopGate: { baseRef: 'main' } } }));
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/ticket-runs/\n');
  fs.writeFileSync(path.join(root, 'a.txt'), '1\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  const runs = path.join(root, '.agents', 'ticket-runs');
  const parent = path.join(runs, 'T-1');
  fs.mkdirSync(parent, { recursive: true });
  assert.strictEqual(ledger(root, ['init', parent, git(root, ['rev-parse', 'HEAD'])]).status, 0);
  freezeRun(root, parent, FIRST);
  git(root, ['branch', 'ticket/T-1']);
  git(root, ['checkout', '-q', 'ticket/T-1']);
  fs.writeFileSync(path.join(root, 'a.txt'), '2\n');
  git(root, ['commit', '-qam', 'the first ticket']);
  if (close) {
    fs.writeFileSync(path.join(parent, 'report.md'), '# Report\n');
    assert.strictEqual(ledger(root, ['gate', parent, 'report', '--evidence', path.join(parent, 'report.md')]).status, 0);
    assert.strictEqual(ledger(root, ['close', parent]).status, 0);
  }
  const followUp = path.join(runs, 'T-1-f1');
  fs.mkdirSync(followUp, { recursive: true });
  return { root, parent, followUp, tip: git(root, ['rev-parse', 'ticket/T-1']) };
}

const startFollowUp = (env, extra = ['--stack-on', 'ticket/T-1']) => ledger(env.root, ['init', env.followUp, env.tip, '--follow-up-of', 'T-1', ...extra]);

test('a follow-up starts only from a first run that is closed and intact', () => {
  const open = firstRun({ close: false });
  const tampered = firstRun();
  try {
    const res = startFollowUp(open);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /T-1 is not closed/);
    fs.appendFileSync(path.join(tampered.parent, 'done.approved.md'), '- [ ] C9 (test): slipped in | run: true\n');
    const bad = startFollowUp(tampered);
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /record of T-1 is not intact/);
    assert.ok(!chain.exists(open.followUp) && !chain.exists(tampered.followUp));
  } finally {
    rmDir(open.root);
    rmDir(tampered.root);
  }
});

test('a follow-up sits on the first run branch tip', () => {
  const env = firstRun();
  try {
    const loose = startFollowUp(env, []);
    assert.strictEqual(loose.status, 1);
    assert.match(loose.stderr, /--stack-on ticket\/T-1/);
    const elsewhere = startFollowUp(env, ['--stack-on', 'main']);
    assert.strictEqual(elsewhere.status, 1);
    assert.match(elsewhere.stderr, /--stack-on ticket\/T-1/);
  } finally {
    rmDir(env.root);
  }
});

test('a follow-up records the command checks it carries forward from the first run', () => {
  const env = firstRun();
  try {
    const res = startFollowUp(env);
    assert.strictEqual(res.status, 0, res.stderr);
    const p = chain.first(env.followUp, 'init').payload.followUpOf;
    assert.strictEqual(p.ticket, 'T-1');
    assert.ok(p.closeSeal, 'which closed record it follows');
    assert.deepStrictEqual(p.carried, [{ id: 'C1', run: PASSES }, { id: 'C2', run: LINT }], 'command checks only; a person\'s look is not re-run');
  } finally {
    rmDir(env.root);
  }
});

test('a follow-up done-list must carry every command check of the first run', () => {
  const env = firstRun();
  try {
    assert.strictEqual(startFollowUp(env).status, 0);
    const validate = (draft) => {
      fs.writeFileSync(path.join(env.followUp, 'done.draft.md'), draft);
      return runScript(path.join(SCRIPTS_DIR, 'validate_done.js'), [env.followUp], { cwd: env.root });
    };
    const onlyNew =
      `# Done\n## Criteria\n- [ ] C1 (test): the empty state is grey | run: node -e "process.exit(0)" grey\n` +
      `- [ ] C2 (analyzer): clean | run: ${LINT}\n## Tokens\n- none\n## Out of scope\n- anything else\n`;
    const dropped = validate(onlyNew);
    assert.strictEqual(dropped.status, 1);
    assert.match(dropped.stderr, /follow-up of T-1 drops its C1/);
    const carried = validate(onlyNew.replace('## Tokens', `- [ ] C3 (test): the first run's C1 still holds | run: ${PASSES}\n## Tokens`));
    assert.strictEqual(carried.status, 0, carried.stderr);
  } finally {
    rmDir(env.root);
  }
});
