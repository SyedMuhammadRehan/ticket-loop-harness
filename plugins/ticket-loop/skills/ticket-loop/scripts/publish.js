#!/usr/bin/env node
// Publish a finished run: push the ticket branch, open the PR/MR, update the ticket. The only way
// the loop publishes anything, and only when three things hold: the repo's profile allows the
// act, the person said yes to it at the start of this run, and the run's own sealed record says
// the work passed. It never merges, never force-pushes, and never pushes anything but the
// ticket branch.
//
// It runs after `ledger.js close`, so the record it checks can no longer change. What it does is
// its own evidence on the remote; a local log of each act is written to <runDir>/published.json.
//
// usage: publish.js <runDir> --worktree <wt> --act push|pr|ticket [--base <branch>] [--ticket-id <id>] [--platform github|gitlab]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const chain = require('./chain.js');
const ledger = require('./ledger.js');
const { remoteOf, titleOf, body } = require('./handoff.js');

const PASSING = ['APPROVE', 'APPROVE_WITH_COMMENTS'];
// For tests and wrapped CLIs: a JSON array that replaces `gh` or `glab`, e.g. ["node","fake.js"].
const CLI_OVERRIDE = 'TICKET_LOOP_PUBLISH_CLI';

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}

function git(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 120000 });
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

function cli(name, args, opts = {}) {
  let argv = [name, ...args];
  if (process.env[CLI_OVERRIDE]) argv = [...JSON.parse(process.env[CLI_OVERRIDE]), ...args];
  const res = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120000, ...opts });
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || res.error?.message || '').trim() };
}

function criterionIds(runDir) {
  const ids = new Set();
  for (const name of ['done.approved.md', 'done-additions.md']) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(runDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^- \[[ xX]\] (C\d+)\b/gm)) ids.add(m[1]);
  }
  return [...ids];
}

// Why this run may not be published, from its sealed record alone. Empty means it may.
function readinessProblems(runDir) {
  const problems = [];
  if (!fs.existsSync(ledger.closedPath(runDir))) problems.push('the run is not closed; publish only a finished run');
  const integrity = ledger.integrityReport(runDir);
  if (!integrity.intact) problems.push(`the run's integrity check reports ${integrity.problems.length} problem(s): ${integrity.problems.join('; ')}`);
  const c = integrity.counters || ledger.counters(runDir);
  if (!PASSING.includes(c.verdict)) problems.push(`the QA verdict is ${c.verdict || 'none'}, not a pass`);
  const checks = chain.ofKind(runDir, 'check');
  const ids = criterionIds(runDir);
  if (!ids.length) problems.push('no frozen criteria found');
  for (const id of ids) {
    const last = checks.filter((r) => r.payload.id === id).pop();
    if (!last) problems.push(`${id} has no recorded result`);
    else if (last.payload.result !== 'PASS') problems.push(`${id} last recorded ${last.payload.result}`);
    else if (!['command', 'observed', 'human'].includes(last.payload.by)) problems.push(`${id} passed only by ${last.payload.by}`);
  }
  return problems;
}

function consented(runDir, act) {
  const record = chain.last(runDir, 'consent');
  return !!(record && record.payload.acts && record.payload.acts[act]);
}

function logAct(runDir, entry) {
  const file = path.join(runDir, 'published.json');
  let log = [];
  try {
    log = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    log = [];
  }
  fs.writeFileSync(file, JSON.stringify([...log, { ...entry, at: new Date().toISOString() }], null, 2) + '\n');
}

