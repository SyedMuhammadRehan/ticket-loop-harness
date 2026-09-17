#!/usr/bin/env node
// PreToolUse hook on Read|Grep: while a ticket run is active, a whole-file Read of a long
// source file, or a Grep for one identifier, gets the outline first as context, so the model
// can read the range it needs. Advisory: it never blocks, and outside a run it does nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./hook_lib.js');
const { activeRuns } = require('./freeze_guard.js');
const outline = require('../skills/ticket-loop/scripts/outline.js');

const MIN_LINES = 120;
const MAX_HINT_SYMBOLS = 40;
const MAX_GREP_FILES = 400;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function hint(text) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }) + '\n'
  );
}

function forRead(toolInput) {
  const file = toolInput.file_path;
  if (!file || toolInput.offset != null || toolInput.limit != null) return null;
  if (!outline.LANG_BY_EXT[path.extname(file)]) return null;
  const abs = path.resolve(file);
  const lineCount = fs.readFileSync(abs, 'utf8').split('\n').length;
  if (lineCount < MIN_LINES) return null;
  const symbols = outline.outlineFile(abs, []);
  if (!symbols.length) return null;
  return { title: `${path.basename(file)} is ${lineCount} lines. Its outline`, symbols };
}

function forGrep(toolInput, root) {
  const pattern = toolInput.pattern;
  if (typeof pattern !== 'string' || !IDENTIFIER.test(pattern)) return null;
  const target = toolInput.path ? path.resolve(toolInput.path) : root;
  const files = [];
  outline.walk(target, new Set(Object.keys(outline.LANG_BY_EXT)), files, []);
  if (files.length > MAX_GREP_FILES) return null;
  const symbols = files.flatMap((f) => outline.outlineFile(f, [])).filter((s) => s.name === pattern);
  if (!symbols.length) return null;
  return { title: `Declarations of ${pattern}`, symbols };
}

function main() {
  const input = lib.readStdinJson();
  if (!input) process.exit(0);
  const root = lib.findRepoRoot(input.cwd || process.cwd());
  if (!activeRuns(root).length) process.exit(0);

  const toolInput = input.tool_input || {};
  const found = input.tool_name === 'Read' ? forRead(toolInput) : input.tool_name === 'Grep' ? forGrep(toolInput, root) : null;
  if (!found) process.exit(0);

  // Over the cap, the declarations a reader navigates by come first; module-level constants
  // are what pad a long file.
  const ranked = found.symbols.length > MAX_HINT_SYMBOLS
    ? [...found.symbols].sort((a, b) => (a.kind === 'const') - (b.kind === 'const') || a.line - b.line)
    : found.symbols;
  const shown = ranked.slice(0, MAX_HINT_SYMBOLS).sort((a, b) => a.line - b.line);
  const more = found.symbols.length - shown.length;
  hint(
    `${found.title} (path:line kind name)${more > 0 ? `, first ${shown.length} of ${found.symbols.length}` : ''}; ` +
      `read the range you need with offset/limit rather than the whole file:\n` +
      shown.map((s) => `${s.file}:${s.line}\t${s.kind}\t${s.name}`).join('\n')
  );
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}
