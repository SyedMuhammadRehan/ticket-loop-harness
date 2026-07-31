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
//
// CLAUDE_PLUGIN_ROOT is scrubbed unless a test sets it deliberately. When the suite runs from
// inside Claude Code (a Stop hook, say) that variable points at the INSTALLED plugin, and
// dispatch_guard prefers it when locating ledger.js — so without this the tests silently
// exercise whatever version happens to be installed instead of the code under test. That is
// how a green suite hid a real regression once already.
function runScript(scriptPath, args = [], opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  if (!opts.env || !('CLAUDE_PLUGIN_ROOT' in opts.env)) delete env.CLAUDE_PLUGIN_ROOT;
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    input: opts.input,
    env,
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

// A fake repo plus a run dir inside it, which is what the receipt chain needs: the chain
// resolves to <root>/.git/ticket-loop/<TICKET>/, i.e. OUTSIDE the run dir.
function mkRun(config) {
  const root = mkFakeRepo(config);
  const runDir = path.join(root, '.agents', 'ticket-runs', 'T-1');
  fs.mkdirSync(runDir, { recursive: true });
  return { root, runDir };
}

// Scripts resolve the profile from cwd, so tests must run them from the fake repo root.
function ledger(root, args) {
  return runScript(path.join(SCRIPTS_DIR, 'ledger.js'), args, { cwd: root });
}

function chainDirFor(root, ticket = 'T-1') {
  return path.join(root, '.git', 'ticket-loop', ticket);
}

module.exports = {
  REPO_ROOT,
  SCRIPTS_DIR,
  HOOKS_DIR,
  mkTmpDir,
  rmDir,
  runScript,
  mkFakeRepo,
  mkRun,
  ledger,
  chainDirFor,
};
