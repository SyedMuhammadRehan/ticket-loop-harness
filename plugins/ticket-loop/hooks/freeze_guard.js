#!/usr/bin/env node
// PreToolUse hook: deny Edit/Write to frozen done-list files.
'use strict';
const fs = require('fs');

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
const file = input && input.tool_input && input.tool_input.file_path;
if (!file) process.exit(0);

const p = String(file).replace(/\\/g, '/').toLowerCase();
const frozen =
  /(^|\/)ticket-runs\/(.+\/)?done\.md$/.test(p) ||
  /\.approved\.md$/.test(p);

if (frozen) {
  console.error(
    `BLOCKED: ${file} is a frozen done-list artifact. ` +
    `Criteria may be ADDED in done-additions.md, never edited or removed here.`
  );
  process.exit(2);
}
process.exit(0);
