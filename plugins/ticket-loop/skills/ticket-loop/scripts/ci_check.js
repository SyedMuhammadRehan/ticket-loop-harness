#!/usr/bin/env node
// The merge check: run in CI on a pull request, from a checkout of its head. It passes only when
// the branch carries a signed bundle from a trusted key that attests this exact head, the run it
// records passed, and the tests pass again here, run by CI itself.
//
// Trust and the commands come from the BASE branch: a pull request cannot add its own key to the
// trust list or swap the test command for one that always passes. When CI holds a signing key
// (TICKET_LOOP_SIGNING_KEY), it countersigns what it ran, so the audit trail carries a claim the
// developer's machine could not have made.
//
// usage: ci_check.js --base <ref> [--ticket <id>] [--bundle <path>] [--out <countersig.json>]
//                    [--no-rerun] [--timeout-ms <n>]
// exit:  0 pass, 1 usage or environment error, 2 the merge must not happen
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyBundle, canonical } = require('./verify_bundle.js');

const TRUST_FILE = '.agents/ticket-loop.trust';
const PROFILE_FILE = '.agents/ticket-loop.config.json';
const ATTESTATIONS_DIR = '.agents/attestations';
const PASSING_VERDICTS = ['APPROVE', 'APPROVE_WITH_COMMENTS'];
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const BRANCH_ENV = ['GITHUB_HEAD_REF', 'CI_MERGE_REQUEST_SOURCE_BRANCH_NAME', 'BITBUCKET_BRANCH', 'CI_COMMIT_REF_NAME'];

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}

function trustedKeys(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
}

function ticketOf(argv, cwd) {
  const given = flag(argv, '--ticket');
  if (given) return given;
  const branch = BRANCH_ENV.map((k) => process.env[k]).find(Boolean) || git(['branch', '--show-current'], cwd).out;
  return branch && branch.startsWith('ticket/') ? branch.slice('ticket/'.length) : null;
}

function runCommand(command, cwd, timeoutMs) {
  const started = Date.now();
  const res = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs });
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  return {
    command,
    exit: timedOut ? null : res.status,
    timedOut: !!timedOut,
    ms: Date.now() - started,
    tail: `${res.stdout || ''}\n${res.stderr || ''}`.trim().split('\n').slice(-20).join('\n'),
  };
}

