'use strict';
// The invariant under test: a closed run is handed off as a ready pull request description and
// the platform's own commands to open it, and nothing is pushed or opened by the harness.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');
const { remoteOf, titleOf } = require(path.join(SCRIPTS_DIR, 'handoff.js'));

const HANDOFF = path.join(SCRIPTS_DIR, 'handoff.js');

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function setup(t, { closed = true, bundle = true, remote = null } = {}) {
  const root = mkTmpDir('tl-ho');
  const bare = mkTmpDir('tl-ho-remote');
  t.after(() => {
    rmDir(root);
    rmDir(bare);
  });
  git(bare, 'init', '-q', '--bare');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.txt'), '1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'checkout', '-q', '-b', 'ticket/T-1');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify({ hooks: { stopGate: { baseRef: 'main' } } }));
  const runDir = path.join(root, '.agents', 'ticket-runs', 'T-1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'ticket-brief.md'), '# Ticket Brief — T-1\n\n**Summary:** Show a friendly error when the profile fails to load\n');
  fs.writeFileSync(path.join(runDir, 'report.md'), '# Ticket Loop Report — T-1\n\nStatus: COMPLETE\nC1 PASS by command\n');
  if (closed) fs.writeFileSync(path.join(runDir, 'closed.json'), '{}');
  if (bundle) {
    fs.mkdirSync(path.join(root, '.agents', 'attestations'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.agents', 'attestations', 'T-1.bundle.json'),
      JSON.stringify({ attestation: { verdict: 'APPROVE', integrity: { intact: true }, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), records: 12, keyId: 'k'.repeat(32) } })
    );
  }
  if (remote) git(root, 'remote', 'set-url', 'origin', remote);
  return { root, bare, runDir, body: path.join(root, '..', `${path.basename(root)}-pr.md`) };
}

const handoff = (s) => runScript(HANDOFF, [s.runDir, '--worktree', s.root, '--out', s.body], { cwd: s.root });

test('a closed run becomes a pull request description from its report and attestation, and nothing is pushed', (t) => {
  const s = setup(t);
  t.after(() => fs.rmSync(s.body, { force: true }));
  const res = handoff(s);
  assert.strictEqual(res.status, 0, res.stderr);
  const body = fs.readFileSync(s.body, 'utf8');
  assert.ok(body.includes('Status: COMPLETE') && body.includes('C1 PASS by command'), body);
  assert.ok(body.includes('Verdict: **APPROVE**') && body.includes('k'.repeat(32)), body);
  assert.match(res.stdout, /title: T-1: Show a friendly error when the profile fails to load/);
  assert.match(res.stdout, /nothing was pushed/);
  assert.strictEqual(git(s.bare, 'branch', '--list').trim(), '', 'the remote received nothing');
});

test('the commands match the platform the remote is on', (t) => {
  for (const [url, expect] of [
    ['git@github.com:acme/shop.git', /gh pr create --base main --head ticket\/T-1 --title 'T-1: .*' --body-file/],
    ['https://gitlab.example.com/acme/shop.git', /glab mr create --source-branch ticket\/T-1 --target-branch main/],
    ['git@bitbucket.org:acme/shop.git', /https:\/\/bitbucket\.org\/acme\/shop\/pull-requests\/new\?source=ticket%2FT-1&dest=main/],
  ]) {
    const s = setup(t, { remote: url });
    t.after(() => fs.rmSync(s.body, { force: true }));
    const res = handoff(s);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, expect, res.stdout);
    assert.match(res.stdout, /git push -u origin ticket\/T-1/);
  }
});

test('an open run is not handed off, and a branch without a bundle is warned about', (t) => {
  const open = setup(t, { closed: false });
  const res = handoff(open);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /not closed/);
  const bare = setup(t, { bundle: false });
  t.after(() => fs.rmSync(bare.body, { force: true }));
  const warned = handoff(bare);
  assert.strictEqual(warned.status, 0, warned.stderr);
  assert.match(warned.stdout, /no signed bundle: the merge check will refuse this branch/);
});

test('remotes and titles parse in every form teams use', () => {
  assert.deepStrictEqual(remoteOf('https://github.com/acme/shop.git'), { platform: 'github', host: 'github.com', project: 'acme/shop' });
  assert.deepStrictEqual(remoteOf('ssh://git@bitbucket.org/acme/shop.git'), { platform: 'bitbucket', host: 'bitbucket.org', project: 'acme/shop' });
  assert.strictEqual(remoteOf('').platform, 'unknown');
  assert.strictEqual(titleOf('T-9', '# Fix the login timeout\n'), 'T-9: Fix the login timeout');
  assert.strictEqual(titleOf('T-9', null), 'T-9');
  assert.ok(titleOf('T-9', `**Summary:** ${'word '.repeat(40)}`).length <= 80);
});
