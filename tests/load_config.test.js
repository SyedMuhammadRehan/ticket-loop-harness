'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkFakeRepo, mkTmpDir, rmDir, runScript } = require('./helpers.js');

const SCRIPT = path.join(SCRIPTS_DIR, 'load_config.js');

test('no config file: conservative defaults + warning + configFound:false', () => {
  const repo = mkFakeRepo();
  try {
    const res = runScript(SCRIPT, [], { cwd: repo });
    assert.strictEqual(res.status, 0);
    const cfg = JSON.parse(res.stdout);
    assert.strictEqual(cfg._meta.configFound, false);
    assert.strictEqual(cfg.designSource, 'none');
    assert.strictEqual(cfg.ticketSource, 'manual');
    assert.strictEqual(cfg.verify.test, null);
    assert.ok(cfg._meta.warnings.length >= 1);
  } finally {
    rmDir(repo);
  }
});

test('valid config merges over defaults', () => {
  const repo = mkFakeRepo({
    stack: 'python',
    ticketSource: 'github',
    verify: { test: 'pytest -q' },
  });
  try {
    const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: repo }).stdout);
    assert.strictEqual(cfg.stack, 'python');
    assert.strictEqual(cfg.ticketSource, 'github');
    assert.strictEqual(cfg.verify.test, 'pytest -q');
    assert.strictEqual(cfg.verify.analyze, null); // untouched default survives the merge
    assert.strictEqual(cfg._meta.configFound, true);
  } finally {
    rmDir(repo);
  }
});

test('invalid ticketSource/designSource are forced to safe values with warnings', () => {
  const repo = mkFakeRepo({ ticketSource: 'linear', designSource: 'sketch' });
  try {
    const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: repo }).stdout);
    assert.strictEqual(cfg.ticketSource, 'manual');
    assert.strictEqual(cfg.designSource, 'none');
    assert.ok(cfg._meta.warnings.some((w) => w.includes('invalid ticketSource')));
    assert.ok(cfg._meta.warnings.some((w) => w.includes('invalid designSource')));
  } finally {
    rmDir(repo);
  }
});

test('unparsable config falls back to defaults with a parse warning', () => {
  const repo = mkFakeRepo('{ not json');
  try {
    const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: repo }).stdout);
    assert.strictEqual(cfg.stack, 'unknown');
    assert.ok(cfg._meta.warnings.some((w) => w.includes('config parse error')));
  } finally {
    rmDir(repo);
  }
});

test('attribution defaults to no commit trailer; repo policy can set one', () => {
  const bare = mkFakeRepo({});
  const disclosing = mkFakeRepo({ attribution: { commitTrailer: 'Assisted-by: an LLM' } });
  try {
    const def = JSON.parse(runScript(SCRIPT, [], { cwd: bare }).stdout);
    assert.strictEqual(def.attribution.commitTrailer, null);
    const set = JSON.parse(runScript(SCRIPT, [], { cwd: disclosing }).stdout);
    assert.strictEqual(set.attribution.commitTrailer, 'Assisted-by: an LLM');
  } finally {
    rmDir(bare);
    rmDir(disclosing);
  }
});

test('models default to inherit everywhere — full power unless a repo opts out', () => {
  const repo = mkFakeRepo({});
  try {
    const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: repo }).stdout);
    assert.deepStrictEqual(cfg.models, {
      survey: 'inherit',
      implementer: 'inherit',
      fixer: 'inherit',
      qa: 'inherit',
    });
    assert.strictEqual(cfg.qaScope.smallDiffLines, 60);
  } finally {
    rmDir(repo);
  }
});

test('a repo can tier dispatch models; unset roles keep inherit', () => {
  const repo = mkFakeRepo({ models: { survey: 'haiku', implementer: 'sonnet' } });
  try {
    const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: repo }).stdout);
    assert.strictEqual(cfg.models.survey, 'haiku');
    assert.strictEqual(cfg.models.implementer, 'sonnet');
    assert.strictEqual(cfg.models.qa, 'inherit');
    assert.strictEqual(cfg.models.fixer, 'inherit');
  } finally {
    rmDir(repo);
  }
});

