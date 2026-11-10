'use strict';
// The invariant under test: a profile command is spawned without a shell, and the one place a
// shell is used — launching a .cmd or .bat on Windows — never carries a character cmd.exe would
// interpret. The substituted arguments can be tool input.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HOOKS_DIR, mkTmpDir, rmDir } = require('./helpers.js');
const lib = require(path.join(HOOKS_DIR, 'hook_lib.js'));

const WINDOWS = process.platform === 'win32';

test('a template expands to argv with each substitution as its own argument', () => {
  assert.deepStrictEqual(lib.buildArgv('npx eslint {file}', { '{file}': 'a b.js' }), ['npx', 'eslint', 'a b.js']);
  assert.deepStrictEqual(lib.buildArgv('pytest {targets} -q', { '{targets}': ['t1.py', 't2.py'] }), ['pytest', 't1.py', 't2.py', '-q']);
  assert.deepStrictEqual(lib.buildArgv('lint x{file}', { '{file}': 'a.js' }), ['lint', 'x{file}'], 'a placeholder is a whole word or it is text');
});

test('a command that does not exist reports an error and runs nothing through a shell', () => {
  const marker = path.join(mkTmpDir('tl-argv'), 'ran.txt');
  try {
    const res = lib.runArgv(['tl-no-such-program-91c', `x & echo ran > ${marker}`]);
    assert.ok(res.error, 'no such program');
    assert.ok(!fs.existsSync(marker), 'the argument was never handed to a shell to interpret');
    if (WINDOWS) assert.match(res.error.message, /refusing win32 shell fallback: unsafe characters/);
  } finally {
    rmDir(path.dirname(marker));
  }
});

test('on Windows a .cmd launcher runs through the shell fallback with its arguments intact', { skip: !WINDOWS }, () => {
  const dir = mkTmpDir('tl-cmd');
  try {
    const tool = path.join(dir, 'tool.cmd');
    fs.writeFileSync(tool, '@echo off\r\necho got:%~1:%~2\r\n');
    const res = lib.runArgv([tool, 'one', 'two words'], { cwd: dir });
    assert.strictEqual(res.status, 0, res.stderr || (res.error && res.error.message));
    assert.match(res.stdout, /got:one:two words/);

    for (const unsafe of ['a&b', 'a|b', 'a>b', '%PATH%', 'a^b', 'a"b']) {
      const refused = lib.runArgv([tool, unsafe], { cwd: dir });
      assert.ok(refused.error, unsafe);
      assert.match(refused.error.message, /refusing win32 shell fallback/, unsafe);
    }
  } finally {
    rmDir(dir);
  }
});
