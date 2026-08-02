'use strict';
// The receipt chain's integrity properties. Everything the harness now claims to have
// verified rests on these, so they are tested directly rather than only through ledger.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SCRIPTS_DIR, mkRun, rmDir } = require('./helpers.js');

const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

function fresh() {
  const { root, runDir } = mkRun({});
  chain.create(runDir);
  return { root, runDir };
}

// Appending derives seq and prev from the current last record, so concurrent writers would
// both claim the same seq and the chain would then report itself tampered. The loop dispatches
// subagents in parallel, so this is an ordinary run, not an attack.
test('concurrent appends keep the chain intact', async () => {
  const { root, runDir } = fresh();
  try {
    const worker = path.join(root, 'worker.js');
    fs.writeFileSync(
      worker,
      `const chain = require(${JSON.stringify(path.join(SCRIPTS_DIR, 'chain.js'))});\n` +
        `const until = Number(process.argv[3]);\n` +
        `while (Date.now() < until) {}\n` + // spin so every worker enters together
        `chain.append(process.argv[2], 'dispatch', { label: process.argv[4] });\n`
    );

    const WORKERS = 8;
    const startAt = Date.now() + 700;
    const codes = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        new Promise((resolve) => {
          const kid = spawn(process.execPath, [worker, runDir, String(startAt), `w${i + 1}`], {
            stdio: 'ignore',
          });
          kid.on('exit', resolve);
        })
      )
    );
    assert.deepStrictEqual(codes.filter((c) => c !== 0), [], 'every concurrent append must succeed');

    const result = chain.verify(runDir);
    assert.deepStrictEqual(result.problems, [], 'concurrent appends must not corrupt the chain');
    assert.strictEqual(result.ok, true);

    // chain.create() leaves the file empty — the 'init' RECORD is ledger.js's doing — so the
    // only records here are the workers' own.
    const recs = chain.records(runDir);
    assert.strictEqual(recs.length, WORKERS, 'every worker appends exactly once, none lost');
    assert.deepStrictEqual(
      recs.map((r) => r.seq),
      recs.map((_, i) => i + 1),
      'seq numbers must be contiguous with no duplicates'
    );
    const labels = new Set(chain.ofKind(runDir, 'dispatch').map((r) => r.payload.label));
    assert.strictEqual(labels.size, WORKERS, 'no append may be lost');
  } finally {
    rmDir(root);
  }
});

// The real race window is sub-microsecond, so the denial is fabricated (ACL deny, lifted by a
// helper 400ms later) rather than raced for. Under POSIX root the chmod does not deny and only
// the happy path runs.
test('a transiently denied lock mkdir is waited out, not fatal', async () => {
  const { root, runDir } = fresh();
  const chainDir = chain.resolveChainDir(runDir).dir;
  const { spawnSync } = require('node:child_process');
  const deny = () =>
    process.platform === 'win32'
      ? spawnSync('icacls', [chainDir, '/deny', '*S-1-1-0:(AD)'])
      : fs.chmodSync(chainDir, 0o555);
  const restore = () => {
    if (process.platform === 'win32') spawnSync('icacls', [chainDir, '/remove:d', '*S-1-1-0']);
    else fs.chmodSync(chainDir, 0o755);
  };
  try {
    const restorer = path.join(root, 'restorer.js');
    fs.writeFileSync(
      restorer,
      `const fs = require('fs');\n` +
        `const { spawnSync } = require('child_process');\n` +
        `setTimeout(() => {\n` +
        `  if (process.platform === 'win32') spawnSync('icacls', [process.argv[2], '/remove:d', '*S-1-1-0']);\n` +
        `  else fs.chmodSync(process.argv[2], 0o755);\n` +
        `}, 400);\n`
    );
    deny();
    const kid = spawn(process.execPath, [restorer, chainDir], { stdio: 'ignore' });
    const exited = new Promise((resolve) => kid.on('exit', resolve));

    const rec = chain.append(runDir, 'dispatch', { label: 'after-denial' });
    assert.strictEqual(rec.seq, 1, 'the append waits out the denial instead of dying on it');
    assert.deepStrictEqual(chain.verify(runDir).problems, []);
    await exited;
  } finally {
    restore();
    rmDir(root);
  }
});