function publish(argv, cwd = process.cwd()) {
  const runDir = argv.find((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  const wt = flag(argv, '--worktree');
  const act = flag(argv, '--act');
  if (!runDir || !wt || !ledger.PUBLISH_ACTS.includes(act)) {
    return { error: 'usage: publish.js <runDir> --worktree <wt> --act push|pr|ticket [--base <branch>] [--ticket-id <id>]' };
  }
  const absRun = path.resolve(cwd, runDir);
  const ticket = path.basename(absRun);
  const branch = `ticket/${ticket}`;
  const refuse = (why) => ({ refused: true, act, why });

  if (!ledger.publishAllowed().includes(act)) return refuse(`the profile does not allow "${act}" (publish.allowed)`);
  if (!consented(absRun, act)) return refuse(`the person did not say yes to "${act}" for this run`);
  const problems = readinessProblems(absRun);
  if (problems.length) return refuse(problems.join('\n  - '));
  const current = git(wt, ['branch', '--show-current']).out;
  if (current !== branch) return refuse(`the worktree is on "${current || 'a detached head'}", not ${branch}`);
  if (git(wt, ['status', '--porcelain']).out) return refuse('the worktree has uncommitted changes; publish only what was committed');

  const cfg = ledger.readConfig();
  const base = flag(argv, '--base') || ((cfg.hooks || {}).stopGate || {}).baseRef;
  const detected = remoteOf(git(wt, ['remote', 'get-url', 'origin']).out);
  // A self-hosted GitHub or GitLab on a company domain says nothing about itself in its URL.
  const remote = { ...detected, platform: flag(argv, '--platform') || (cfg.publish || {}).platform || detected.platform };
  const head = git(wt, ['rev-parse', 'HEAD']).out;

  if (act === 'push') {
    const res = git(wt, ['push', '-u', 'origin', `${branch}:refs/heads/${branch}`]);
    if (!res.ok) return { error: `git push failed: ${res.err}` };
    logAct(absRun, { act, branch, head });
    return { done: true, act, branch, head };
  }

  const pushed = git(wt, ['ls-remote', '--heads', 'origin', branch]).out;
  if (!pushed) return refuse(`${branch} is not on the remote; push it first`);

  if (act === 'pr') {
    if (!base) return refuse('cannot tell the base branch: pass --base or set hooks.stopGate.baseRef');
    const title = titleOf(ticket, readOr(path.join(absRun, 'ticket-brief.md')));
    const bodyFile = path.join(absRun, 'pr-body.md');
    let bundle = null;
    const bundleRel = `.agents/attestations/${ticket}.bundle.json`;
    try {
      bundle = JSON.parse(fs.readFileSync(path.join(wt, bundleRel), 'utf8'));
    } catch {
      bundle = null;
    }
    fs.writeFileSync(bodyFile, body(ticket, readOr(path.join(absRun, 'report.md')), bundle, bundleRel));
    let res;
    if (remote.platform === 'github') res = cli('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile], { cwd: wt });
    else if (remote.platform === 'gitlab') res = cli('glab', ['mr', 'create', '--source-branch', branch, '--target-branch', base, '--title', title, '--description', fs.readFileSync(bodyFile, 'utf8'), '--yes'], { cwd: wt });
    else {
      return refuse(`opening a PR on ${remote.platform} has no command this plugin can run; open https://${remote.host}/${remote.project} and use ${bodyFile}`);
    }
    if (!res.ok) return { error: `opening the ${remote.platform === 'gitlab' ? 'MR' : 'PR'} failed: ${res.err}` };
    logAct(absRun, { act, platform: remote.platform, base, url: res.out.split('\n').pop() });
    return { done: true, act, url: res.out.split('\n').pop() };
  }

  const ticketId = flag(argv, '--ticket-id');
  const source = cfg.ticketSource;
  const note = `ticket-loop finished ${ticket}: ${ledger.counters(absRun).verdict}, branch ${branch} is ready for review.`;
  if (source === 'github' || source === 'gitlab') {
    if (!ticketId) return refuse('pass --ticket-id <issue number>');
    const res = source === 'github' ? cli('gh', ['issue', 'comment', ticketId, '--body', note], { cwd: wt }) : cli('glab', ['issue', 'note', ticketId, '--message', note], { cwd: wt });
    if (!res.ok) return { error: `updating the issue failed: ${res.err}` };
    logAct(absRun, { act, source, ticketId });
    return { done: true, act, ticketId };
  }
  if (source === 'jira' || source === 'trello') {
    logAct(absRun, { act, source, ticketId: ticketId || null, via: 'mcp' });
    return { done: true, act, mcp: true, note: `consent and readiness hold; comment "${note}" and move the ticket to review through the ${source} MCP` };
  }
  return refuse(`ticketSource is ${source}; there is no ticket to update`);
}

function readOr(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function main() {
  const r = publish(process.argv.slice(2));
  if (r.error) {
    console.error(`publish: ${r.error}`);
    process.exit(1);
  }
  if (r.refused) {
    console.error(`publish: refused to ${r.act}:\n  - ${r.why}`);
    process.exit(2);
  }
  console.log(`publish: ${r.act} done${r.url ? ` — ${r.url}` : ''}${r.note ? `\n  ${r.note}` : ''}`);
}

if (require.main === module) main();
module.exports = { publish, readinessProblems };
