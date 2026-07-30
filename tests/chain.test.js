'use strict';
// The receipt chain's integrity properties. Everything the harness now claims to have
// verified rests on these, so they are tested directly rather than only through ledger.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkRun, rmDir } = require('./helpers.js');

const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

function fresh() {
  const { root, runDir } = mkRun({});
  chain.create(runDir);
  return { root, runDir };
}

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

test('truncating the chain is detected as a broken seal or link', () => {
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