function check(argv, cwd = process.cwd()) {
  const failures = [];
  const base = flag(argv, '--base');
  if (!base) return { error: '--base <ref> is required: the branch this pull request merges into' };
  if (!git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd).ok) return { error: `base ref ${base} does not resolve; fetch it first` };
  const head = git(['rev-parse', 'HEAD'], cwd).out;

  const ticket = ticketOf(argv, cwd);
  if (!ticket) return { error: 'cannot tell the ticket: pass --ticket, or run on a ticket/<ID> branch' };
  const bundleRel = flag(argv, '--bundle') || `${ATTESTATIONS_DIR}/${ticket}.bundle.json`;

  const trustText = git(['show', `${base}:${TRUST_FILE}`], cwd);
  const trusted = trustText.ok ? trustedKeys(trustText.out) : [];
  if (!trusted.length) failures.push(`${base} carries no trusted keys in ${TRUST_FILE}, so no bundle can be trusted`);

  let bundle = null;
  try {
    bundle = JSON.parse(fs.readFileSync(path.join(cwd, bundleRel), 'utf8'));
  } catch {
    failures.push(`no readable bundle at ${bundleRel}: the run was not attested, or the bundle was not committed`);
  }

  let attestation = null;
  if (bundle) {
    const v = verifyBundle(bundle, trusted);
    attestation = bundle.attestation || {};
    for (const p of v.problems) failures.push(`bundle: ${p}`);
    if (v.valid && !v.trusted) failures.push(`bundle is signed by key ${v.keyId}, which ${base} does not trust`);
    if (attestation.ticket !== ticket) failures.push(`bundle attests ticket ${attestation.ticket}, not ${ticket}`);
    if (!PASSING_VERDICTS.includes(attestation.verdict)) failures.push(`the run's verdict is ${attestation.verdict || 'none'}, not a pass`);
    if (!attestation.integrity || attestation.integrity.intact !== true) {
      failures.push(`the run's own integrity check reported problems: ${((attestation.integrity || {}).problems || []).join('; ') || 'none recorded'}`);
    }
    const attested = attestation.headSha;
    if (!attested) {
      failures.push('the bundle names no head commit');
    } else if (attested !== head) {
      if (!git(['merge-base', '--is-ancestor', attested, head], cwd).ok) {
        failures.push(`the bundle attests ${attested.slice(0, 12)}, which is not in this branch's history`);
      } else {
        const extra = git(['diff', '--name-only', attested, head], cwd).out.split('\n').filter(Boolean);
        const unattested = extra.filter((f) => f !== bundleRel);
        if (unattested.length) {
          failures.push(`commits after the attested head ${attested.slice(0, 12)} change files the run never saw: ${unattested.join(', ')}`);
        }
      }
    }
    if (attestation.baseSha && !git(['merge-base', '--is-ancestor', attestation.baseSha, head], cwd).ok) {
      failures.push(`the run's base ${String(attestation.baseSha).slice(0, 12)} is not in this branch's history`);
    }
  }

  const ran = [];
  if (!argv.includes('--no-rerun')) {
    const profileText = git(['show', `${base}:${PROFILE_FILE}`], cwd);
    let verify = {};
    try {
      verify = JSON.parse(profileText.out).verify || {};
    } catch {
      failures.push(`${base} carries no readable ${PROFILE_FILE}, so CI has no test command it can trust`);
    }
    const timeoutMs = Number(flag(argv, '--timeout-ms')) || DEFAULT_TIMEOUT_MS;
    if (profileText.ok && !verify.test) failures.push(`${base}'s profile names no verify.test`);
    for (const key of ['analyze', 'test']) {
      if (!verify[key]) continue;
      const r = runCommand(verify[key], cwd, timeoutMs);
      ran.push({ step: key, ...r });
      if (r.timedOut) failures.push(`verify.${key} timed out in CI: ${r.command}`);
      else if (r.exit !== 0) failures.push(`verify.${key} failed in CI (exit ${r.exit}): ${r.command}\n${r.tail}`);
    }
  }

  return { ticket, head, base, bundle: bundleRel, attestation, ran, pass: failures.length === 0, failures };
}

// CI's own claim, signed with a key the developer's machine never held.
function countersign(result, keyFile) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  const claim = {
    format: 'ticket-loop-ci/1',
    ticket: result.ticket,
    headSha: result.head,
    base: result.base,
    attestationDigest: result.attestation ? crypto.createHash('sha256').update(canonical(result.attestation)).digest('hex') : null,
    pass: result.pass,
    ran: result.ran.map(({ step, command, exit, timedOut, ms }) => ({ step, command, exit, timedOut, ms })),
    ranAt: new Date().toISOString(),
    keyId: crypto.createHash('sha256').update(der).digest('hex').slice(0, 32),
  };
  return { claim, signature: crypto.sign(null, Buffer.from(canonical(claim), 'utf8'), privateKey).toString('base64'), publicKey };
}

function main() {
  const argv = process.argv.slice(2);
  const result = check(argv);
  if (result.error) {
    console.error(`ci_check: ${result.error}`);
    process.exit(1);
  }
  const out = flag(argv, '--out');
  const keyFile = process.env.TICKET_LOOP_SIGNING_KEY;
  if (out && keyFile) fs.writeFileSync(out, JSON.stringify(countersign(result, keyFile), null, 2) + '\n');
  console.log(`ci_check: ticket ${result.ticket} at ${result.head.slice(0, 12)} against ${result.base}: ${result.pass ? 'PASS' : 'FAIL'}`);
  for (const r of result.ran) console.log(`  ran verify.${r.step}: ${r.command} -> ${r.timedOut ? 'timed out' : `exit ${r.exit}`} (${r.ms} ms)`);
  for (const f of result.failures) console.log(`  - ${f}`);
  if (out && !keyFile) console.log('  (no TICKET_LOOP_SIGNING_KEY in this job, so nothing was countersigned)');
  process.exit(result.pass ? 0 : 2);
}

if (require.main === module) main();
module.exports = { check, countersign, trustedKeys, TRUST_FILE, ATTESTATIONS_DIR };
