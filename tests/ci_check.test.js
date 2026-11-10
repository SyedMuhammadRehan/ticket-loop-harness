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
    completeness: fields.completeness || { verdict: 'APPROVE', frozenCriteria: 1, criteria: [{ id: 'C1', result: 'PASS', by: 'command' }], passed: true },
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
  fs.writeFileSync(path.join(root, 'check.js'), opts.checkJs || "process.exit(require('fs').existsSync('FAIL') ? 1 : 0);\n");
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), typeof opts.profile === 'string' ? opts.profile : JSON.stringify(opts.profile || { verify: { test: 'node check.js' } }));
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

// An APPROVE over an intact record of failed criteria is a run that did not pass.
test('a run whose criteria did not all pass is refused, even with an APPROVE and an intact record', (t) => {
  const failed = setup(t, {
    fields: { completeness: { verdict: 'APPROVE', frozenCriteria: 2, criteria: [{ id: 'C1', result: 'PASS', by: 'command' }, { id: 'C2', result: 'FAIL', by: 'command' }], passed: false } },
  });
  const res = ci(failed.root, ['--no-rerun']);
  assert.strictEqual(res.status, 2, res.stdout);
  assert.match(res.stdout, /criteria did not all pass: C2 FAIL/);
  const silent = setup(t, { fields: { completeness: { passed: 'yes' } } });
  assert.strictEqual(ci(silent.root, ['--no-rerun']).status, 2, 'only a recorded pass counts');
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

function ciKeyPem() {
  return crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
}

// The rerun executes the pull request's own code, so whatever that code can read, it can take.
test('the CI key is withheld from the commands CI reruns, and still countersigns', (t) => {
  const dump = "require('fs').writeFileSync('seen.json', JSON.stringify(process.env));\n";
  const { root } = setup(t, { checkJs: dump });
  const out = path.join(root, '..', `ci-${path.basename(root)}.json`);
  t.after(() => fs.rmSync(out, { force: true }));
  const res = ci(root, ['--out', out], { TICKET_LOOP_CI_KEY: ciKeyPem(), TICKET_LOOP_SIGNING_KEY: path.join(root, 'unused.pem') });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'seen.json'), 'utf8'));
  assert.ok(!('TICKET_LOOP_CI_KEY' in seen), 'the PEM must not reach the test command');
  assert.ok(!('TICKET_LOOP_SIGNING_KEY' in seen), 'nor the path of a key file');
  assert.ok(!JSON.stringify(seen).includes('PRIVATE KEY'));
  const sig = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(crypto.verify(null, Buffer.from(canonical(sig.claim)), sig.publicKey, Buffer.from(sig.signature, 'base64')));
});

test('a tag named like the base branch does not replace it as the source of trust', (t) => {
  const stranger = newKey();
  const { root } = setup(t, { signer: stranger });
  fs.appendFileSync(path.join(root, '.agents', 'ticket-loop.trust'), `${stranger.id}\n`);
  git(root, 'commit', '-qam', 'trust myself');
  git(root, 'tag', 'main', 'HEAD');
  const res = ci(root, ['--no-rerun']);
  assert.strictEqual(res.status, 2, res.stdout);
  assert.match(res.stdout, /which main does not trust/);
});

test('a bundle altered after signing, or attesting another ticket, is refused by the merge check itself', (t) => {
  const altered = setup(t);
  const file = path.join(altered.root, BUNDLE);
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  bundle.records[1].payload.verdict = 'BLOCK';
  fs.writeFileSync(file, JSON.stringify(bundle));
  git(altered.root, 'commit', '-qam', 'edit the bundle');
  const res = ci(altered.root, ['--no-rerun']);
  assert.strictEqual(res.status, 2, res.stdout);
  assert.match(res.stdout, /- bundle: /);

  const other = setup(t, { fields: { ticket: 'T-2' } });
  const wrong = ci(other.root, ['--no-rerun']);
  assert.strictEqual(wrong.status, 2);
  assert.match(wrong.stdout, /bundle attests ticket T-2, not T-1/);
});

test('a bundle whose attested head or base is not in the branch history is refused', (t) => {
  const { root, dev, baseSha } = setup(t);
  git(root, 'checkout', '-q', '--orphan', 'unrelated');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
  const stray = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-f', 'ticket/T-1');
  const attest = (fields) => {
    fs.writeFileSync(path.join(root, BUNDLE), JSON.stringify(bundleFor(dev, fields)));
    git(root, 'commit', '-qam', 'attest again');
  };

  attest({ baseSha, headSha: stray });
  const head = ci(root, ['--no-rerun']);
  assert.strictEqual(head.status, 2, head.stdout);
  assert.match(head.stdout, /which is not in this branch's history/);

  attest({ baseSha: stray, headSha: git(root, 'rev-parse', 'HEAD') });
  const base = ci(root, ['--no-rerun']);
  assert.strictEqual(base.status, 2, base.stdout);
  assert.match(base.stdout, /the run's base \w+ is not in this branch's history/);
});

const SLOW_MS = 4000;

test('a base branch with no test command, or a rerun that never finishes, is not a pass', async (t) => {
  const bare = setup(t, { profile: { verify: {} } });
  const none = ci(bare.root);
  assert.strictEqual(none.status, 2, none.stdout);
  assert.match(none.stdout, /names no verify\.test/);

  const broken = setup(t, { profile: '{ not json' });
  const unreadable = ci(broken.root);
  assert.strictEqual(unreadable.status, 2, unreadable.stdout);
  assert.match(unreadable.stdout, /carries no readable/);

  // The suite would leave a marker if it were allowed to finish after the check reported.
  const slow = setup(t, { checkJs: `setTimeout(() => require('fs').writeFileSync('finished.txt', 'x'), ${SLOW_MS});\n` });
  const hung = ci(slow.root, ['--timeout-ms', '1000']);
  assert.strictEqual(hung.status, 2, hung.stdout);
  assert.match(hung.stdout, /verify\.test timed out in CI/);
  await new Promise((resolve) => setTimeout(resolve, SLOW_MS + 1000));
  assert.ok(!fs.existsSync(path.join(slow.root, 'finished.txt')), 'the timed-out command was ended with its process tree');
});

test('a failing check is countersigned as a failure, over the attestation it judged', (t) => {
  const { root } = setup(t);
  fs.writeFileSync(path.join(root, 'FAIL'), '');
  const out = path.join(root, '..', `ci-${path.basename(root)}.json`);
  t.after(() => fs.rmSync(out, { force: true }));
  assert.strictEqual(ci(root, ['--out', out], { TICKET_LOOP_CI_KEY: ciKeyPem() }).status, 2);
  const sig = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(sig.claim.pass, false);
  const attestation = JSON.parse(fs.readFileSync(path.join(root, BUNDLE), 'utf8')).attestation;
  assert.strictEqual(sig.claim.attestationDigest, crypto.createHash('sha256').update(canonical(attestation)).digest('hex'));
});
