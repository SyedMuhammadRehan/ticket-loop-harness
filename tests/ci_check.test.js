'use strict';
// The invariant under test: a pull request merges only when it carries a bundle, signed by a key
// the BASE branch trusts, attesting its exact head, for a run that passed, and CI's own rerun of
// the base branch's test command is green. Each way of getting around that is refused.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');
const { canonical, digestOf, FORMAT } = require(path.join(SCRIPTS_DIR, 'verify_bundle.js'));
const { keyIdOf } = require(path.join(SCRIPTS_DIR, 'attest.js'));

const CI = path.join(SCRIPTS_DIR, 'ci_check.js');
const BUNDLE = '.agents/attestations/T-1.bundle.json';

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function newKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  return { privateKey, pem, id: keyIdOf(pem) };
}

function bundleFor(key, fields) {
  const records = [
    { seq: 1, kind: 'init', at: 't', payload: { baseSha: fields.baseSha }, prev: null, hmac: 'h1' },
    { seq: 2, kind: 'verdict', at: 't', payload: { verdict: fields.verdict || 'APPROVE' }, prev: 'h1', hmac: 'h2' },
  ];
  const attestation = {
    format: FORMAT,
    ticket: fields.ticket || 'T-1',
    baseSha: fields.baseSha,
    headSha: fields.headSha,
    records: records.length,
    chainDigest: digestOf(records),
    lastSeal: 'h2',
    verdict: fields.verdict || 'APPROVE',
    integrity: fields.integrity || { intact: true, problems: [] },
    keyId: key.id,
  };
  const signature = crypto.sign(null, Buffer.from(canonical(attestation)), key.privateKey).toString('base64');
  return { attestation, signature, publicKey: key.pem, records };
}

// main trusts devKey and tests with check.js; ticket/T-1 changes src/a.js and is attested.
function setup(t, opts = {}) {
  const dev = newKey();
  const root = mkTmpDir('tl-ci');
  t.after(() => rmDir(root));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'check.js'), "process.exit(require('fs').existsSync('FAIL') ? 1 : 0);\n");
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify({ verify: { test: 'node check.js' } }));
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.trust'), `# reviewed signing keys\n${dev.id}\n`);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'ticket/T-1');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  git(root, 'commit', '-qam', 'feat: change a');
  const headSha = git(root, 'rev-parse', 'HEAD');
  const signer = opts.signer || dev;
  const bundle = bundleFor(signer, { baseSha, headSha, ...(opts.fields || {}) });
  fs.mkdirSync(path.join(root, '.agents', 'attestations'), { recursive: true });
  fs.writeFileSync(path.join(root, BUNDLE), JSON.stringify(bundle));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore(T-1): attest');
  return { root, dev, baseSha, headSha };
}

const ci = (root, args = [], env = {}) => runScript(CI, ['--base', 'main', '--ticket', 'T-1', ...args], { cwd: root, env });

test('an attested, trusted, passing run whose tests pass again in CI may merge', (t) => {
  const { root } = setup(t);
  const res = ci(root);
  assert.strictEqual(res.status, 0, res.stdout);
  assert.match(res.stdout, /PASS/);
  assert.match(res.stdout, /ran verify\.test: node check\.js -> exit 0/);
});

test('a commit after the attested head that changes code is refused', (t) => {
  const { root } = setup(t);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 3;\n');
  git(root, 'commit', '-qam', 'sneak in a change');
  const res = ci(root);
  assert.strictEqual(res.status, 2, res.stdout);
  assert.match(res.stdout, /change files the run never saw: src\/a\.js/);
});

test('a key the base branch does not trust is refused, even when the pull request trusts it', (t) => {
  const stranger = newKey();
  const { root } = setup(t, { signer: stranger });
  fs.appendFileSync(path.join(root, '.agents', 'ticket-loop.trust'), `${stranger.id}\n`);
  git(root, 'commit', '-qam', 'trust myself');
  const res = ci(root, ['--no-rerun']);
  assert.strictEqual(res.status, 2, res.stdout);
  assert.match(res.stdout, /which main does not trust/);
});

test('a run whose verdict was BLOCK, or whose integrity was not intact, is refused', (t) => {
  const blocked = setup(t, { fields: { verdict: 'BLOCK' } });
  assert.match(ci(blocked.root, ['--no-rerun']).stdout, /verdict is BLOCK, not a pass/);
  const tampered = setup(t, { fields: { integrity: { intact: false, problems: ['TAMPERED: done.md'] } } });
  const res = ci(tampered.root, ['--no-rerun']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stdout, /integrity check reported problems: TAMPERED: done\.md/);
});

test('CI reruns the base branch test command, so a red suite or a swapped command does not pass', (t) => {
  const { root } = setup(t);
  fs.writeFileSync(path.join(root, 'FAIL'), '');
  const red = ci(root);
  assert.strictEqual(red.status, 2, red.stdout);
  assert.match(red.stdout, /verify\.test failed in CI/);

  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify({ verify: { test: 'node -e 0' } }));
  const swapped = ci(root);
  assert.strictEqual(swapped.status, 2, 'the pull request\'s own profile is not the one CI runs');
  assert.match(swapped.stdout, /ran verify\.test: node check\.js/);
});

test('a branch with no bundle is refused', (t) => {
  const { root } = setup(t);
  git(root, 'rm', '-q', BUNDLE);
  git(root, 'commit', '-qm', 'drop the bundle');
  const res = ci(root, ['--no-rerun']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stdout, /no readable bundle/);
});

test('with a CI key the check countersigns exactly what it ran', (t) => {
  const { root, headSha } = setup(t);
  const ciKey = crypto.generateKeyPairSync('ed25519');
  const keyFile = path.join(root, '..', `ci-key-${path.basename(root)}.pem`);
  fs.writeFileSync(keyFile, ciKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  t.after(() => fs.rmSync(keyFile, { force: true }));
  const out = path.join(root, '..', `ci-${path.basename(root)}.json`);
  t.after(() => fs.rmSync(out, { force: true }));
  assert.strictEqual(ci(root, ['--out', out], { TICKET_LOOP_SIGNING_KEY: keyFile }).status, 0);
  const sig = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(sig.claim.pass, true);
  assert.strictEqual(sig.claim.ran[0].command, 'node check.js');
  assert.notStrictEqual(sig.claim.headSha, headSha, 'the head CI checked is the one carrying the bundle commit');
  assert.ok(crypto.verify(null, Buffer.from(canonical(sig.claim)), sig.publicKey, Buffer.from(sig.signature, 'base64')));
});
