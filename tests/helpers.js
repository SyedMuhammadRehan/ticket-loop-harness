'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'plugins', 'ticket-loop', 'skills', 'ticket-loop', 'scripts');
const HOOKS_DIR = path.join(REPO_ROOT, 'plugins', 'ticket-loop', 'hooks');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Run a harness script as a child process, the way the skill/hooks invoke it.
function runScript(scriptPath, args = [], opts = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    input: opts.input,
    timeout: 30000,
  });
}

// Create a fake repo root (a `.git` dir is all the resolvers look for), optionally
// with a ticket-loop config.
function mkFakeRepo(config) {
  const dir = mkTmpDir('tl-repo');
  fs.mkdirSync(path.join(dir, '.git'));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agents', 'ticket-loop.config.json'),
      typeof config === 'string' ? config : JSON.stringify(config, null, 2)
    );
  }
  return dir;
}

module.exports = { REPO_ROOT, SCRIPTS_DIR, HOOKS_DIR, mkTmpDir, rmDir, runScript, mkFakeRepo };
