'use strict';
// The invariant under test: a closed run exported as a bundle can be checked by someone with no
// secret and no harness — a changed record, a dropped record, an edited attestation and a bundle
// re-signed by another key are each caught, and nothing unfinished or unverifiable is signed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkRun, mkTmpDir, rmDir, runScript, settleDispatches } = require('./helpers.js');
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));
const { canonical, verifyBundle } = require(path.join(SCRIPTS_DIR, 'verify_bundle.js'));

const LEDGER = path.join(SCRIPTS_DIR, 'ledger.js');
const VERIFY = path.join(SCRIPTS_DIR, 'verify_bundle.js');
const DRAFT =
  '# Done\n## Criteria\n- [ ] C1 (test): behaviour holds | run: x tests\n' +
  '- [ ] C2 (analyzer): clean | run: y .\n## Tokens\n- none\n## Out of scope\n- the offline banner\n';

function keyEnv(dir) {
  return { TICKET_LOOP_SIGNING_KEY: path.join(dir, 'key.pem'), HOME: dir, USERPROFILE: dir };
}
const ledger = (root, args, env) => runScript(LEDGER, args, { cwd: root, env });

// A run driven to close, the only state that is attested.
function closedRun(env) {
  const { root, runDir } = mkRun({ verify: { test: 'x', analyze: 'y' } });
  const ok = (args) => assert.strictEqual(ledger(root, args, env).status, 0, `ledger ${args[0]} failed`);
  ok(['init', runDir, 'base1']);
  const write = (name, body) => {
    const p = path.join(runDir, name);
    fs.writeFileSync(p, body);
    return p;
  };
  const brief = write('ticket-brief.md', '# brief\n');
  ok(['gate', runDir, 'intake', '--evidence', brief]);
  write('done.draft.md', DRAFT);
  runScript(path.join(SCRIPTS_DIR, 'validate_done.js'), [runDir], { cwd: root });
  runScript(path.join(SCRIPTS_DIR, 'freeze_done.js'), [runDir], { cwd: root });
  ok(['check', runDir, 'C1', 'PASS', '--by', 'command']);
  ok(['gate', runDir, 'verify', '--evidence', brief]);
  ok(['dispatch', runDir, 'qa', '--source', 'hook']);
  ok(['verdict', runDir, 'APPROVE', '--inputs', path.join(runDir, `done${'.approved'}.md`), '--inputs', path.join(runDir, 'done-additions.md')]);
  ok(['gate', runDir, 'qa', '--evidence', brief]);
  const report = write('report.md', '# Report\n');
  ok(['gate', runDir, 'report', '--evidence', report]);
  settleDispatches(root, runDir);
  return { root, runDir, ok };
}