test('an unknown models role is dropped with a warning, not silently carried', () => {
  const repo = mkFakeRepo({ models: { judge: 'haiku' } });
  try {
    const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: repo }).stdout);
    assert.strictEqual(cfg.models.judge, undefined);
    assert.ok(cfg._meta.warnings.some((w) => w.includes('unknown models role "judge"')));
  } finally {
    rmDir(repo);
  }
});

test('a non-string or empty model is forced back to inherit with a warning', () => {
  const repo = mkFakeRepo({ models: { survey: 42, qa: '  ' } });
  try {
    const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: repo }).stdout);
    assert.strictEqual(cfg.models.survey, 'inherit');
    assert.strictEqual(cfg.models.qa, 'inherit');
    assert.ok(cfg._meta.warnings.some((w) => w.includes('invalid models.survey')));
    assert.ok(cfg._meta.warnings.some((w) => w.includes('invalid models.qa')));
  } finally {
    rmDir(repo);
  }
});

test('qaScope.smallDiffLines takes overrides, allows 0, and rejects garbage loudly', () => {
  const set = mkFakeRepo({ qaScope: { smallDiffLines: 120 } });
  const never = mkFakeRepo({ qaScope: { smallDiffLines: 0 } });
  const bad = mkFakeRepo({ qaScope: { smallDiffLines: -5 } });
  try {
    assert.strictEqual(JSON.parse(runScript(SCRIPT, [], { cwd: set }).stdout).qaScope.smallDiffLines, 120);
    assert.strictEqual(JSON.parse(runScript(SCRIPT, [], { cwd: never }).stdout).qaScope.smallDiffLines, 0);
    const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: bad }).stdout);
    assert.strictEqual(cfg.qaScope.smallDiffLines, 60);
    assert.ok(cfg._meta.warnings.some((w) => w.includes('invalid qaScope.smallDiffLines')));
  } finally {
    rmDir(set);
    rmDir(never);
    rmDir(bad);
  }
});

test('--get resolves dotted keys', () => {
  const repo = mkFakeRepo({ verify: { test: 'go test ./...' } });
  try {
    const res = runScript(SCRIPT, ['--get', 'verify.test'], { cwd: repo });
    assert.strictEqual(res.stdout.trim(), 'go test ./...');
  } finally {
    rmDir(repo);
  }
});

// Reproduce the versioned cache layout: sibling version dirs, each with its own manifest.
function fakeInstall(runningVersion, otherVersions) {
  const root = mkTmpDir('tl-cache');
  const scriptRel = path.join('skills', 'ticket-loop', 'scripts');
  for (const v of [runningVersion, ...otherVersions]) {
    fs.mkdirSync(path.join(root, v, scriptRel), { recursive: true });
    fs.writeFileSync(path.join(root, v, 'plugin.json'), JSON.stringify({ name: 'ticket-loop', version: v }));
  }
  const script = path.join(root, runningVersion, scriptRel, 'load_config.js');
  fs.copyFileSync(path.join(SCRIPTS_DIR, 'load_config.js'), script);
  const repo = mkFakeRepo({ verify: { test: 'x' } });
  return { root, script, repo };
}

test('a stale skill running beside a newer install is reported', () => {
  const { root, script, repo } = fakeInstall('0.2.0', ['0.8.0']);
  try {
    const cfg = JSON.parse(runScript(script, [], { cwd: repo }).stdout);
    assert.strictEqual(cfg._meta.skillVersion, '0.2.0');
    assert.strictEqual(cfg._meta.newerVersionInstalled, '0.8.0');
    assert.ok(
      cfg._meta.warnings.some((w) => w.includes('0.2.0') && w.includes('0.8.0') && /restart|new session/i.test(w)),
      `expected a loud skew warning, got: ${JSON.stringify(cfg._meta.warnings)}`
    );
  } finally {
    rmDir(root);
    rmDir(repo);
  }
});

