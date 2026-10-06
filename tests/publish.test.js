'use strict';
// The invariant under test: the loop publishes only what the repo allows, only what the person
// said yes to at the start of the run, and only a run whose sealed record says it passed. It
// pushes the ticket branch and nothing else, and refuses from a wrong branch or a dirty tree.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');

const LEDGER = path.join(SCRIPTS_DIR, 'ledger.js');
const PUBLISH = path.join(SCRIPTS_DIR, 'publish.js');
const DRAFT =
  '# Done\n## Criteria\n- [ ] C1 (test): behaviour holds | run: node check.js tests\n' +
  '- [ ] C2 (analyzer): clean | run: node lint.js .\n## Tokens\n- none\n## Out of scope\n- nothing else\n';

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

// A real repo with a bare remote, a ticket worktree carrying one commit, and a run driven to
// close with the given consent and results.
function finishedRun(t, opts = {}) {
  const base = mkTmpDir('tl-pub');
  t.after(() => {
    spawnSync('git', ['-C', path.join(base, 'main'), 'worktree', 'remove', '--force', path.join(base, 'wt')]);
    rmDir(base);
  });
  const root = path.join(base, 'main');
  const bare = path.join(base, 'remote.git');
  const wt = path.join(base, 'wt');
  fs.mkdirSync(root);
  git(base, 'init', '-q', '--bare', bare);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  const profile = {
    verify: { test: 'node check.js', analyze: 'node lint.js' },
    ticketSource: opts.ticketSource || 'manual',
    publish: { allowed: opts.allowed || ['push', 'pr', 'ticket'] },
    hooks: { stopGate: { extensions: ['.js'], mode: 'full', baseRef: 'main' } },
  };
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify(profile));
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/ticket-runs/\n');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'remote', 'add', 'origin', bare);
  const baseSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'worktree', 'add', '-q', wt, '-b', 'ticket/T-1');
  fs.writeFileSync(path.join(wt, 'a.js'), 'module.exports = 2;\n');
  git(wt, 'commit', '-qam', 'feat: change a');

  const runDir = path.join(root, '.agents', 'ticket-runs', 'T-1');
  fs.mkdirSync(runDir, { recursive: true });
  const ledger = (args) => runScript(LEDGER, args, { cwd: root });
  const ok = (args) => {
    const r = ledger(args);
    assert.strictEqual(r.status, 0, `ledger ${args[0]}: ${r.stderr}`);
  };
  ok(['init', runDir, baseSha]);
  const consent = opts.consent || { push: 'yes', pr: 'yes', ticket: 'yes' };
  ok(['consent', runDir, '--push', consent.push, '--pr', consent.pr, '--ticket', consent.ticket, 'Rehan, in chat at the start']);
  const write = (name, text) => {
    fs.writeFileSync(path.join(runDir, name), text);
    return path.join(runDir, name);
  };
  const brief = write('ticket-brief.md', '# Ticket Brief — T-1\n\n**Summary:** Show a friendly error\n');
  ok(['gate', runDir, 'intake', '--evidence', brief]);
  write('done.draft.md', DRAFT);
  assert.strictEqual(runScript(path.join(SCRIPTS_DIR, 'validate_done.js'), [runDir], { cwd: root }).status, 0);
  assert.strictEqual(runScript(path.join(SCRIPTS_DIR, 'freeze_done.js'), [runDir], { cwd: root }).status, 0);
  ok(['check', runDir, 'C1', 'PASS', '--by', 'command']);
  ok(['check', runDir, 'C2', opts.c2 || 'PASS', '--by', 'command']);
  ok(['gate', runDir, 'verify', '--evidence', brief]);
  ok(['dispatch', runDir, 'qa: contract [full]', '--source', 'hook']);
  const qaSeq = JSON.parse(ledger(['status', runDir]).stdout).open[0].seqs[0];
  ok(['verdict', runDir, opts.verdict || 'APPROVE', '--inputs', path.join(runDir, 'done.approved.md'), '--inputs', path.join(runDir, 'done-additions.md')]);
  ok(['outcome', runDir, String(qaSeq), 'ok']);
  ok(['gate', runDir, 'qa', '--evidence', brief]);
  const report = write('report.md', '# Ticket Loop Report — T-1\n\nStatus: COMPLETE\n');
  ok(['gate', runDir, 'report', '--evidence', report]);
  ok(['close', runDir]);
  return { root, bare, wt, runDir, ledger };
}

const publish = (s, act, extra = [], env = {}) => runScript(PUBLISH, [s.runDir, '--worktree', s.wt, '--act', act, ...extra], { cwd: s.root, env });

function fakeCli(t, dir) {
  const log = path.join(dir, 'cli-calls.json');
  const script = path.join(dir, 'fake-cli.js');
  fs.writeFileSync(script, `const fs=require('fs');const f=${JSON.stringify(log)};const a=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[];a.push(process.argv.slice(2));fs.writeFileSync(f,JSON.stringify(a));console.log('https://github.com/acme/shop/pull/7');\n`);
  return { env: { TICKET_LOOP_PUBLISH_CLI: JSON.stringify([process.execPath, script]) }, calls: () => JSON.parse(fs.readFileSync(log, 'utf8')) };
}

