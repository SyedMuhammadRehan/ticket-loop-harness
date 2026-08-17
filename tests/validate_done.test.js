'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkRun, rmDir, runScript, ledger } = require('./helpers.js');

const SCRIPT = path.join(SCRIPTS_DIR, 'validate_done.js');

// The validator now checks `run:` against the profile, so tests need a profile.
const CONFIG = { verify: { test: 'pytest -q', analyze: 'ruff check .' } };

const VALID_DRAFT = `# Done — T-1
## Criteria
- [ ] C1 (test): repo maps 404 | run: pytest tests/test_repo.py
- [ ] C2 (analyzer): zero analyzer errors | run: ruff check .
- [ ] C3 (manual): eyeball the empty state
## Tokens
- errorColor: #B00020 (source: design-spec.md#colors)
## Out of scope
- offline banner
`;

function writeDraft(content, extra = {}) {
  const { root, runDir } = mkRun(CONFIG);
  ledger(root, ['init', runDir, 'abc123']);
  fs.writeFileSync(path.join(runDir, 'done.draft.md'), content);
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(runDir, name), body);
  return { root, runDir };
}
const validate = (root, runDir) => runScript(SCRIPT, [runDir], { cwd: root });

function expectInvalid(content, needle, extra) {
  const { root, runDir } = writeDraft(content, extra);
  try {
    const res = validate(root, runDir);
    assert.strictEqual(res.status, 1, `expected invalid, got:\n${res.stdout}`);
    assert.ok(res.stderr.includes(needle), `expected "${needle}" in:\n${res.stderr}`);
  } finally {
    rmDir(root);
  }
}

test('valid draft passes and seals a validation receipt', () => {
  const { root, runDir } = writeDraft(VALID_DRAFT);
  try {
    const res = validate(root, runDir);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('receipt sealed'));
  } finally {
    rmDir(root);
  }
});

test('fewer than 2 non-manual criteria fails', () => {
  expectInvalid(VALID_DRAFT.replace('- [ ] C2 (analyzer): zero analyzer errors | run: ruff check .\n', ''), 'need >=2 non-manual');
});

test('non-manual criterion without a run: command fails', () => {
  expectInvalid(VALID_DRAFT.replace(' | run: pytest tests/test_repo.py', ''), 'missing "| run:"');
});

test('more than one manual criterion fails', () => {
  expectInvalid(VALID_DRAFT.replace('## Tokens', '- [ ] C4 (manual): second eyeball\n## Tokens'), 'max 1 manual');
});

test('token without a design-spec source fails', () => {
  expectInvalid(VALID_DRAFT.replace(' (source: design-spec.md#colors)', ''), 'token without design-spec source');
});

test('empty out-of-scope section fails', () => {
  expectInvalid(VALID_DRAFT.replace('- offline banner\n', ''), 'Out of scope');
});

// --- a contract that would be green by construction must not validate ---

test('an analyzer-only done-list proves nothing about behaviour — fails', () => {
  expectInvalid(
    `# Done — T-1
## Criteria
- [ ] C1 (analyzer): zero analyzer errors | run: ruff check .
- [ ] C2 (analyzer): still zero analyzer errors | run: ruff check .
## Out of scope
- literally the entire feature
`,
    'no (test) or (runtime) criterion'
  );
});

test('a run: command that is not the repo\'s real verify command — fails', () => {
  expectInvalid(VALID_DRAFT.replace('run: pytest tests/test_repo.py', 'run: true'), 'must be checked by the real command');
  expectInvalid(VALID_DRAFT.replace('run: ruff check .', 'run: echo ok'), 'must be checked by the real command');
});

test('duplicate criterion ids fail', () => {
  expectInvalid(VALID_DRAFT.replace('- [ ] C2 (analyzer)', '- [ ] C1 (analyzer)'), 'duplicate criterion id C1');
});

test('a criterion with no C<n> id fails', () => {
  expectInvalid(VALID_DRAFT.replace('- [ ] C1 (test):', '- [ ] (test):'), 'no "C<n>" id');
});

test('criteria pre-ticked before the freeze fail', () => {
  expectInvalid(VALID_DRAFT.replace('- [ ] C1', '- [x] C1'), 'already ticked before the freeze');
});

