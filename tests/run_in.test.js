'use strict';
// The invariant under test: a check command runs with the worktree as its working directory,
// whatever directory the caller is in, and its exit code is the script's exit code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkTmpDir, rmDir, runScript } = require('./helpers.js');

const RUN_IN = path.join(SCRIPTS_DIR, 'run_in.js');

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
