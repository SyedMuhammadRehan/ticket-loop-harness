#!/usr/bin/env node
// Read-only health check of a repo's ticket-loop setup: what is wrong, and the fix for each.
// It never writes. Exit 1 when there is a problem, 0 when there are only notes or nothing.
//
// usage: doctor.js [--json]      run from anywhere inside the repo
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LEDGER = path.join(__dirname, 'ledger.js');
const LOAD_CONFIG = path.join(__dirname, 'load_config.js');
// The hooks ship beside the skill in the plugin layout; a hand-copied skill has no hooks next to it.
const HOOK_LIB = path.join(__dirname, '..', '..', '..', 'hooks', 'hook_lib.js');
const TIMEOUT_MS = 20000;

function git(root, args) {
  const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: TIMEOUT_MS });
  return res.status === 0 ? res.stdout : null;
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function profileFindings(root, add) {
  const res = spawnSync(process.execPath, [LOAD_CONFIG], { encoding: 'utf8', cwd: root, timeout: TIMEOUT_MS });
  let cfg;
  try {
    cfg = JSON.parse(res.stdout);
  } catch {
    add('problem', 'the profile could not be resolved', (res.stderr || '').trim() || 'load_config.js printed nothing readable');
    return {};
  }
  if (!cfg._meta.configFound) {
    add('problem', 'no profile at .agents/ticket-loop.config.json', 'run init.js to write one from this repo, then review it');
    return cfg;
  }
  if (!cfg.verify || !cfg.verify.test) add('problem', 'the profile has no verify.test', 'set the command that runs this repo\'s tests');
  const n = cfg._meta.notify;
  if (n && n.error) add('problem', `the notify config cannot be used: ${n.error}`, 'fix ~/.claude/ticket-loop/notify.json; notify.js test sends a test message');
  else if (!n || !n.configured) add('note', 'no notify channel is set, so a run that gets stuck while you are away cannot tell you', 'add one in ~/.claude/ticket-loop/notify.json (see notify.js); notify.js test checks it');
  else if (!n.canReply) add('note', `notify reaches you on ${n.channels.join(', ')} but none of them can carry your answer back`, 'add ntfy, or a Telegram, Slack or Discord bot, to answer from your phone');
  for (const w of cfg._meta.warnings || []) add(/STALE SKILL|invalid|stopGate|^POLICY/i.test(w) ? 'problem' : 'note', w, null);
  return cfg;
}

// The profile is frozen once a run starts, so a command that cannot start costs the whole run.
// Only the program is looked up, never run: the profile is repo-owned and doctor executes nothing
// from it. A builtin or an interpreter-relative path is not something PATH can answer for.
const VERIFY_KEYS = ['test', 'analyze', 'pubGet', 'codegen'];
const SHELL_BUILTINS = new Set(['cd', 'pushd', 'set', 'export', 'echo', 'exit', 'true', 'false', 'call', 'if', 'for', 'source', '.', 'test', '[']);
const STORE_ALIAS = /[\\/]WindowsApps[\\/]python3?(\.exe)?$/i;

function programsOf(command) {
  return command
    .split(/&&|\|\||[;|]/)
    .map((seg) => seg.trim().split(/\s+/).filter((t) => !/^\w+=/.test(t))[0])
    .filter(Boolean)
    .map((t) => t.replace(/^["']|["']$/g, ''));
}

function onPath(program) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, program + ext);
      // An app execution alias is a reparse point that lstat reads but stat may not.
      const st = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (st && !st.isDirectory()) return candidate;
    }
  }
  return null;
}

// The Microsoft Store alias answers to `python` and exits non-zero without running anything.
function isStoreStub(file) {
  if (!STORE_ALIAS.test(file)) return false;
  return spawnSync(file, ['--version'], { timeout: 5000, windowsHide: true }).status !== 0;
}

function commandFindings(root, cfg, add) {
  for (const key of VERIFY_KEYS) {
    const command = cfg.verify && cfg.verify[key];
    if (typeof command !== 'string' || !command.trim()) continue;
    for (const program of programsOf(command)) {
      if (SHELL_BUILTINS.has(program.toLowerCase())) continue;
      if (/[\\/]/.test(program)) {
        if (!fs.existsSync(path.resolve(root, program))) add('problem', `verify.${key} runs ${program}, which does not exist`, 'fix the path in the profile before the first run');
        continue;
      }
      const found = onPath(program);
      if (!found) add('problem', `verify.${key} runs ${program}, which is not on PATH`, `install it, or change verify.${key} to a command this machine has; the profile is frozen once a run starts`);
      else if (isStoreStub(found)) add('problem', `verify.${key} runs ${program}, which here is the Microsoft Store stub, not Python`, 'install Python, or use the py launcher (py -m ...) in the profile');
    }
  }
}

// `npm ci` exits non-zero without a lockfile, and the install runs at the start of every run.
function installFindings(root, cfg, add) {
  const install = cfg.verify && cfg.verify.pubGet;
  if (typeof install !== 'string' || !/\bnpm\s+ci\b/.test(install)) return;
  if (['package-lock.json', 'npm-shrinkwrap.json'].some((f) => fs.existsSync(path.join(root, f)))) return;
  add('problem', 'verify.pubGet is npm ci, but the repo has no package-lock.json for it to install from', 'commit a lockfile (npm install writes one), or set verify.pubGet to npm install');
}

