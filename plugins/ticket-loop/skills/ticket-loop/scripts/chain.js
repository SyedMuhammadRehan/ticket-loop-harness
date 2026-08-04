'use strict';
// Hash-chained, HMAC-sealed receipt store for a ticket run (zero deps, node builtins only).
//
// It lives OUTSIDE the run dir — in <gitdir>/ticket-loop/<TICKET>/ — because a record kept
// inside the namespace the orchestrator writes to is not a record. Consequences:
//   - archiving or deleting the run dir does not reset the budget (the chain survives);
//   - a stage receipt cannot be invented without the per-run key;
//   - `verify` detects edits and reordering from the links and seals, and truncation from the
//     head anchor (head.json) — without the anchor, dropping the last k lines is invisible,
//     because everything that remains still verifies.
//
// What `verify` does NOT establish: that the timestamps are honest (`at` is whatever the writer
// put there and is not checked for monotonicity), or that the chain is the FIRST one for this
// run — a deleted chain directory is indistinguishable from a fresh start, which is why
// ledger.js init cross-checks the run dir's mirror before creating one.
//
// Threat model, stated honestly: an agent with shell access CAN read the key and forge a
// chain. What this buys is that forging is a deliberate, multi-step, *detectable* act
// instead of a silent side effect of ordinary file writes — and freeze_guard denies the
// obvious paths to it. Integrity here is tamper-EVIDENT, not tamper-PROOF.
//
// The key is written 0o600, which is honoured on POSIX and is a no-op on Windows (the mode
// lands as 0666). Treat the key as readable by anything running as the user on every
// platform; the guarantee above does not rest on those bits.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHAIN_FILE = 'chain.jsonl';
const KEY_FILE = 'key';
const HEAD_FILE = 'head.json';
const LOCK_NAME = 'lock';
const CHAIN_SUBDIR = 'ticket-loop';
const FALLBACK_DIR = '.ticket-loop-chain';
const MAX_ROOT_SEARCH_DEPTH = 8;
const LOCK_WAIT_MS = 15000;
// Longer than any single append could take; shorter than a human notices. A lock older than
// this belonged to a process that was killed.
const LOCK_STALE_MS = 60000;

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
function headPath(runDir) {
  return path.join(resolveChainDir(runDir).dir, HEAD_FILE);
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

// The head anchor: how many records there should be, and what the last seal was.
//
// Without it, deleting the last k lines of the chain is INVISIBLE — every remaining seq is
// still contiguous, every prev-link still resolves, every seal still recomputes. Dropping the
// tail is how you erase the dispatches you just spent or a BLOCK verdict you did not like, and
// it needs no key. The anchor is sealed with the same key, so an actor who has the key can
// rewrite it too (see the threat model above); one who does not can no longer truncate quietly.
function headSeal(key, body) {
  return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(canonical(body)).digest('hex');
}

function writeHead(runDir, key, records, lastSeal) {
  const body = { records, lastSeal: lastSeal || null };
  fs.writeFileSync(headPath(runDir), JSON.stringify({ ...body, mac: headSeal(key, body) }) + '\n');
}

function readHead(runDir) {
  try {
    return JSON.parse(fs.readFileSync(headPath(runDir), 'utf8'));
  } catch {
    return null;
  }
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
  writeHead(runDir, key, 0, null);
  return { dir, inGit };
}

// Rotate the current chain aside (CLEAN RESTART). The new chain's first record carries
// the retired chain's final seal, so a restart is visible in the report, never silent.
function rotate(runDir) {
  if (!exists(runDir)) return null;
  return withLock(runDir, () => rotateUnlocked(runDir));
}

function rotateUnlocked(runDir) {
  const { dir } = resolveChainDir(runDir);
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
  writeHead(runDir, key, 0, null);
  return { retired: `chain.${n}.jsonl`, retiredSeal: lastSeal, retiredRecords: records.length };
}

// Appending is read-then-write: the next seq and prev-link come from the current last record.
// Two writers interleaving therefore both claim the same seq, and the chain then accuses
// itself of tampering — which is what parallel subagent dispatches would do to a healthy run.
// mkdir is atomic on every platform this runs on, so an empty directory is the mutex.
//
// Single-line appends are left to the OS: a lone small write to a file opened for append is
// atomic on POSIX and on Windows, so readers cannot see half a record and are not blocked.
// Only a lock whose age is KNOWN and past the window may be broken. If the stat fails the
// lock vanished mid-check, and by now the name may belong to a fresh holder — treating that
// as breakable is how two writers end up in the critical section together.
function isStale(lock) {
  try {
    return Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function withLock(runDir, fn, waitMs = LOCK_WAIT_MS) {
  const lock = path.join(resolveChainDir(runDir).dir, LOCK_NAME);
  const deadline = Date.now() + waitMs;
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      // On Windows a mkdir racing the releaser's rmdir is refused as access-denied rather
      // than already-exists, so all three errnos mean "not now" and wait out the deadline.
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      if (e.code === 'EEXIST' && isStale(lock)) {
        // A break that fails (debris inside the lock, an ACL) falls through to the
        // deadline: retrying it forever would spin without ever reaching the timeout.
        try {
          fs.rmdirSync(lock);
          continue;
        } catch {}
      }
      if (Date.now() >= deadline) {
        const err = new Error(
          `receipt chain busy: could not take ${lock} within ${waitMs}ms (last error: ${e.code}). ` +
            `If no ticket-loop process is running, remove that directory.`
        );
        err.code = 'CHAIN_LOCKED';
        throw err;
      }
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}

function append(runDir, kind, payload) {
  // Check for the chain BEFORE locking: taking the lock first would try to mkdir inside a
  // directory that does not exist and report ENOENT instead of the real problem.
  if (!readKey(runDir)) {
    const err = new Error(`no receipt chain for ${runDir} — run "ledger.js init" first`);
    err.code = 'NO_CHAIN';
    throw err;
  }
  return withLock(runDir, () => appendUnlocked(runDir, kind, payload));
}

function appendUnlocked(runDir, kind, payload) {
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
  writeHead(runDir, key, record.seq, record.hmac);
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

  // An initialized chain always holds at least its init record, so zero records means the
  // file was emptied. This check is separate from `chain.exists()`, which only asks whether
  // the file is present — an empty one would otherwise verify clean and zero every counter.
  if (records.length === 0) {
    problems.push('receipt chain is empty — it does not even hold its init record, so it was truncated to nothing');
  }

  const head = readHead(runDir);
  if (!head) {
    problems.push('chain head anchor (head.json) is missing — truncation of the history cannot be ruled out');
  } else {
    const { mac, ...body } = head;
    if (mac !== headSeal(key, body)) {
      problems.push('chain head anchor seal does not match — the anchor itself was edited');
    } else if (head.records !== records.length || (head.lastSeal || null) !== prev) {
      problems.push(
        `chain TRUNCATED or an append was interrupted: the head anchor records ${head.records} record(s) ` +
          `ending ${(head.lastSeal || 'none').toString().slice(0, 12)}…, the file holds ${records.length} ` +
          `ending ${(prev || 'none').toString().slice(0, 12)}…. Treat as tampering unless you know a run crashed here.`
      );
    }
  }

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
  HEAD_FILE,
  resolveChainDir,
  chainPath,
  keyPath,
  headPath,
  exists,
  create,
  rotate,
  append,
  withLock,
  isStale,
  LOCK_NAME,
  verify,
  records,
  ofKind,
  first,
  last,
  hashEvidence,
  sha256File,
  canonical,
  sealOf,
};
