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
  for (const w of cfg._meta.warnings || []) add(/STALE SKILL|invalid|stopGate|^POLICY/i.test(w) ? 'problem' : 'note', w, null);
  return cfg;
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
    if (report.findings.length === 0) console.log('  ok: nothing to report');
    for (const f of report.findings) console.log(`  ${f.level}: ${f.what}${f.fix ? `\n      fix: ${f.fix}` : ''}`);
  }
  process.exit(problems ? 1 : 0);
}

if (require.main === module) main();
module.exports = { diagnose };
