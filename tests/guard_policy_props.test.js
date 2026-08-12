'use strict';
// Property-based companion to guard_policy.test.js. That file pins specific attack strings;
// this one asserts invariants that must hold for ALL inputs, using a hand-rolled seeded
// generator (zero runtime deps is a hard repo constraint, so no fast-check).
//
// Every property draws >=500 inputs from a fixed seed, so a failure reproduces exactly from
// the printed case. Nothing here uses the platform RNG — reproducibility is the whole point,
// and C4 proves that mechanically by reading this file back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR } = require('./helpers.js');

const policy = require(path.join(HOOKS_DIR, 'guard_policy.js'));

const DRAWS = 600; // per property; the AC floor is 500 and each property asserts it cleared it.
const SEED = 0x9e3779b9; // fixed: the sequence — hence every generated case — is identical run to run.

// mulberry32: a small deterministic PRNG. Math.imul/xor/shift only, no platform randomness.
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[int(rng, 0, arr.length - 1)];

// Character pools for arbitrary-string fuzzing. Named so the robustness property can mix them
// to hit the categories the AC calls out: control chars, unicode, shell metacharacters.
const CONTROL = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).concat('\x7f');
const ASCII = Array.from({ length: 0x5f }, (_, i) => String.fromCharCode(0x20 + i));
const UNICODE = ['λ', '中', '日', 'é', 'Ω', '𝕏', '🙈', '\u200b', '\u0301', '\u202e', '\ufeff', 'ĳ', '👨‍👩‍👧'];
const META = ['"', "'", '`', '$', '(', ')', '|', '&', ';', '>', '<', '\\', '*', '?', '{', '}', '$('];
const POOLS = [CONTROL, ASCII, UNICODE, META];

function randString(rng, maxLen) {
  const len = int(rng, 0, maxLen);
  let s = '';
  for (let i = 0; i < len; i++) {
    const pool = pick(rng, POOLS);
    s += pick(rng, pool);
  }
  return s;
}

// --- C1: composition cannot launder a denial ------------------------------------------

// Fragments confirmed denied with runActive:true (each is a case the corpus already pins).
// The property is that decorating a denied command with an extra statement keeps it denied,
// so the base set only needs to be reliably denied — variety matters more than exhaustiveness.
const DENIED_BASES = [
  'rm -rf .agents/ticket-runs/PROJ-1/done.md',
  'echo pwned > .agents/ticket-runs/PROJ-1/done.md',
  'sed -i "s/C3.*//" .agents/ticket-runs/PROJ-1/done.md',
  'Set-Content .agents/ticket-runs/PROJ-1/done.md "{}"',
  'rm .agents/ticket-*/done.md',
  'rm docs/spec.approved.md',
  'rm .git/ticket-loop/PROJ-1/chain.jsonl',
  'cd .agents/ticket-runs/PROJ-1 && rm budget.json',
  'node scripts/ledger.js status .agents/ticket-runs/PROJ-1 $(rm -rf .agents/ticket-runs/PROJ-1)',
  'git checkout HEAD -- .agents/ticket-runs/PROJ-1/done.md',
  'git push',
  'git merge ticket/PROJ-1',
  'git rebase main',
  'gh pr create --fill',
  'git clean -fdx',
  'git reset --hard origin/main',
  'git stash push --include-untracked',
  'powershell -EncodedCommand UwBlAHQA',
  'echo cm0gLXJm | base64 -d | sh',
  'sed -i s/x/y/ plugins/ticket-loop/hooks/guard_policy.js',
  'sort -o .agents/ticket-runs/PROJ-1/done.md /dev/null',
  'echo x > .agents/ticket-loop.config.json',
];

// Statements to bolt on. A mix of innocuous reads and noise: composition must survive both, so
// laundering by burying the denied command among harmless-looking ones cannot work.
const EXTRA_STATEMENTS = ['echo ok', 'ls', 'git status', 'true', 'cat README.md', 'pwd', 'rg TODO lib', 'npm test'];
const SEPARATORS = ['; ', ' && ', ' || ', '\n'];

test('C1 composition: a denied command stays denied when another statement is prefixed or appended', () => {
  const rng = makeRng(SEED);
  const denied = (cmd) => policy.commandVerdict(cmd, { runActive: true }) !== null;
  let exercised = 0;
  for (let i = 0; i < DRAWS; i++) {
    const base = pick(rng, DENIED_BASES);
    // Premise of the property: the base is genuinely denied. If a base ever stops being denied
    // that is itself a finding, so assert it rather than skipping silently.
    assert.ok(denied(base), `base expected denied: ${JSON.stringify(base)}`);

    const extra = pick(rng, EXTRA_STATEMENTS);
    const sep = pick(rng, SEPARATORS);
    const prefixed = extra + sep + base;
    const appended = base + sep + extra;

    assert.ok(denied(prefixed), `prefixing laundered a denial: ${JSON.stringify(prefixed)}`);
    assert.ok(denied(appended), `appending laundered a denial: ${JSON.stringify(appended)}`);
    exercised++;
  }
  assert.ok(exercised >= 500, `composition exercised ${exercised} denied inputs, need >=500`);
});

// --- C2: the verdict functions never throw --------------------------------------------

