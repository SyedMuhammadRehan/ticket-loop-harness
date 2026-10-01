#!/usr/bin/env node
// Verify an exported run bundle with no secret and nothing but Node: copy this one file to any
// machine. It checks the signature over the attestation, that the records in the bundle are
// exactly the ones the attestation digested, that they form one unbroken sequence, and that the
// verdict the attestation states is the one the records hold. With --trust it also requires the
// signing key to be one you named.
//
// What it cannot check: the HMAC seals inside each record, which need the run's own key. The
// signature stands in for them from the moment of export.
//
// usage: verify_bundle.js <bundle.json> [--trust <keyId>]... [--trust-file <file>]
// exit:  0 valid (and trusted, when trust was asked for), 2 invalid, 3 valid but untrusted
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const FORMAT = 'ticket-loop-attestation/1';

// Must stay byte-identical to chain.js `canonical`; a test holds the two together.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(',')}}`;
}

function digestOf(records) {
  return crypto.createHash('sha256').update(records.map(canonical).join('\n')).digest('hex');
}

function keyIdOf(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
}

function verifyBundle(bundle, trusted = []) {
  const problems = [];
  const a = bundle && bundle.attestation;
  if (!a || typeof bundle.signature !== 'string' || typeof bundle.publicKey !== 'string' || !Array.isArray(bundle.records)) {
    return { valid: false, trusted: false, keyId: null, problems: ['not a ticket-loop bundle: attestation, signature, publicKey and records are required'] };
  }
  if (a.format !== FORMAT) problems.push(`unknown format "${a.format}" (this verifier reads ${FORMAT})`);

  let keyId = null;
  try {
    keyId = keyIdOf(bundle.publicKey);
    const ok = crypto.verify(null, Buffer.from(canonical(a), 'utf8'), bundle.publicKey, Buffer.from(bundle.signature, 'base64'));
    if (!ok) problems.push('the signature does not match the attestation — the attestation was changed after signing, or signed by another key');
  } catch (err) {
    problems.push(`the public key or signature could not be read (${err.message})`);
  }
  if (keyId && a.keyId !== keyId) problems.push(`the attestation names key ${a.keyId} but the bundle carries key ${keyId}`);

  const records = bundle.records;
  if (records.length !== a.records) problems.push(`the bundle holds ${records.length} record(s); the attestation signed ${a.records}`);
  if (digestOf(records) !== a.chainDigest) problems.push('the records are not the ones the attestation digested — a record was added, removed or changed');
  let prev = null;
  records.forEach((r, i) => {
    if (r.seq !== i + 1) problems.push(`record ${i + 1}: seq is ${r.seq}`);
    if ((r.prev || null) !== prev) problems.push(`record ${r.seq}: does not link to the record before it`);
    prev = r.hmac || null;
  });
  if (records.length && records[0].kind !== 'init') problems.push('the first record is not the run\'s init record');
  if ((a.lastSeal || null) !== prev) problems.push('the last record is not the one the attestation names');
  const verdicts = records.filter((r) => r.kind === 'verdict');
  const lastVerdict = verdicts.length ? verdicts[verdicts.length - 1].payload.verdict : null;
  if ((a.verdict || null) !== lastVerdict) problems.push(`the attestation states verdict ${a.verdict} but the records end on ${lastVerdict}`);

  const valid = problems.length === 0;
  return { valid, trusted: valid && trusted.length > 0 && trusted.includes(keyId), keyId, problems };
}

function trustList(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--trust' && argv[i + 1]) out.push(argv[++i].trim());
    else if (argv[i] === '--trust-file' && argv[i + 1]) {
      const text = fs.readFileSync(argv[++i], 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const id = line.replace(/#.*/, '').trim();
        if (id) out.push(id);
      }
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((x, i) => !x.startsWith('--') && !['--trust', '--trust-file'].includes(argv[i - 1]));
  if (!file) {
    console.error('usage: verify_bundle.js <bundle.json> [--trust <keyId>]... [--trust-file <file>]');
    process.exit(1);
  }
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`verify_bundle: ${file} could not be read as JSON (${err.message})`);
    process.exit(2);
  }
  const trusted = trustList(argv);
  const result = verifyBundle(bundle, trusted);
  const a = bundle.attestation || {};
  const summary = { ticket: a.ticket, verdict: a.verdict, baseSha: a.baseSha, headSha: a.headSha, records: a.records, integrity: a.integrity, signedAt: a.signedAt };
  process.stdout.write(JSON.stringify({ ...result, trustRequired: trusted.length > 0, summary }, null, 2) + '\n');
  if (!result.valid) process.exit(2);
  if (trusted.length && !result.trusted) process.exit(3);
  process.exit(0);
}

if (require.main === module) main();
module.exports = { verifyBundle, canonical, digestOf, FORMAT };