test('a stale lock left by a killed process does not deadlock the chain', () => {
  const { root, runDir } = fresh();
  try {
    const lock = path.join(chain.resolveChainDir(runDir).dir, chain.LOCK_NAME);
    fs.mkdirSync(lock);
    // Backdate it well past the staleness window, as an abandoned lock would be.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    const rec = chain.append(runDir, 'dispatch', { label: 'after-stale-lock' });
    assert.strictEqual(rec.seq, 1, 'the append proceeds instead of waiting on an abandoned lock');
    assert.ok(!fs.existsSync(lock), 'the stale lock is cleared, not left behind');
    assert.deepStrictEqual(chain.verify(runDir).problems, []);
  } finally {
    rmDir(root);
  }
});

test('the chain lives outside the run dir, under the git dir', () => {
  const { root, runDir } = fresh();
  try {
    const { dir, inGit } = chain.resolveChainDir(runDir);
    assert.strictEqual(inGit, true);
    assert.strictEqual(path.resolve(dir), path.resolve(path.join(root, '.git', 'ticket-loop', 'T-1')));
    assert.ok(!path.resolve(dir).startsWith(path.resolve(runDir)), 'the chain must not sit where the loop can write');
  } finally {
    rmDir(root);
  }
});

test('a linked worktree resolves to the real git dir, not its .git file', () => {
  const { root, runDir } = fresh();
  try {
    // Simulate a worktree layout: .git is a FILE pointing elsewhere.
    const alt = path.join(root, 'realgit');
    fs.mkdirSync(alt, { recursive: true });
    const wt = path.join(root, 'wt');
    fs.mkdirSync(path.join(wt, '.agents', 'ticket-runs', 'T-9'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${alt}\n`);
    const { dir } = chain.resolveChainDir(path.join(wt, '.agents', 'ticket-runs', 'T-9'));
    assert.strictEqual(path.resolve(dir), path.resolve(path.join(alt, 'ticket-loop', 'T-9')));
  } finally {
    rmDir(root);
  }
});

test('appended records are sequenced, linked, and sealed', () => {
  const { root, runDir } = fresh();
  try {
    chain.append(runDir, 'init', { maxDispatches: 25 });
    chain.append(runDir, 'dispatch', { label: 'implementer: C1' });
    const v = chain.verify(runDir);
    assert.ok(v.ok, JSON.stringify(v.problems));
    assert.strictEqual(v.records.length, 2);
    assert.strictEqual(v.records[0].prev, null);
    assert.strictEqual(v.records[1].prev, v.records[0].hmac);
  } finally {
    rmDir(root);
  }
});

test('editing a record breaks its seal', () => {
  const { root, runDir } = fresh();
  try {
    chain.append(runDir, 'check', { id: 'C3', result: 'FAIL' });
    const file = chain.chainPath(runDir);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    rec.payload.result = 'PASS';
    fs.writeFileSync(file, JSON.stringify(rec) + '\n');
    const v = chain.verify(runDir);
    assert.ok(!v.ok);
    assert.ok(v.problems.some((p) => p.includes('seal does not match')), JSON.stringify(v.problems));
  } finally {
    rmDir(root);
  }
});

test('deleting a record from the middle breaks the prev-link', () => {
  const { root, runDir } = fresh();
  try {
    chain.append(runDir, 'a', {});
    chain.append(runDir, 'b', {});
    chain.append(runDir, 'c', {});
    const file = chain.chainPath(runDir);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    fs.writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');
    const v = chain.verify(runDir);
    assert.ok(!v.ok);
    assert.ok(v.problems.some((p) => /seq|prev-link/.test(p)), JSON.stringify(v.problems));
  } finally {
    rmDir(root);
  }
});

test('dropping the FIRST record is detected by the seq check', () => {
  const { root, runDir } = fresh();
  try {
    chain.append(runDir, 'a', {});
    chain.append(runDir, 'b', {});
    const file = chain.chainPath(runDir);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    // Keep only the second record: seq 2 where seq 1 is expected.
    fs.writeFileSync(file, lines[1] + '\n');
    const v = chain.verify(runDir);
    assert.ok(!v.ok);
    assert.ok(v.problems.some((p) => p.includes('seq is 2')), JSON.stringify(v.problems));
  } finally {
    rmDir(root);
  }
});

// The variant that actually matters, and that nothing caught: drop records off the END. Every
// remaining seq is contiguous, every prev-link resolves, every seal recomputes — so links and
// seals cannot see it, and no key is needed. This is how spent dispatches or a BLOCK verdict
// would be erased. Only the head anchor notices.
test('dropping the LAST records is detected by the head anchor', () => {
  const { root, runDir } = fresh();
  try {
    for (const k of ['a', 'b', 'c', 'd']) chain.append(runDir, k, {});
    const file = chain.chainPath(runDir);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n');

    const v = chain.verify(runDir);
    assert.ok(!v.ok, 'tail truncation must not verify clean');
    assert.ok(v.problems.some((p) => p.includes('TRUNCATED')), JSON.stringify(v.problems));
    // And specifically NOT via seq/prev-link, which is why the anchor had to exist.
    assert.ok(!v.problems.some((p) => /seq is|prev-link/.test(p)), JSON.stringify(v.problems));
  } finally {
    rmDir(root);
  }
});

test('emptying the chain file is detected rather than reading as a fresh run', () => {
  const { root, runDir } = fresh();
  try {
    chain.append(runDir, 'dispatch', { label: 'one' });
    fs.writeFileSync(chain.chainPath(runDir), '');
    const v = chain.verify(runDir);
    assert.ok(!v.ok);
    assert.ok(v.problems.some((p) => p.includes('truncated to nothing')), JSON.stringify(v.problems));
  } finally {
    rmDir(root);
  }
});

test('editing the head anchor is itself detected', () => {
  const { root, runDir } = fresh();
  try {
    chain.append(runDir, 'a', {});
    chain.append(runDir, 'b', {});
    const head = JSON.parse(fs.readFileSync(chain.headPath(runDir), 'utf8'));
    head.records = 1;
    fs.writeFileSync(chain.headPath(runDir), JSON.stringify(head) + '\n');
    const v = chain.verify(runDir);
    assert.ok(!v.ok);
    assert.ok(v.problems.some((p) => p.includes('anchor seal does not match')), JSON.stringify(v.problems));
  } finally {
    rmDir(root);
  }
});

test('a deleted head anchor is reported, not shrugged off', () => {
  const { root, runDir } = fresh();
  try {
    chain.append(runDir, 'a', {});
    fs.unlinkSync(chain.headPath(runDir));
    const v = chain.verify(runDir);
    assert.ok(!v.ok);
    assert.ok(v.problems.some((p) => p.includes('head anchor')), JSON.stringify(v.problems));
  } finally {
    rmDir(root);
  }
});

// Known-answer test. Without this the whole suite passes when sealOf is changed to an UNKEYED
// sha256 of the same material — verified by mutation — which would mean anyone could re-seal a
// rewritten history without ever reading the key, i.e. the stated threat model would be false
// while every test stayed green. verify() cannot check this for us: it recomputes with the same
// function it is testing.
test('the seal is a keyed HMAC of the record, not a bare hash', () => {
  const crypto = require('node:crypto');
  const key = 'ab'.repeat(32);
  const record = { seq: 1, kind: 'gate', at: '2026-01-01T00:00:00.000Z', payload: { stage: 'qa' }, prev: null };
  const material = [record.seq, record.kind, record.at, chain.canonical(record.payload), record.prev].join('|');

  const expected = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(material).digest('hex');
  assert.strictEqual(chain.sealOf(key, record), expected, 'seal must be HMAC-SHA256 over the canonical material');

  // Rule out the two degenerate implementations: a plain digest, and one ignoring the key.
  assert.notStrictEqual(chain.sealOf(key, record), crypto.createHash('sha256').update(material).digest('hex'));
  assert.notStrictEqual(
    chain.sealOf(key, record),
    chain.sealOf('cd'.repeat(32), record),
    'a different key must produce a different seal'
  );
});

test('a history rewritten and re-sealed under the wrong key does not verify', () => {
  const { root, runDir } = fresh();
  try {
    chain.append(runDir, 'check', { id: 'C1', result: 'FAIL' });
    const wrongKey = 'ef'.repeat(32);
    const rec = JSON.parse(fs.readFileSync(chain.chainPath(runDir), 'utf8').trim());
    rec.payload.result = 'PASS';
    delete rec.hmac;
    rec.hmac = chain.sealOf(wrongKey, rec);
    fs.writeFileSync(chain.chainPath(runDir), JSON.stringify(rec) + '\n');

    const v = chain.verify(runDir);
    assert.ok(!v.ok, 're-sealing without the run key must fail');
    assert.ok(v.problems.some((p) => p.includes('seal does not match')), JSON.stringify(v.problems));
  } finally {
    rmDir(root);
  }
});

test('a missing key makes the chain unverifiable rather than silently fine', () => {
  const { root, runDir } = fresh();
  try {
    chain.append(runDir, 'a', {});
    fs.unlinkSync(chain.keyPath(runDir));
    const v = chain.verify(runDir);
    assert.ok(!v.ok);
    assert.ok(v.problems.some((p) => p.includes('key is missing')));
  } finally {
    rmDir(root);
  }
});

test('rotate retires the chain with its final seal and starts a new key', () => {
  const { root, runDir } = fresh();
  try {
    chain.append(runDir, 'init', {});
    chain.append(runDir, 'dispatch', {});
    const before = fs.readFileSync(chain.keyPath(runDir), 'utf8');

    const rotated = chain.rotate(runDir);
    assert.strictEqual(rotated.retiredRecords, 2);
    assert.ok(rotated.retiredSeal);
    assert.ok(fs.existsSync(path.join(chain.resolveChainDir(runDir).dir, 'chain.1.jsonl')));
    assert.strictEqual(chain.records(runDir).length, 0);
    assert.notStrictEqual(fs.readFileSync(chain.keyPath(runDir), 'utf8'), before);
  } finally {
    rmDir(root);
  }
});

test('appending without a chain throws NO_CHAIN rather than writing anywhere', () => {
  const { root, runDir } = mkRun({});
  try {
    assert.throws(() => chain.append(runDir, 'init', {}), (e) => e.code === 'NO_CHAIN');
  } finally {
    rmDir(root);
  }
});

test('hashEvidence records missing files as missing instead of implying evidence', () => {
  const { root, runDir } = fresh();
  try {
    const real = path.join(runDir, 'done.md');
    fs.writeFileSync(real, '# Done\n');
    const [present, absent] = chain.hashEvidence([real, path.join(runDir, 'nope.md')]);
    assert.strictEqual(present.sha256.length, 64);
    assert.ok(!present.missing);
    assert.strictEqual(absent.sha256, null);
    assert.strictEqual(absent.missing, true);
  } finally {
    rmDir(root);
  }
});

test('canonical JSON is key-order independent, so seals do not depend on formatting', () => {
  assert.strictEqual(chain.canonical({ a: 1, b: [2, { d: 4, c: 3 }] }), chain.canonical({ b: [2, { c: 3, d: 4 }], a: 1 }));
});
