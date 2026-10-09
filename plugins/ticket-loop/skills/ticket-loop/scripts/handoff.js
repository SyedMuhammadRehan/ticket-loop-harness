#!/usr/bin/env node
// Prepare the pull request for a closed run: write its description from the run's own report and
// attestation, and print the commands that open it on the team's platform. It pushes nothing and
// opens nothing — publishing is the human's decision, and the guard refuses it during a run.
//
// usage: handoff.js <runDir> --worktree <wt> --out <body.md> [--base <branch>]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_BODY_CHARS = 60000;

function git(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15000 });
  return res.status === 0 ? res.stdout.trim() : null;
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// owner/repo and the platform, from either remote URL form.
function remoteOf(url) {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  if (!m) return { platform: 'unknown', host: null, project: null };
  const host = m[1].toLowerCase();
  const platform = /github/.test(host) ? 'github' : /gitlab/.test(host) ? 'gitlab' : /bitbucket/.test(host) ? 'bitbucket' : 'unknown';
  return { platform, host, project: m[2] };
}

function titleOf(ticket, brief) {
  const summary = /\*\*Summary:\*\*\s*(.+)/.exec(brief || '');
  const heading = (brief || '').split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l && !/^ticket brief/i.test(l));
  const text = (summary ? summary[1] : heading || '').replace(/\s+/g, ' ').trim();
  const short = text.length > 72 ? `${text.slice(0, 69).replace(/\s+\S*$/, '')}…` : text;
  return short ? `${ticket}: ${short}` : ticket;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function body(ticket, report, bundle, bundleRel) {
  const parts = [`Opened from ticket-loop run **${ticket}**. Merge and push stay with you.`];
  if (bundle && bundle.attestation) {
    const a = bundle.attestation;
    parts.push(
      [
        '## Attestation',
        '',
        `- Verdict: **${a.verdict || 'none'}**, integrity ${a.integrity && a.integrity.intact ? '**intact**' : '**NOT intact**'}`,
        `- Attested head \`${String(a.headSha || 'unknown').slice(0, 12)}\` on base \`${String(a.baseSha || 'unknown').slice(0, 12)}\`, ${a.records} sealed records`,
        `- Signed by key \`${a.keyId}\`; the bundle is committed at \`${bundleRel}\``,
        `- Check it: \`node verify_bundle.js ${bundleRel} --trust ${a.keyId}\`; the merge check in docs/ci.md does this in CI`,
      ].join('\n')
    );
  } else {
    parts.push('## Attestation\n\nNo signed bundle on this branch, so the merge check will refuse it. Run `ledger.js keygen` and `ledger.js export` to attest the run.');
  }
  parts.push(`## Run report\n\n${(report || 'report.md was not found in the run directory.').trim()}`);
  const text = parts.join('\n\n') + '\n';
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS - 200)}\n\n…the report is cut here to fit the platform's limit; the full report.md is in the run directory.\n`;
}

function commands(remote, branch, base, title, bodyFile) {
  const push = `git push -u origin ${branch}`;
  if (remote.platform === 'github') {
    return [push, `gh pr create --base ${base} --head ${branch} --title ${shellQuote(title)} --body-file ${shellQuote(bodyFile)}`];
  }
  if (remote.platform === 'gitlab') {
    return [push, `glab mr create --source-branch ${branch} --target-branch ${base} --title ${shellQuote(title)} --description "$(cat ${shellQuote(bodyFile)})"`];
  }
  if (remote.platform === 'bitbucket') {
    const url = `https://${remote.host}/${remote.project}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(base)}`;
    return [push, `open ${url} and paste the description from ${bodyFile}`];
  }
  return [push, `open a pull request from ${branch} into ${base} with the description in ${bodyFile}`];
}

function handoff(argv, cwd = process.cwd()) {
  const runDir = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const wt = flag(argv, '--worktree');
  const out = flag(argv, '--out');
  if (!runDir || !wt || !out) return { error: 'usage: handoff.js <runDir> --worktree <wt> --out <body.md> [--base <branch>]' };
  const absRun = path.resolve(cwd, runDir);
  if (!fs.existsSync(path.join(absRun, 'closed.json'))) return { error: `${runDir} is not closed; hand off a finished run` };
  const ticket = path.basename(absRun);
  const branch = `ticket/${ticket}`;
  let base = flag(argv, '--base');
  if (!base) {
    try {
      base = JSON.parse(read(path.join(cwd, '.agents', 'ticket-loop.config.json'))).hooks.stopGate.baseRef;
    } catch {
      base = null;
    }
  }
  if (!base) return { error: 'cannot tell the base branch: pass --base, or set hooks.stopGate.baseRef in the profile' };
  const bundleRel = `.agents/attestations/${ticket}.bundle.json`;
  let bundle = null;
  try {
    bundle = JSON.parse(read(path.join(wt, bundleRel)));
  } catch {
    bundle = null;
  }
  const remote = remoteOf(git(wt, ['remote', 'get-url', 'origin']));
  const title = titleOf(ticket, read(path.join(absRun, 'ticket-brief.md')));
  fs.writeFileSync(out, body(ticket, read(path.join(absRun, 'report.md')), bundle, bundleRel));
  return { ticket, branch, base, title, platform: remote.platform, bodyFile: out, attested: !!bundle, commands: commands(remote, branch, base, title, out) };
}

function main() {
  const result = handoff(process.argv.slice(2));
  if (result.error) {
    console.error(`handoff: ${result.error}`);
    process.exit(1);
  }
  console.log(`handoff: ${result.ticket} -> ${result.platform} pull request into ${result.base}`);
  console.log(`  title: ${result.title}`);
  console.log(`  description written to ${result.bodyFile}${result.attested ? '' : ' (no signed bundle: the merge check will refuse this branch)'}`);
  console.log('  nothing was pushed; when you are ready, run:');
  for (const c of result.commands) console.log(`    ${c}`);
}

if (require.main === module) main();
module.exports = { handoff, remoteOf, titleOf, body };
