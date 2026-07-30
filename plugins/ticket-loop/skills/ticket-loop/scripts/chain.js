'use strict';
// Hash-chained, HMAC-sealed receipt store for a ticket run (zero deps, node builtins only).
//
// It lives OUTSIDE the run dir — in <gitdir>/ticket-loop/<TICKET>/ — because a record kept
// inside the namespace the orchestrator writes to is not a record. Consequences:
//   - archiving or deleting the run dir does not reset the budget (the chain survives);
//   - a stage receipt cannot be back-dated or invented without the per-run key;
//   - `verify` detects any edit, reorder, or truncation of the history.
//
// Threat model, stated honestly: an agent with shell access CAN read the key and forge a
// chain. What this buys is that forging is a deliberate, multi-step, *detectable* act
// instead of a silent side effect of ordinary file writes — and freeze_guard denies the
// obvious paths to it. Integrity here is tamper-EVIDENT, not tamper-PROOF.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHAIN_FILE = 'chain.jsonl';
const KEY_FILE = 'key';
const CHAIN_SUBDIR = 'ticket-loop';
const FALLBACK_DIR = '.ticket-loop-chain';
const MAX_ROOT_SEARCH_DEPTH = 8;

function findGitDir(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < MAX_ROOT_SEARCH_DEPTH; i++) {
    const candidate = path.join(dir, '.git');
    if (fs.existsSync(candidate)) {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return candidate;
      // Linked worktree: .git is a file containing "gitdir: <path>".
      const m = fs.readFileSync(candidate, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (m) return path.resolve(dir, m[1].trim());
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// The chain must never live inside runDir — that is the directory the loop is allowed to
// write. Outside a git repo we still place it a level up, and say so.
function resolveChainDir(runDir) {
  const ticket = path.basename(path.resolve(runDir));
  const gitDir = findGitDir(path.dirname(path.resolve(runDir)));
  if (gitDir) return { dir: path.join(gitDir, CHAIN_SUBDIR, ticket), inGit: true };
  return {
    dir: path.join(path.dirname(path.resolve(runDir)), FALLBACK_DIR, ticket),
    inGit: false,
  };
}

function chainPath(runDir) {
  return path.join(resolveChainDir(runDir).dir, CHAIN_FILE);
}
function keyPath(runDir) {
  return path.join(resolveChainDir(runDir).dir, KEY_FILE);
}

function exists(runDir) {
  return fs.existsSync(chainPath(runDir));
}

function readKey(runDir) {
  try {
    return fs.readFileSync(keyPath(runDir), 'utf8').trim();
  } catch {
    return null;
  }
}

// Stable key order so the same payload always hashes identically.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(',')}}`;
}

function sealOf(key, record) {
  const material = [record.seq, record.kind, record.at, canonical(record.payload), record.prev].join('|');
  return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(material).digest('hex');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// { file, sha256 } for each readable path; missing files are recorded as such so a
// receipt can never imply evidence that was not there.
function hashEvidence(files) {
  return (files || []).map((f) => {
    try {
      return { file: String(f).replace(/\\/g, '/'), sha256: sha256File(f) };
    } catch {
      return { file: String(f).replace(/\\/g, '/'), sha256: null, missing: true };
    }
  });
}

function rawRecords(runDir) {
  let text;
  try {
    text = fs.readFileSync(chainPath(runDir), 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { __unparsable: l };
      }
    });
}

function create(runDir) {
  const { dir, inGit } = resolveChainDir(runDir);
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, KEY_FILE), key + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, CHAIN_FILE), '');
  return { dir, inGit };
}

// Rotate the current chain aside (CLEAN RESTART). The new chain's first record carries
// the retired chain's final seal, so a restart is visible in the report, never silent.
function rotate(runDir) {
  const { dir } = resolveChainDir(runDir);
  if (!exists(runDir)) return null;
  const records = rawRecords(runDir);
  const lastSeal = records.length ? records[records.length - 1].hmac : null;
  let n = 1;
  while (fs.existsSync(path.join(dir, `chain.${n}.jsonl`))) n++;
  fs.renameSync(chainPath(runDir), path.join(dir, `chain.${n}.jsonl`));
  fs.writeFileSync(chainPath(runDir), '');
  try {
    fs.unlinkSync(keyPath(runDir));
  } catch {}
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyPath(runDir), key + '\n', { mode: 0o600 });
  return { retired: `chain.${n}.jsonl`, retiredSeal: lastSeal, retiredRecords: records.length };
}

function append(runDir, kind, payload) {
  const key = readKey(runDir);
  if (!key) {
    const err = new Error(`no receipt chain for ${runDir} — run "ledger.js init" first`);
    err.code = 'NO_CHAIN';
    throw err;
  }
  const records = rawRecords(runDir);
  const prev = records.length ? records[records.length - 1].hmac || null : null;
  const record = {
    seq: records.length + 1,
    kind,
    at: new Date().toISOString(),
    payload: payload || {},
    prev,
  };
  record.hmac = sealOf(key, record);
  fs.appendFileSync(chainPath(runDir), JSON.stringify(record) + '\n');
  return record;
}

// Walk the chain: recompute every seal and check every prev-link.
// { ok, records, problems[] } — problems is empty iff the history is intact.
function verify(runDir) {
  const problems = [];
  if (!exists(runDir)) return { ok: false, records: [], problems: ['no receipt chain found'] };
  const key = readKey(runDir);
  if (!key) return { ok: false, records: [], problems: ['receipt chain key is missing'] };

  const records = rawRecords(runDir);
  let prev = null;
  records.forEach((r, i) => {
    if (r.__unparsable) {
      problems.push(`record ${i + 1}: unparsable line`);
      return;
    }
    if (r.seq !== i + 1) problems.push(`record ${i + 1}: seq is ${r.seq} (expected ${i + 1})`);
    if ((r.prev || null) !== prev) problems.push(`record ${r.seq}: broken prev-link`);
    const { hmac, ...body } = r;
    if (hmac !== sealOf(key, body)) problems.push(`record ${r.seq} (${r.kind}): seal does not match — content was altered`);
    prev = hmac || null;
  });
  return { ok: problems.length === 0, records: records.filter((r) => !r.__unparsable), problems };
}

function records(runDir) {
  return verify(runDir).records;
}
function ofKind(runDir, kind) {
  return records(runDir).filter((r) => r.kind === kind);
}
function first(runDir, kind) {
  return ofKind(runDir, kind)[0] || null;
}
function last(runDir, kind) {
  const all = ofKind(runDir, kind);
  return all.length ? all[all.length - 1] : null;
}

module.exports = {
  CHAIN_FILE,
  KEY_FILE,
  resolveChainDir,
  chainPath,
  keyPath,
  exists,
  create,
  rotate,
  append,
  verify,
  records,
  ofKind,
  first,
  last,
  hashEvidence,
  sha256File,
  canonical,
};