// A run reads the main checkout's profile, so an uncommitted one works here. The merge check
// reads the base branch's.
function committedFindings(root, cfg, add) {
  const base = (cfg.hooks && cfg.hooks.stopGate && cfg.hooks.stopGate.baseRef) || null;
  if (!base || git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) === null) return;
  if (git(root, ['cat-file', '-e', `${base}:.agents/ticket-loop.config.json`]) !== null) return;
  add('note', `the profile is not committed on ${base}, so teammates and the CI merge check do not have it`, `commit .agents/ticket-loop.config.json and the .gitignore change to ${base}`);
}

function gitignoreFindings(root, add) {
  for (const probe of ['.agents/ticket-runs/probe', '.claude/hooks/state/probe']) {
    const res = spawnSync('git', ['-C', root, 'check-ignore', '-q', probe], { timeout: TIMEOUT_MS });
    if (res.status !== 0) {
      add('problem', `${path.posix.dirname(probe)}/ is not gitignored`, `add "${path.posix.dirname(probe)}/" to .gitignore so run state never shows up as a change`);
    }
  }
}

function runFindings(root, lib, cfg, add) {
  const staleHours = Number.isInteger(cfg.staleRunHours) ? cfg.staleRunHours : 24;
  const open = [];
  for (const runDir of lib.activeRuns(root)) {
    const name = path.basename(runDir);
    open.push(name);
    const res = spawnSync(process.execPath, [LEDGER, 'status', runDir], { encoding: 'utf8', cwd: root, timeout: TIMEOUT_MS });
    let status = null;
    try {
      status = JSON.parse(res.stdout);
    } catch {
      add('problem', `run ${name} is open but its record cannot be read`, (res.stderr || '').trim().split('\n')[0] || null);
      continue;
    }
    const idleH = status.idleMinutes == null ? null : Math.round(status.idleMinutes / 60);
    const fix = `resume with /ticket-loop ${name}, or end it: node ${LEDGER} archive ${path.relative(root, runDir).replace(/\\/g, '/')}`;
    if (idleH != null && idleH >= staleHours) {
      add('problem', `run ${name} has been open and idle for ${idleH} h; it arms every gate in this repo`, fix);
    } else {
      add('note', `run ${name} is open (last activity ${idleH == null ? 'unknown' : `${idleH} h`} ago)`, fix);
    }
    if ((status.open || []).length) add('note', `run ${name} has ${status.open.length} dispatch(es) with no outcome`, 'ledger.js outcome <runDir> <seq> ok|died');
  }
  return open;
}

function worktreeFindings(root, cfg, openRuns, add) {
  const porcelain = git(root, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return;
  const base = (cfg.hooks && cfg.hooks.stopGate && cfg.hooks.stopGate.baseRef) || null;
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const wt = (/^worktree (.+)$/m.exec(block) || [])[1];
    const branch = (/^branch refs\/heads\/(ticket\/.+)$/m.exec(block) || [])[1];
    if (!wt || !branch) continue;
    const ticket = branch.slice('ticket/'.length);
    if (openRuns.includes(ticket)) continue;
    const dirty = (git(wt, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length;
    const merged = base && spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', branch, base], { timeout: TIMEOUT_MS }).status === 0;
    const state = [merged ? `merged into ${base}` : 'not merged', dirty ? `${dirty} uncommitted change(s)` : 'clean'].join(', ');
    add(
      'note',
      `worktree ${wt} (${branch}) has no open run: ${state}`,
      dirty ? 'commit or discard its changes before removing it' : `git worktree remove "${wt}" keeps the branch and its commits`
    );
  }
}

function diagnose(start) {
  const findings = [];
  const add = (level, what, fix) => findings.push({ level, what, fix: fix || null });
  const root = findRoot(start);
  if (!root) {
    add('problem', 'not inside a git repository', 'run doctor.js from the repo the loop works in');
    return { root: null, findings };
  }
  const cfg = profileFindings(root, add);
  if (cfg._meta && cfg._meta.configFound) {
    commandFindings(root, cfg, add);
    installFindings(root, cfg, add);
    committedFindings(root, cfg, add);
  }
  gitignoreFindings(root, add);
  let lib = null;
  try {
    lib = require(HOOK_LIB);
  } catch {
    add('note', 'the plugin hooks are not beside this script, so stale copies and open runs were not checked', 'run the doctor that ships with the installed plugin');
  }
  if (lib) {
    for (const s of lib.staleCopies(root)) add('problem', `stale pre-plugin copy: ${s.where}`, s.fix);
    const open = runFindings(root, lib, cfg, add);
    worktreeFindings(root, cfg, open, add);
  }
  return { root, findings };
}

function main() {
  const json = process.argv.includes('--json');
  const report = diagnose(process.cwd());
  const problems = report.findings.filter((f) => f.level === 'problem').length;
  if (json) {
    process.stdout.write(JSON.stringify({ ...report, problems }, null, 2) + '\n');
  } else {
    console.log(`ticket-loop doctor: ${report.root || process.cwd()}`);
    for (const f of report.findings) console.log(`  ${f.level}: ${f.what}${f.fix ? `\n      fix: ${f.fix}` : ''}`);
    const notes = report.findings.length - problems;
    const tally = `${problems} problem${problems === 1 ? '' : 's'}, ${notes} note${notes === 1 ? '' : 's'}`;
    console.log(problems ? `  NOT ready: ${tally}` : `  ok: ${tally}`);
  }
  process.exit(problems ? 1 : 0);
}

if (require.main === module) main();
module.exports = { diagnose };