test('a consented, passing run pushes only its ticket branch, then opens the PR and updates the issue', (t) => {
  const s = finishedRun(t, { ticketSource: 'github' });
  const pushed = publish(s, 'push');
  assert.strictEqual(pushed.status, 0, pushed.stderr);
  const heads = git(s.bare, 'for-each-ref', '--format=%(refname)', 'refs/heads');
  assert.deepStrictEqual(heads.split('\n'), ['refs/heads/ticket/T-1'], 'the remote received the ticket branch and nothing else');
  assert.strictEqual(git(s.bare, 'rev-parse', 'refs/heads/ticket/T-1'), git(s.wt, 'rev-parse', 'HEAD'));

  const cli = fakeCli(t, s.root);
  const pr = publish(s, 'pr', ['--platform', 'github'], cli.env);
  assert.strictEqual(pr.status, 0, pr.stderr);
  assert.match(pr.stdout, /pull\/7/);
  const [prArgs] = cli.calls();
  assert.deepStrictEqual(prArgs.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', 'ticket/T-1', '--title', 'T-1: Show a friendly error']);
  assert.ok(fs.readFileSync(prArgs[9], 'utf8').includes('Status: COMPLETE'), 'the PR body carries the run report');

  const issue = publish(s, 'ticket', ['--ticket-id', '12'], cli.env);
  assert.strictEqual(issue.status, 0, issue.stderr);
  assert.deepStrictEqual(cli.calls()[1].slice(0, 3), ['issue', 'comment', '12']);
  const log = JSON.parse(fs.readFileSync(path.join(s.runDir, 'published.json'), 'utf8'));
  assert.deepStrictEqual(log.map((e) => e.act), ['push', 'pr', 'ticket']);
});

test('an act the person said no to is refused, and nothing reaches the remote', (t) => {
  const s = finishedRun(t, { consent: { push: 'no', pr: 'no', ticket: 'no' } });
  const res = publish(s, 'push');
  assert.strictEqual(res.status, 2, res.stderr);
  assert.match(res.stderr, /did not say yes to "push"/);
  assert.strictEqual(git(s.bare, 'for-each-ref', 'refs/heads'), '');
});

test('a run whose record does not say it passed is refused, whatever was consented', (t) => {
  const failing = finishedRun(t, { c2: 'FAIL' });
  const res = publish(failing, 'push');
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /C2 last recorded FAIL/);
  const blocked = finishedRun(t, { verdict: 'BLOCK' });
  assert.match(publish(blocked, 'push').stderr, /QA verdict is BLOCK/);
  assert.strictEqual(git(failing.bare, 'for-each-ref', 'refs/heads') + git(blocked.bare, 'for-each-ref', 'refs/heads'), '');
});

test('publishing refuses from a branch other than the ticket branch, or with uncommitted work', (t) => {
  const s = finishedRun(t);
  fs.writeFileSync(path.join(s.wt, 'a.js'), 'module.exports = 3;\n');
  assert.match(publish(s, 'push').stderr, /uncommitted changes/);
  git(s.wt, 'checkout', '-q', '--', 'a.js');
  git(s.wt, 'checkout', '-q', '-b', 'other');
  assert.match(publish(s, 'push').stderr, /not ticket\/T-1/);
  assert.strictEqual(git(s.bare, 'for-each-ref', 'refs/heads'), '');
});

test('a PR before the push is refused, and a repo that does not allow an act cannot be given it', (t) => {
  const s = finishedRun(t);
  const cli = fakeCli(t, s.root);
  assert.match(publish(s, 'pr', ['--platform', 'github'], cli.env).stderr, /not on the remote; push it first/);

  const narrow = finishedRun(t, { allowed: ['push'], consent: { push: 'yes', pr: 'no', ticket: 'no' } });
  const runDir2 = path.join(narrow.root, '.agents', 'ticket-runs', 'T-2');
  fs.mkdirSync(runDir2, { recursive: true });
  assert.strictEqual(narrow.ledger(['init', runDir2, 'abc']).status, 0);
  const widen = narrow.ledger(['consent', runDir2, '--push', 'yes', '--pr', 'yes', '--ticket', 'no', 'asked']);
  assert.strictEqual(widen.status, 1);
  assert.match(widen.stderr, /does not allow "pr"/);
  assert.strictEqual(narrow.ledger(['consent', runDir2, '--push', 'yes', '--pr', 'no', '--ticket', 'no', 'asked']).status, 0);
  const twice = narrow.ledger(['consent', runDir2, '--push', 'no', '--pr', 'no', '--ticket', 'no', 'asked again']);
  assert.strictEqual(twice.status, 1, 'publish answers are given once, at the start');
});