test('runtime criteria may use a non-command runner', () => {
  const { root, runDir } = writeDraft(
    VALID_DRAFT.replace('- [ ] C3 (manual): eyeball the empty state', '- [ ] C3 (runtime): no console errors on /profile | run: playwright:profile-error')
  );
  try {
    assert.strictEqual(validate(root, runDir).status, 0, validate(root, runDir).stderr);
  } finally {
    rmDir(root);
  }
});

// --- approach.md contract (Stage 2.5) ---

const VALID_APPROACH = `# Approach — T-1
## Data
- profile: owned by the API; this change reads it
## Boundary
- change lives behind ProfileRepository; callers see the same interface
## Options
- A: map errors in the repository — keeps UI dumb
- B: map errors in the widget — fewer files touched, leaks transport details upward
## Chosen
- A: error semantics belong at the data boundary; B couples UI to transport exceptions | reuses: the existing Result type and its error mapping
## Failure modes
- API returns 404/500 | covered-by: C1
- device offline | covered-by: out-of-scope (tracked by the offline-banner ticket)
## Slice order
- 1st: C1 error mapping — proves the repository boundary can express typed errors
`;

const withApproach = (draft, approach) => writeDraft(draft, { 'approach.md': approach });

function expectApproachInvalid(approach, needle) {
  const { root, runDir } = withApproach(VALID_DRAFT, approach);
  try {
    const res = validate(root, runDir);
    assert.strictEqual(res.status, 1, `expected invalid, got:\n${res.stdout}`);
    assert.ok(res.stderr.includes(needle), `expected "${needle}" in:\n${res.stderr}`);
  } finally {
    rmDir(root);
  }
}

test('valid draft + valid approach passes and reports the contract check', () => {
  const { root, runDir } = withApproach(VALID_DRAFT, VALID_APPROACH);
  try {
    const res = validate(root, runDir);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('approach contract checked'));
  } finally {
    rmDir(root);
  }
});

test('failure mode without a covered-by tag fails', () => {
  expectApproachInvalid(VALID_APPROACH.replace(' | covered-by: C1', ''), 'covered-by');
});

test('failure mode pointing at a criterion that does not exist fails', () => {
  expectApproachInvalid(VALID_APPROACH.replace('| covered-by: C1', '| covered-by: C9'), 'no criterion C9');
});

test('a single option is a guess, not a decision — fails', () => {
  expectApproachInvalid(
    VALID_APPROACH.replace('- B: map errors in the widget — fewer files touched, leaks transport details upward\n', ''),
    '>=2 options'
  );
});

test('empty Chosen and empty Failure modes both fail', () => {
  const gutted = VALID_APPROACH
    .replace('- A: error semantics belong at the data boundary; B couples UI to transport exceptions | reuses: the existing Result type and its error mapping\n', '')
    .replace(/- API returns 404\/500 \| covered-by: C1\n- device offline \| covered-by: out-of-scope \([^)]*\)\n/, '');
  expectApproachInvalid(gutted, 'Chosen');
});

test('out-of-scope without a reason is a silent opt-out — fails', () => {
  expectApproachInvalid(
    VALID_APPROACH.replace('| covered-by: out-of-scope (tracked by the offline-banner ticket)', '| covered-by: out-of-scope'),
    'out-of-scope (<reason>)'
  );
});

test('an out-of-scope "reason" too thin to be a decision fails', () => {
  expectApproachInvalid(VALID_APPROACH.replace('(tracked by the offline-banner ticket)', '(.)'), 'too thin to be a decision');
  expectApproachInvalid(VALID_APPROACH.replace('(tracked by the offline-banner ticket)', '(later)'), 'too thin to be a decision');
});

test('waiving EVERY failure mode leaves the contract covering nothing — fails', () => {
  expectApproachInvalid(
    VALID_APPROACH.replace('| covered-by: C1', '| covered-by: out-of-scope (handled by the upstream gateway instead)'),
    'all 2 failure mode(s) are waived'
  );
});

test('a duplicated section heading cannot hide an unvalidated second block — fails', () => {
  expectApproachInvalid(VALID_APPROACH + '## Failure modes\n- newly discovered dangerous case, untagged\n', 'duplicate');
});

test('heading match is case-insensitive (formatting drift must not false-fail)', () => {
  const { root, runDir } = withApproach(VALID_DRAFT, VALID_APPROACH.replace('## Chosen', '## chosen'));
  try {
    assert.strictEqual(validate(root, runDir).status, 0, validate(root, runDir).stderr);
  } finally {
    rmDir(root);
  }
});

