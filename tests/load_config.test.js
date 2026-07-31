'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { SCRIPTS_DIR, mkFakeRepo, rmDir, runScript } = require('./helpers.js');

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

test('--get resolves dotted keys', () => {
  const repo = mkFakeRepo({ verify: { test: 'go test ./...' } });
  try {
    const res = runScript(SCRIPT, ['--get', 'verify.test'], { cwd: repo });
    assert.strictEqual(res.stdout.trim(), 'go test ./...');
  } finally {
    rmDir(repo);
  }
});
