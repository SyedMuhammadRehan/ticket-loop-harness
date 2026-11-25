'use strict';
// Friction a session met in the harness, in its own words, from <runDir>/papercuts.md:
//
//   ## <one line: what got in the way>
//   - trying: <what I was trying to do>
//   - ran: <the command or step>
//   - expected: <what should have happened>
//   - happened: <what did>
//   - instead: <what I did to get past it>
//   - fix: <what would fix it>
//
// A papercut reports; it never excuses skipping a gate. Unsealed on purpose: it is feedback for
// whoever owns the harness, not evidence the run relies on.
const fs = require('fs');
const path = require('path');

const FILE = 'papercuts.md';
const FIELDS = ['trying', 'ran', 'expected', 'happened', 'instead', 'fix'];
const REQUIRED = ['trying', 'happened', 'fix'];

function parse(text) {
  const entries = [];
  let entry = null;
  let field = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      entry = { title: heading[1] };
      entries.push(entry);
      field = null;
      continue;
    }
    if (!entry) continue;
    const item = /^-\s*([a-z]+)\s*:\s*(.*)$/i.exec(raw.trim());
    if (item && FIELDS.includes(item[1].toLowerCase())) {
      field = item[1].toLowerCase();
      entry[field] = item[2].trim();
    } else if (field && /^\s+\S/.test(raw)) {
      entry[field] = `${entry[field]} ${raw.trim()}`.trim();
    } else if (raw.trim()) {
      field = null;
    }
  }
  const malformed = entries
    .map((e) => ({ title: e.title, missing: REQUIRED.filter((f) => !e[f]) }))
    .filter((m) => m.missing.length);
  return { count: entries.length, entries, malformed };
}

function readRun(runDir) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(runDir, FILE), 'utf8');
  } catch {
    return { count: 0, entries: [], malformed: [] };
  }
  return parse(text);
}

// Every run dir in the repo, closed and archived ones included: friction outlives its run.
function readRepo(root) {
  const runsDir = path.join(root, '.agents', 'ticket-runs');
  let names = [];
  try {
    names = fs.readdirSync(runsDir).filter((n) => fs.statSync(path.join(runsDir, n)).isDirectory()).sort();
  } catch {
    names = [];
  }
  const runs = names.map((run) => ({ run, ...readRun(path.join(runsDir, run)) })).filter((r) => r.count > 0);
  return {
    repo: root,
    total: runs.reduce((n, r) => n + r.count, 0),
    malformed: runs.reduce((n, r) => n + r.malformed.length, 0),
    runs,
  };
}

module.exports = { parse, readRun, readRepo, FILE, FIELDS, REQUIRED };