function exported(t) {
  const keys = mkTmpDir('tl-keys');
  const env = keyEnv(keys);
  const gen = ledger(keys, ['keygen'], env);
  assert.strictEqual(gen.status, 0, gen.stderr);
  const keyId = /key id: (\w+)/.exec(gen.stdout)[1];
  const run = closedRun(env);
  run.ok(['close', run.runDir]);
  const out = path.join(keys, 'bundle.json');
  const res = ledger(run.root, ['export', run.runDir, '--out', out], env);
  assert.strictEqual(res.status, 0, res.stderr);
  t.after(() => {
    rmDir(run.root);
    rmDir(keys);
  });
  return { ...run, env, keys, keyId, out, bundle: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

const check = (file, args = []) => runScript(VERIFY, [file, ...args], {});

test('a closed run exports a bundle that verifies with no secret, trusted by its key id', (t) => {
  const { out, keyId, bundle } = exported(t);
  assert.strictEqual(bundle.attestation.verdict, 'APPROVE');
  assert.strictEqual(bundle.attestation.records, bundle.records.length);
  assert.strictEqual(bundle.attestation.integrity.intact, true);
  const plain = check(out);
  assert.strictEqual(plain.status, 0, plain.stdout);
  assert.strictEqual(JSON.parse(plain.stdout).valid, true);
  const trusted = check(out, ['--trust', keyId]);
  assert.strictEqual(trusted.status, 0, trusted.stdout);
  assert.strictEqual(JSON.parse(trusted.stdout).trusted, true);
  const stranger = check(out, ['--trust', 'f'.repeat(32)]);
  assert.strictEqual(stranger.status, 3, 'valid but signed by a key nobody named');
});

test('each tampering an auditor must catch is caught', (t) => {
  const { bundle } = exported(t);
  const clone = () => JSON.parse(JSON.stringify(bundle));
  const cases = {
    'a record payload changed': (b) => { b.records[2].payload.stage = 'qa'; },
    'the last record dropped': (b) => { b.records.pop(); },
    'a record inserted': (b) => { b.records.splice(3, 0, { ...b.records[3] }); },
    'the attestation verdict edited': (b) => { b.attestation.verdict = 'BLOCK'; },
    'the attestation integrity edited': (b) => { b.attestation.integrity = { intact: true, problems: [] }; b.attestation.dispatches = 0; },
  };
  for (const [what, mutate] of Object.entries(cases)) {
    const b = clone();
    mutate(b);
    assert.strictEqual(verifyBundle(b).valid, false, `${what} must not verify`);
  }
});

test('a bundle re-signed with another key verifies only as untrusted', (t) => {
  const { bundle, keyId } = exported(t);
  const crypto = require('node:crypto');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const forged = JSON.parse(JSON.stringify(bundle));
  forged.attestation.verdict = 'APPROVE';
  forged.publicKey = publicKey.export({ type: 'spki', format: 'pem' });
  forged.attestation.keyId = require(path.join(SCRIPTS_DIR, 'attest.js')).keyIdOf(forged.publicKey);
  forged.signature = crypto.sign(null, Buffer.from(canonical(forged.attestation)), privateKey).toString('base64');
  const r = verifyBundle(forged, [keyId]);
  assert.strictEqual(r.valid, true, 'internally consistent');
  assert.strictEqual(r.trusted, false, 'but not signed by the key the verifier trusts');
});

test('export refuses an open run, a run without a key, and a chain that does not verify', (t) => {
  const keys = mkTmpDir('tl-keys');
  const env = keyEnv(keys);
  const run = closedRun(env);
  t.after(() => {
    rmDir(run.root);
    rmDir(keys);
  });
  const out = path.join(keys, 'b.json');
  const open = ledger(run.root, ['export', run.runDir, '--out', out], env);
  assert.strictEqual(open.status, 3, open.stderr);
  assert.ok(open.stderr.includes('not closed'));
  run.ok(['close', run.runDir]);
  const noKey = ledger(run.root, ['export', run.runDir, '--out', out], env);
  assert.strictEqual(noKey.status, 1);
  assert.ok(noKey.stderr.includes('keygen'), noKey.stderr);
  assert.strictEqual(ledger(keys, ['keygen'], env).status, 0);
  const file = chain.chainPath(run.runDir);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"base1"', '"base2"'));
  const broken = ledger(run.root, ['export', run.runDir, '--out', out], env);
  assert.strictEqual(broken.status, 4, broken.stderr);
  assert.ok(!fs.existsSync(out), 'nothing is signed over a chain that does not verify');
});

test('keygen never replaces an existing key', () => {
  const keys = mkTmpDir('tl-keys');
  try {
    const env = keyEnv(keys);
    assert.strictEqual(ledger(keys, ['keygen'], env).status, 0);
    const before = fs.readFileSync(env.TICKET_LOOP_SIGNING_KEY, 'utf8');
    const again = ledger(keys, ['keygen'], env);
    assert.strictEqual(again.status, 1);
    assert.strictEqual(fs.readFileSync(env.TICKET_LOOP_SIGNING_KEY, 'utf8'), before);
  } finally {
    rmDir(keys);
  }
});

// An auditor copies one file; it must not need the harness beside it.
test('the verifier is one self-contained file that canonicalises exactly as the chain does', () => {
  const src = fs.readFileSync(VERIFY, 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(requires)].sort(), ['crypto', 'fs']);
  for (const v of [null, 1, 'a', [3, { b: 1, a: [null, 'x'] }], { z: { y: 2, x: [1] }, a: true }]) {
    assert.strictEqual(canonical(v), chain.canonical(v));
  }
});
