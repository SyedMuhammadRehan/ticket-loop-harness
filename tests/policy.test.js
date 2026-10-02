'use strict';
// The invariant under test: an org policy is a floor no profile can lower. It adds risk paths the
// hooks then fence, caps QA's focused read, forces the matching-test rule and the commit trailer,
// stops preflight on a model it does not allow, reports a dispatch on one, and is sealed when a
// run starts so it cannot be relaxed mid-run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, HOOKS_DIR, mkRun, mkTmpDir, rmDir, runScript, settleDispatches } = require('./helpers.js');

const LOAD_CONFIG = path.join(SCRIPTS_DIR, 'load_config.js');
const LEDGER = path.join(SCRIPTS_DIR, 'ledger.js');
const GUARD = path.join(HOOKS_DIR, 'freeze_guard.js');

const ORG = {
  riskPaths: ['**/payments/**'],
  allowedModels: { qa: ['inherit', 'opus'] },
  qaScope: { maxSmallDiffLines: 20 },
  requireMatchingTest: true,
  attribution: { commitTrailer: 'Assisted-by: ticket-loop' },
};

function withPolicy(t, policy) {
  const dir = mkTmpDir('tl-policy');
  t.after(() => rmDir(dir));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, typeof policy === 'string' ? policy : JSON.stringify(policy));
  return { file, env: { TICKET_LOOP_POLICY: file } };
}

const PROFILE = {
  verify: { test: 'x' },
  riskPaths: ['pubspec.yaml'],
  qaScope: { smallDiffLines: 200 },
  models: { qa: 'haiku' },
  hooks: { stopGate: { extensions: ['.py'], mode: 'full', requireMatchingTest: false } },
};

test('the org floor is applied to the profile and a disallowed model stops preflight', (t) => {
  const { env } = withPolicy(t, ORG);
  const { root } = mkRun(PROFILE);
  t.after(() => rmDir(root));
  const cfg = JSON.parse(runScript(LOAD_CONFIG, [], { cwd: root, env }).stdout);
  assert.deepStrictEqual(cfg.riskPaths, ['pubspec.yaml', '**/payments/**']);
  assert.strictEqual(cfg.qaScope.smallDiffLines, 20);
  assert.strictEqual(cfg.hooks.stopGate.requireMatchingTest, true);
  assert.strictEqual(cfg.attribution.commitTrailer, 'Assisted-by: ticket-loop');
  assert.strictEqual(cfg.models.qa, 'haiku', 'a violation is reported, never silently repaired');
  assert.ok(cfg._meta.warnings.some((w) => /^POLICY: models\.qa is "haiku" but the org policy allows only inherit, opus/.test(w)), cfg._meta.warnings.join('\n'));
  assert.ok(cfg._meta.policy && cfg._meta.policy.sha256, 'the policy in force is named');
});

test('an unreadable policy is a violation, not the absence of one', (t) => {
  const { env } = withPolicy(t, '{ not json');
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  t.after(() => rmDir(root));
  const cfg = JSON.parse(runScript(LOAD_CONFIG, [], { cwd: root, env }).stdout);
  assert.ok(cfg._meta.warnings.some((w) => /^POLICY: the org policy at .* could not be read/.test(w)), cfg._meta.warnings.join('\n'));
  const init = runScript(LEDGER, ['init', runDir, 'abc'], { cwd: root, env });
  assert.strictEqual(init.status, 1, 'no run starts under a policy nobody can read');
  assert.match(init.stderr, /could not be read/);
});

test('a risk path only the org policy names is fenced by the hooks during a run', (t) => {
  const { env } = withPolicy(t, ORG);
  const { root, runDir } = mkRun(PROFILE);
  t.after(() => rmDir(root));
  fs.writeFileSync(path.join(runDir, 'budget.json'), '{}');
  const res = runScript(GUARD, [], { cwd: root, env, input: JSON.stringify({ cwd: root, tool_input: { file_path: 'src/payments/charge.py' } }) });
  assert.strictEqual(res.status, 2, res.stderr);
  assert.match(res.stderr, /risk-tier path/);
  const without = runScript(GUARD, [], { cwd: root, input: JSON.stringify({ cwd: root, tool_input: { file_path: 'src/payments/charge.py' } }) });
  assert.strictEqual(without.status, 0, 'the profile alone does not fence it');
});

test('a dispatch on a model the org policy does not allow is reported by verify', (t) => {
  const { env } = withPolicy(t, ORG);
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  t.after(() => rmDir(root));
  const ledger = (args) => runScript(LEDGER, args, { cwd: root, env });
  assert.strictEqual(ledger(['init', runDir, 'abc']).status, 0);
  ledger(['dispatch', runDir, 'qa: contract [full]']);
  ledger(['dispatch', runDir, 'qa: contract [full]', '--source', 'hook', '--model', 'haiku']);
  settleDispatches(root, runDir);
  const report = JSON.parse(ledger(['verify', runDir]).stdout);
  assert.ok(report.problems.some((p) => /\(qa\) ran on haiku but the org policy allows only inherit, opus/.test(p)), report.problems.join('\n'));
});

test('the policy is sealed when a run starts, so relaxing it mid-run is TAMPERED', (t) => {
  const { file, env } = withPolicy(t, ORG);
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  t.after(() => rmDir(root));
  const ledger = (args) => runScript(LEDGER, args, { cwd: root, env });
  assert.strictEqual(ledger(['init', runDir, 'abc']).status, 0);
  fs.writeFileSync(file, JSON.stringify({ ...ORG, allowedModels: {} }));
  const report = JSON.parse(ledger(['verify', runDir]).stdout);
  assert.ok(report.problems.some((p) => p.includes('TAMPERED') && p.includes('policy.json')), report.problems.join('\n'));
});

test('without a policy nothing changes', (t) => {
  const { root } = mkRun(PROFILE);
  t.after(() => rmDir(root));
  const cfg = JSON.parse(runScript(LOAD_CONFIG, [], { cwd: root }).stdout);
  assert.deepStrictEqual(cfg.riskPaths, ['pubspec.yaml']);
  assert.strictEqual(cfg.qaScope.smallDiffLines, 200);
  assert.strictEqual(cfg._meta.policy, null);
  assert.ok(!cfg._meta.warnings.some((w) => w.startsWith('POLICY')));
});
