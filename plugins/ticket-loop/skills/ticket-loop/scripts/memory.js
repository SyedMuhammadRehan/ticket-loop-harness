#!/usr/bin/env node
// Cross-run lesson store (zero deps). read <file> | add <file> <type> <ticket> <text...>
// Two tiers in the file: "## Lessons" (curated) and "## Pending" (auto-captured).
'use strict';
const fs = require('fs');
const path = require('path');

const TEMPLATE = `# Ticket-loop memory

Lessons the loop carries between runs. The loop READS everything here at the start of a run
and APPENDS to "Pending" at the end. Periodically promote good Pending items into "Lessons"
and delete stale ones — curation keeps this trustworthy.

## Lessons (curated — human-maintained, high trust)
<!-- flaky: <test> — <why> -->
<!-- fix: <error signature> → <approach that worked> -->
<!-- convention: <thing the loop should always do in this repo> -->

## Pending (auto-captured — review, then promote or delete)
`;

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function cmdRead(p) {
  process.stdout.write(readFile(p));
}

function cmdAdd(p, type, ticket, text) {
  const kinds = ['flaky', 'fix', 'convention', 'gotcha'];
  if (!kinds.includes(type)) {
    console.error(`memory add: type must be one of ${kinds.join(', ')}`);
    process.exit(1);
  }
  // Collapse newlines / leading '#' so a lesson can't forge a heading (one line only).
  text = String(text).replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '').trim();
  if (!text) { console.error('memory add: empty text after sanitizing'); process.exit(1); }
  const ticketSafe = String(ticket).replace(/[\r\n]+/g, ' ').trim();
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `- [${type}] (${ticketSafe} · ${stamp}) ${text}`;

  let body = readFile(p);
  if (!body) body = TEMPLATE;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';

  const dup = body.split(/\r?\n/).some((l) => {
    const m = l.match(/^- \[(\w+)\] \([^)]*\) (.*)$/);
    return m && m[1] === type && m[2].trim() === text;
  });
  if (dup) { process.stdout.write('memory: duplicate — not added\n'); return; }

  if (!/^## Pending/m.test(body)) body += `${eol}## Pending (auto-captured — review, then promote or delete)${eol}`;
  body = body.replace(/(^## Pending[^\r\n]*\r?\n)/m, `$1${line}${eol}`);

  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    process.stdout.write(`memory: added ${type} lesson for ${ticket}\n`);
  } catch (e) {
    console.error(`memory: write failed (${e.message})`);
    process.exit(1);
  }
}

function main() {
  const [cmd, file, type, ticket, ...rest] = process.argv.slice(2);
  if (!cmd || !file) {
    console.error('usage: memory.js read <file> | memory.js add <file> <type> <ticket> <text>');
    process.exit(1);
  }
  if (cmd === 'read') return cmdRead(file);
  if (cmd === 'add') {
    if (!type || !ticket || rest.length === 0) {
      console.error('memory add: need <type> <ticket> <text>');
      process.exit(1);
    }
    return cmdAdd(file, type, ticket, rest.join(' '));
  }
  console.error(`memory.js: unknown command "${cmd}"`);
  process.exit(1);
}
main();