test('no approach.md and no survey means no approach checks (trivial tickets stay cheap)', () => {
  const { root, runDir } = writeDraft(VALID_DRAFT);
  try {
    const res = validate(root, runDir);
    assert.strictEqual(res.status, 0);
    assert.ok(!res.stdout.includes('approach contract'));
  } finally {
    rmDir(root);
  }
});

// Declaring a ticket "trivial" must not waive the failure-mode contract, so the checks
// cannot be gated on approach.md merely existing.
test('a survey artifact makes approach.md mandatory — deleting it is not a way out', () => {
  expectInvalid(VALID_DRAFT, 'there is no approach.md', { 'codebase-map.md': '# map\n- lib/data/profile_repository.dart\n' });
});

test('with the survey present, a real approach.md validates', () => {
  const { root, runDir } = writeDraft(VALID_DRAFT, {
    'codebase-map.md': '# map\n- lib/data/profile_repository.dart\n',
    'approach.md': VALID_APPROACH,
  });
  try {
    assert.strictEqual(validate(root, runDir).status, 0, validate(root, runDir).stderr);
  } finally {
    rmDir(root);
  }
});

test('Tokens accepts an explicit "none" when there is no design source', () => {
  for (const line of ['- none', '- none (designSource: none — no visual contract)', '- None (LOGIC-ONLY)']) {
    const { root, runDir } = writeDraft(
      VALID_DRAFT.replace('- errorColor: #B00020 (source: design-spec.md#colors)', line)
    );
    try {
      const res = validate(root, runDir);
      assert.strictEqual(res.status, 0, `"${line}" must be accepted:\n${res.stderr}`);
    } finally {
      rmDir(root);
    }
  }
});

test('a baseline-relative criterion cannot be settled by the bare verify command', () => {
  for (const c of [
    '- [ ] C4 (analyzer): no new eslint problems vs branch point 52e2981 (pre-existing 18) | run: ruff check .',
    '- [ ] C4 (analyzer): the problem set stays a subset of the baseline | run: ruff check .',
    '- [ ] C4 (test): no new failures vs the branch point | run: pytest -q',
  ]) {
    expectInvalid(VALID_DRAFT.replace('- [ ] C2 (analyzer): zero analyzer errors | run: ruff check .', c), 'reports absolute state');
  }
});

test('a command that performs the comparison is accepted; a stand-in is not', () => {
  const relative = '- [ ] C2 (analyzer): no new problems vs the baseline | run: ruff-delta --base abc123';
  const { root, runDir } = writeDraft(
    VALID_DRAFT.replace('- [ ] C2 (analyzer): zero analyzer errors | run: ruff check .', relative)
  );
  try {
    assert.strictEqual(validate(root, runDir).status, 0, validate(root, runDir).stderr);
  } finally {
    rmDir(root);
  }
  expectInvalid(
    VALID_DRAFT.replace('- [ ] C2 (analyzer): zero analyzer errors | run: ruff check .', '- [ ] C2 (analyzer): no new problems vs the baseline | run: true'),
    'decides nothing'
  );
});

test('an absolute criterion still has to name the real command', () => {
  expectInvalid(
    VALID_DRAFT.replace('run: ruff check .', 'run: ruff-delta --base abc123'),
    'must be checked by the real command'
  );
});

test('a token merely NAMED none is still a token', () => {
  for (const line of ['- none: #B00020', '- none-accent: #B00020', '- none = #B00020']) {
    expectInvalid(
      VALID_DRAFT.replace('- errorColor: #B00020 (source: design-spec.md#colors)', line),
      'token without design-spec source'
    );
  }
});

test('"none" is refused when the profile names a design source', () => {
  const { root, runDir } = mkRun({
    designSource: 'figma',
    verify: { test: 'pytest -q', analyze: 'ruff check .' },
  });
  ledger(root, ['init', runDir, 'abc123']);
  try {
    fs.writeFileSync(
      path.join(runDir, 'done.draft.md'),
      VALID_DRAFT.replace('- errorColor: #B00020 (source: design-spec.md#colors)', '- none (no contract)')
    );
    const res = runScript(SCRIPT, [runDir], { cwd: root });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /designSource is "figma"/);
  } finally {
    rmDir(root);
  }
});

