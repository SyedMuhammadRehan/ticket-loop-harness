'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR, mkFakeRepo, rmDir, runScript } = require('./helpers.js');

const SCRIPT = path.join(HOOKS_DIR, 'post_edit.js');
const { shouldProcess, findBlockingLines } = require(SCRIPT);
const { buildArgv } = require(path.join(HOOKS_DIR, 'hook_lib.js'));

const DART_CONF = {
  extensions: ['.dart'],
  exclude: '\\.(g|freezed)\\.dart$',
};

test('shouldProcess: extension allow-list and exclude regex', () => {
  assert.strictEqual(shouldProcess('lib/main.dart', DART_CONF), true);
  assert.strictEqual(shouldProcess('lib\\win\\main.dart', DART_CONF), true);
  assert.strictEqual(shouldProcess('lib/model.g.dart', DART_CONF), false);
  assert.strictEqual(shouldProcess('lib/model.freezed.dart', DART_CONF), false);
  assert.strictEqual(shouldProcess('src/app.py', DART_CONF), false);
  assert.strictEqual(shouldProcess('', DART_CONF), false);
});

test('shouldProcess: invalid exclude regex fails open', () => {
  assert.strictEqual(shouldProcess('lib/a.dart', { extensions: ['.dart'], exclude: '([' }), true);
});

test('findBlockingLines: with a regex only matching lines block', () => {
  const out = 'info - prefer const\nerror - missing_return at lib/a.dart:3\n';
  const lines = findBlockingLines(out, '\\berror\\b\\s*[-•]');
  assert.deepStrictEqual(lines, ['error - missing_return at lib/a.dart:3']);
  assert.deepStrictEqual(findBlockingLines('info - only warnings\n', '\\berror\\b\\s*[-•]'), []);
});

test('findBlockingLines: without a regex the caller blocks on any failure', () => {
  assert.strictEqual(findBlockingLines('whatever', undefined), null);
});

test('buildArgv substitutes placeholders as whole argv tokens', () => {
  assert.deepStrictEqual(
    buildArgv('dart analyze {file}', { '{file}': 'lib/my app/a.dart' }),
    ['dart', 'analyze', 'lib/my app/a.dart'] // one token, spaces preserved — no shell splitting
  );
  assert.deepStrictEqual(
    buildArgv('flutter test {targets} --reporter compact', { '{targets}': ['test/a_test.dart', 'test/b_test.dart'] }),
    ['flutter', 'test', 'test/a_test.dart', 'test/b_test.dart', '--reporter', 'compact']
  );
});

test('hook is inert without a repo config', () => {
  const repo = mkFakeRepo(); // .git but no config
  try {
    fs.writeFileSync(path.join(repo, 'a.dart'), 'void main() {}\n');
    const res = runScript(SCRIPT, [], {
      cwd: repo,
      input: JSON.stringify({ tool_input: { file_path: path.join(repo, 'a.dart') } }),
    });
    assert.strictEqual(res.status, 0, res.stderr);
  } finally {
    rmDir(repo);
  }
});

test('hook is inert when the config has no hooks.postEdit block', () => {
  const repo = mkFakeRepo({ stack: 'python', verify: { test: 'pytest -q' } });
  try {
    fs.writeFileSync(path.join(repo, 'a.py'), 'x = 1\n');
    const res = runScript(SCRIPT, [], {
      cwd: repo,
      input: JSON.stringify({ tool_input: { file_path: path.join(repo, 'a.py') } }),
    });
    assert.strictEqual(res.status, 0, res.stderr);
  } finally {
    rmDir(repo);
  }
});

test('configured hook runs the profile command (node as a stand-in toolchain)', () => {
  const repo = mkFakeRepo({
    hooks: {
      postEdit: {
        extensions: ['.txt'],
        analyze: 'node -e process.exit(0) {file}',
      },
    },
  });
  try {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    const ok = runScript(SCRIPT, [], {
      cwd: repo,
      input: JSON.stringify({ tool_input: { file_path: path.join(repo, 'a.txt') } }),
    });
    assert.strictEqual(ok.status, 0, ok.stderr);
  } finally {
    rmDir(repo);
  }
});

test('configured hook blocks (exit 2) when analyze fails and no errorRegex is set', () => {
  const repo = mkFakeRepo({
    hooks: {
      postEdit: {
        extensions: ['.txt'],
        analyze: 'node -e console.error("lint");process.exit(1) {file}',
      },
    },
  });
  try {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    const res = runScript(SCRIPT, [], {
      cwd: repo,
      input: JSON.stringify({ tool_input: { file_path: path.join(repo, 'a.txt') } }),
    });
    assert.strictEqual(res.status, 2);
    assert.ok(res.stderr.includes('analyze failed'));
  } finally {
    rmDir(repo);
  }
});
