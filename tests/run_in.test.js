'use strict';
// The invariant under test: a check command runs with the worktree as its working directory,
// whatever directory the caller is in, and its exit code is the script's exit code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');

const RUN_IN = path.join(SCRIPTS_DIR, 'run_in.js');
const { commandLine } = require(RUN_IN);

test('a command runs inside the given directory and its exit code comes back', () => {
  const wt = mkTmpDir('tl-wt');
  const elsewhere = mkTmpDir('tl-main');
  try {
    fs.writeFileSync(path.join(wt, 'marker.txt'), 'here\n');
    const probe = path.join(wt, 'probe.js');
    fs.writeFileSync(probe, "const fs=require('fs');process.stdout.write(fs.existsSync('marker.txt')?'IN-WORKTREE':'ELSEWHERE');process.exit(Number(process.argv[2]||0));\n");
    const ok = runScript(RUN_IN, [wt, 'node', 'probe.js'], { cwd: elsewhere });
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.strictEqual(ok.stdout, 'IN-WORKTREE');
    const failing = runScript(RUN_IN, [wt, 'node', 'probe.js', '3'], { cwd: elsewhere });
    assert.strictEqual(failing.status, 3, 'the check failing is the script failing');
  } finally {
    rmDir(wt);
    rmDir(elsewhere);
  }
});

test('a missing directory or command is a usage error, never a silent pass', () => {
  const here = mkTmpDir('tl-here');
  try {
    assert.strictEqual(runScript(RUN_IN, [path.join(here, 'nope'), 'node', '-e', '0'], { cwd: here }).status, 2);
    assert.strictEqual(runScript(RUN_IN, [here], { cwd: here }).status, 2);
  } finally {
    rmDir(here);
  }
});

// A profile command such as "dart format . && dart analyze" is one string; quoting it as one word
// would ask the shell for a program by that whole name.
test('one command word is the profile\'s command string and reaches the shell as written', () => {
  const wt = mkTmpDir('tl-wt');
  try {
    fs.writeFileSync(path.join(wt, 'a.js'), "require('fs').writeFileSync('A', '1');\n");
    fs.writeFileSync(path.join(wt, 'b.js'), "require('fs').writeFileSync('B', '1'); process.exit(4);\n");
    const res = runScript(RUN_IN, [wt, 'node a.js && node b.js'], { cwd: wt });
    assert.strictEqual(res.status, 4, res.stderr);
    assert.ok(fs.existsSync(path.join(wt, 'A')) && fs.existsSync(path.join(wt, 'B')), 'both halves of && ran');
    assert.strictEqual(commandLine(['a && b']), 'a && b');
  } finally {
    rmDir(wt);
  }
});

// Each word must arrive as the one argument it was, metacharacters and quotes included, on the
// shell this platform actually uses.
test('several command words each reach the program as exactly one argument', () => {
  const wt = mkTmpDir('tl-wt');
  try {
    fs.writeFileSync(path.join(wt, 'echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const words = ['say "hi & echo PWNED', "it's $HOME", 'trailing\\', 'plain'];
    const res = runScript(RUN_IN, [wt, 'node', 'echo.js', ...words], { cwd: wt });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(JSON.parse(res.stdout), words);
    assert.strictEqual(commandLine(['node', 'a b'], 'win32'), 'node "a b"');
    assert.strictEqual(commandLine(['node', 'say "hi'], 'win32'), 'node "say ""hi"');
    assert.strictEqual(commandLine(['node', "it's"], 'linux'), "node 'it'\\''s'");
  } finally {
    rmDir(wt);
  }
});