test('declaring "none" and then listing tokens is a contradiction', () => {
  expectInvalid(
    VALID_DRAFT.replace(
      '- errorColor: #B00020 (source: design-spec.md#colors)',
      '- none (no visual contract)\n- errorColor: #B00020 (source: design-spec.md#colors)'
    ),
    'declares "none" and then lists'
  );
});

// --- what the design reuses ---
//
// Rung 2 of the implementer's ladder ("is it already in this codebase?") is judged at
// implementation time, by which point a new helper is already written and the reviewer is
// arguing about a diff. The chosen option has to answer it while it is still a sentence.

const REUSE_CLAUSE = ' | reuses: the existing Result type and its error mapping';

test('the chosen option must say what it reuses', () => {
  expectApproachInvalid(VALID_APPROACH.replace(REUSE_CLAUSE, ''), 'reuses');
});

// "none" is a legitimate answer — greenfield areas exist. It is not a legitimate way to skip
// the question, so it costs a reason, exactly as an out-of-scope failure mode does.
test('reuses: none is accepted with a real finding, refused with a thin one', () => {
  expectApproachInvalid(VALID_APPROACH.replace(REUSE_CLAUSE, ' | reuses: none (n/a)'), 'too thin to be a finding');

  const real = VALID_APPROACH.replace(
    REUSE_CLAUSE,
    ' | reuses: none (searched for an existing datacenter repository and found none; this is the first screen in the area)'
  );
  const { root, runDir } = withApproach(VALID_DRAFT, real);
  try {
    assert.strictEqual(validate(root, runDir).status, 0, validate(root, runDir).stderr);
  } finally {
    rmDir(root);
  }
});

// --- wrapped bullets ---
//
// A `| covered-by:` or `| run:` tag that lands on a continuation line belongs to the bullet
// above it, and a line-by-line filter drops it.

const WRAPPED_APPROACH = `# Approach
## Options
- O1 — extend the existing screen
- O2 — a sibling screen
## Chosen
- O2, because the design shows its own nav entry | reuses: the product card/row widgets
## Failure modes
- **Pre-existing compile breakage** in the golden test fails the suite at BASE.
  Mitigation: verify commands are scoped to the non-golden dirs.
  | covered-by: C1
`;

test('a failure mode whose covered-by tag wrapped onto a continuation line is accepted', () => {
  const { root, runDir } = writeDraft(VALID_DRAFT, {
    'approach.md': WRAPPED_APPROACH,
    'codebase-map.md': '# map\n',
  });
  try {
    const res = validate(root, runDir);
    assert.strictEqual(res.status, 0, `expected valid, got:\n${res.stderr}`);
  } finally {
    rmDir(root);
  }
});

// Joining continuation lines must not become a way to pass without the tag at all.
test('a wrapped failure mode with no covered-by anywhere is still rejected', () => {
  expectInvalid(VALID_DRAFT, 'covered-by', {
    'approach.md': WRAPPED_APPROACH.replace('  | covered-by: C1\n', '  and nothing covers it.\n'),
    'codebase-map.md': '# map\n',
  });
});

test('a criterion whose run: command wrapped onto a continuation line is accepted', () => {
  const wrapped = `# Done — T-1
## Criteria
- [ ] C1 (test): the repository maps a 404 response to a NotFound result rather than throwing
  | run: pytest tests/test_repo.py
- [ ] C2 (analyzer): zero analyzer errors | run: ruff check .
## Tokens
- errorColor: #B00020 (source: design-spec.md#colors)
## Out of scope
- offline banner
`;
  const { root, runDir } = writeDraft(wrapped);
  try {
    const res = validate(root, runDir);
    assert.strictEqual(res.status, 0, `expected valid, got:\n${res.stderr}`);
  } finally {
    rmDir(root);
  }
});

// Unindented prose after a list is not part of the last bullet.
test('unindented prose after a bullet list is not folded into the last bullet', () => {
  expectInvalid(VALID_DRAFT, 'covered-by', {
    'approach.md': `# Approach
## Options
- O1 — one way
- O2 — another
## Chosen
- O2 | reuses: the existing filter primitives
## Failure modes
- the mitigation is described below

This paragraph is not part of the bullet. | covered-by: C1
`,
    'codebase-map.md': '# map\n',
  });
});