test('the newest installed version reports no skew', () => {
  const { root, script, repo } = fakeInstall('0.8.0', ['0.2.0', '0.7.0']);
  try {
    const cfg = JSON.parse(runScript(script, [], { cwd: repo }).stdout);
    assert.strictEqual(cfg._meta.skillVersion, '0.8.0');
    assert.strictEqual(cfg._meta.newerVersionInstalled, null);
    assert.ok(!cfg._meta.warnings.some((w) => /restart|new session/i.test(w)));
  } finally {
    rmDir(root);
    rmDir(repo);
  }
});

test('version ordering is numeric, not lexical', () => {
  const { root, script, repo } = fakeInstall('0.9.0', ['0.10.0']);
  try {
    const cfg = JSON.parse(runScript(script, [], { cwd: repo }).stdout);
    assert.strictEqual(cfg._meta.newerVersionInstalled, '0.10.0', '0.10.0 is newer than 0.9.0');
  } finally {
    rmDir(root);
    rmDir(repo);
  }
});

test('a stray FILE named like a version is not an installed version', () => {
  const { root, script, repo } = fakeInstall('0.8.0', []);
  try {
    fs.writeFileSync(path.join(root, '9.9.9'), '');
    const cfg = JSON.parse(runScript(script, [], { cwd: repo }).stdout);
    assert.strictEqual(cfg._meta.newerVersionInstalled, null);
    assert.ok(!cfg._meta.warnings.some((w) => w.includes('9.9.9')));
  } finally {
    rmDir(root);
    rmDir(repo);
  }
});

test('a repo checkout has no sibling versions and reports no skew', () => {
  const repo = mkFakeRepo({ verify: { test: 'x' } });
  try {
    const cfg = JSON.parse(runScript(path.join(SCRIPTS_DIR, 'load_config.js'), [], { cwd: repo }).stdout);
    assert.strictEqual(cfg._meta.newerVersionInstalled, null);
  } finally {
    rmDir(repo);
  }
});

// --- stop-gate preflight ---
//
// A profile with no hooks.stopGate block wedges a run: the gate blocks every turn-end while one
// is active, and freeze_guard freezes the profile for that window, so the block cannot be added
// without archiving the run.

test('missing hooks.stopGate is a preflight warning naming the wedge', () => {
  const repo = mkFakeRepo({ stack: 'python', verify: { test: 'pytest -q' } });
  try {
    const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: repo }).stdout);
    const hit = cfg._meta.warnings.find((w) => w.includes('hooks.stopGate'));
    assert.ok(hit, `no stopGate warning in ${JSON.stringify(cfg._meta.warnings)}`);
    assert.match(hit, /archiv/i);
  } finally {
    rmDir(repo);
  }
});

test('a usable stopGate block produces no stopGate warning', () => {
  const repo = mkFakeRepo({
    verify: { test: 'pytest -q' },
    hooks: { stopGate: { extensions: ['.py'], mode: 'full' } },
  });
  try {
    const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: repo }).stdout);
    assert.ok(!cfg._meta.warnings.some((w) => w.includes('hooks.stopGate')), cfg._meta.warnings.join('\n'));
  } finally {
    rmDir(repo);
  }
});

// A block that matches nothing is not a configured gate — it is a gate that reports
// "NOTHING was verified" at every turn-end while looking configured.
test('a stopGate block that cannot verify anything warns', () => {
  const cases = [
    [{ extensions: [], mode: 'full' }, /extensions/],
    [{ extensions: ['.py'], mode: 'targeted' }, /testCommand/],
    [{ extensions: ['.py'], mode: 'full', exclude: '([' }, /exclude/],
  ];
  for (const [stopGate, expected] of cases) {
    const repo = mkFakeRepo({ verify: { test: 'pytest -q' }, hooks: { stopGate } });
    try {
      const cfg = JSON.parse(runScript(SCRIPT, [], { cwd: repo }).stdout);
      const hit = cfg._meta.warnings.find((w) => w.includes('hooks.stopGate'));
      assert.ok(hit, `${JSON.stringify(stopGate)} should warn`);
      assert.match(hit, expected);
    } finally {
      rmDir(repo);
    }
  }
});