test('C2 robustness: commandVerdict, pathVerdict and riskVerdict never throw on arbitrary input', () => {
  const rng = makeRng(SEED ^ 0x55555555);
  // Degenerate inputs the generator is unlikely to hit but the AC names explicitly.
  const edge = [
    '',
    ' ',
    'a'.repeat(50000),
    '"'.repeat(2000),
    "'".repeat(2000),
    '`'.repeat(1000),
    '$('.repeat(1000),
    '\x00\x01\x02\x1b',
    '\u202e\u0301\ufeff',
    '"\'`\\',
    '.agents/ticket-runs/'.repeat(500) + 'done.md',
    '\n\r\n\r',
    'cd '.repeat(1000),
  ];

  let n = 0;
  const feed = (s) => {
    const runActive = rng() < 0.5;
    // riskPaths mixes real globs with garbage, exercising riskVerdict's per-glob try/catch.
    const riskPaths = [pick(rng, ['**/*.js', 'a/**', '[', '(((', randString(rng, 12)])];
    assert.doesNotThrow(() => policy.commandVerdict(s, { runActive }), `commandVerdict threw: ${JSON.stringify(s.slice(0, 80))}`);
    assert.doesNotThrow(() => policy.pathVerdict(s, { runActive }), `pathVerdict threw: ${JSON.stringify(s.slice(0, 80))}`);
    assert.doesNotThrow(
      () => policy.riskVerdict(s, { runActive, riskPaths, cleared: [pick(rng, riskPaths)] }),
      `riskVerdict threw: ${JSON.stringify(s.slice(0, 80))}`
    );
    n++;
  };

  for (const s of edge) feed(s);
  for (let i = 0; i < DRAWS; i++) feed(randString(rng, int(rng, 0, 400)));
  assert.ok(n >= 500, `robustness exercised ${n} inputs, need >=500`);
});

// --- C3: quoting arguments preserves read-only status ---------------------------------

// Unconditionally read-only verbs: no write-through flag (sort -o), no subcommand rules (git).
const READ_VERBS = ['cat', 'head', 'tail', 'grep', 'rg', 'ls', 'wc', 'nl', 'stat', 'cut', 'more', 'less', 'type', 'get-content', 'test-path'];
// Argument tokens. May carry spaces, unicode and protected paths — but never a shell operator,
// because an operator is not an argument, and quoting one would be a different question.
const ARG_TOKENS = [
  'README.md',
  'lib/src/thing.dart',
  '.agents/ticket-runs/PROJ-1/done.md',
  'docs/spec.approved.md',
  'a file with spaces',
  'té st',
  '中文/路径',
  '.git/ticket-loop/PROJ-1/chain.jsonl',
  'C:/repo/.agents/ticket-runs/PROJ-1/budget.json',
  '--not-a-flag-here',
];

test('C3 quote stability: a read-only command stays read-only when its arguments are quoted', () => {
  const rng = makeRng(SEED ^ 0x0f0f0f0f);
  let exercised = 0;
  for (let i = 0; i < DRAWS; i++) {
    const verb = pick(rng, READ_VERBS);
    const args = Array.from({ length: int(rng, 0, 3) }, () => pick(rng, ARG_TOKENS));
    const bare = [verb, ...args].join(' ');
    const quoted = [verb, ...args.map((a) => `"${a}"`)].join(' ');

    // Premise: the bare form is read-only. Constructed to be, so assert rather than skip.
    assert.ok(policy.isReadOnly(bare), `bare expected read-only: ${JSON.stringify(bare)}`);
    assert.ok(policy.isReadOnly(quoted), `quoting arguments broke read-only status: ${JSON.stringify(quoted)}`);

    // A read-only command is allowed even when it names a protected path; quoting must not flip
    // that verdict in either direction.
    for (const runActive of [true, false]) {
      const b = policy.commandVerdict(bare, { runActive }) === null;
      const q = policy.commandVerdict(quoted, { runActive }) === null;
      assert.strictEqual(q, b, `quoting changed the verdict (runActive=${runActive}): ${JSON.stringify(quoted)}`);
    }
    exercised++;
  }
  assert.ok(exercised >= 500, `quote stability exercised ${exercised} inputs, need >=500`);
});

// --- C4: the generator is deterministic and platform-RNG-free -------------------------

test('C4 determinism: the seeded generator is reproducible and the file uses no platform RNG', () => {
  // Same seed -> identical sequence, so every case above reproduces exactly.
  const a = makeRng(SEED);
  const b = makeRng(SEED);
  const seqA = Array.from({ length: 1000 }, () => a());
  const seqB = Array.from({ length: 1000 }, () => b());
  assert.deepStrictEqual(seqA, seqB, 'same seed produced diverging sequences');

  // A different seed must diverge, or "seeded" would be meaningless.
  const c = makeRng(SEED + 1);
  const seqC = Array.from({ length: 1000 }, () => c());
  assert.notDeepStrictEqual(seqA, seqC, 'different seeds produced the same sequence');

  // Mechanical guard on AC4: this file must not reach for the platform RNG. The needle is
  // assembled from pieces so it never appears as a literal substring of this source itself.
  const needle = 'Math' + '.' + 'random';
  const src = fs.readFileSync(__filename, 'utf8');
  assert.ok(!src.includes(needle), 'test file must not use the platform RNG — determinism requires a seeded generator');
});
