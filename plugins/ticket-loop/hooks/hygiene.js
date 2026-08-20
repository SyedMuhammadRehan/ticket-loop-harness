'use strict';
// Debug artefacts and apparent secrets in the work a run ADDED. A green suite says nothing
// about either: a stray `console.log` passes every test, and a committed credential passes
// them twice.
//
// Added lines only, deliberately. Judging the whole file means reformatting one that already
// had logging trips a gate the change did not cause, and a gate that fires on other people's
// code is one people learn to route around.

// Matched on added lines in any source file the profile already selected.
const DEBUG_ARTEFACTS = [
  { re: /\bconsole\s*\.\s*(?:log|debug|dir|trace)\s*\(/, what: 'console.log / console.debug' },
  { re: /(^|[\s;{])debugger\s*(?:;|$)/, what: 'debugger statement' },
];

// A name that reads like a credential, assigned a literal long enough to be one. Short values
// are placeholders far more often than they are secrets, and flagging them teaches the reader
// to skim past this warning.
const SECRET_ASSIGNMENT =
  /\b(?:pass(?:word|wd)|secret|token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*(['"])([^'"]{8,})\1/i;

// Fixtures need credential-shaped strings to test credential handling, so the secret rule does
// not run over them. The debug rule still does.
const TEST_PATH = /(^|[\\/])(?:tests?|e2e|__tests__|spec)[\\/]|[._-](?:test|spec)\.[cm]?[jt]sx?$/i;

// A value that announces it is not real.
const OBVIOUS_PLACEHOLDER = /^(?:x+|\.+|\*+|<.*>|\$\{.*\}|change[_-]?me|your[_-]|example|placeholder|redacted|dummy|fake|todo)/i;

function isTestPath(file) {
  return TEST_PATH.test(file);
}

// Walk a unified diff, yielding every added line with the file and new-file line number it
// landed on. Anything the parser does not understand contributes nothing rather than guessing.
function addedLines(diff) {
  const out = [];
  let file = null;
  let lineNo = 0;
  for (const raw of String(diff || '').split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^[ab]\//, '');
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      lineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (!file || !lineNo) continue;
    if (raw.startsWith('+')) {
      out.push({ file, line: lineNo, text: raw.slice(1) });
      lineNo++;
    } else if (raw.startsWith('-')) {
      // A removed line does not advance the new-file counter.
    } else if (raw.startsWith(' ')) {
      lineNo++;
    }
  }
  return out;
}

function scanDiff(diff, opts = {}) {
  const matches = (file) => !opts.extensions || opts.extensions.some((ext) => file.toLowerCase().endsWith(ext));
  const findings = [];
  for (const added of addedLines(diff)) {
    if (!matches(added.file)) continue;
    const text = added.text;
    for (const artefact of DEBUG_ARTEFACTS) {
      if (artefact.re.test(text)) {
        findings.push({ kind: 'debug', file: added.file, line: added.line, what: artefact.what, text: text.trim() });
      }
    }
    if (isTestPath(added.file)) continue;
    const secret = text.match(SECRET_ASSIGNMENT);
    if (secret && !OBVIOUS_PLACEHOLDER.test(secret[2])) {
      findings.push({
        kind: 'secret',
        file: added.file,
        line: added.line,
        what: 'a credential-shaped name assigned a literal value',
        // The value itself is never echoed: this output is fed back into the session.
        text: text.replace(secret[2], '<redacted>').trim(),
      });
    }
  }
  return findings;
}

function describe(findings) {
  const debug = findings.filter((f) => f.kind === 'debug');
  const secret = findings.filter((f) => f.kind === 'secret');
  const lines = [];
  if (secret.length) {
    lines.push(`${secret.length} apparent secret(s) in added lines:`);
    for (const f of secret) lines.push(`  ${f.file}:${f.line}  ${f.text}`);
    lines.push('  Move the value to an environment variable. If it is real, rotate it: removing it from');
    lines.push('  a later commit does not un-leak it.');
  }
  if (debug.length) {
    lines.push(`${debug.length} debug artefact(s) in added lines:`);
    for (const f of debug) lines.push(`  ${f.file}:${f.line}  ${f.text}`);
  }
  return lines.join('\n');
}

module.exports = { scanDiff, addedLines, describe, isTestPath };
