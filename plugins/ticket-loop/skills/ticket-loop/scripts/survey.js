#!/usr/bin/env node
// Writes the top of a run's codebase-map.md: the plugin's own outline of the paths given,
// stamped with the commit it was read from so a reader can tell whether the tree has moved.
//
// usage: survey.js <runDir> [--worktree <path>] [--paths <dir>[,<dir>]]
'use strict';
const fs = require('fs');
const path = require('path');
const outline = require('./outline.js');

function takeFlag(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1 || argv[at + 1] === undefined) return null;
  const value = argv[at + 1];
  argv.splice(at, 2);
  return value;
}

function fromOutline(tree, paths) {
  const files = [];
  const notes = [];
  const extensions = new Set(Object.keys(outline.LANG_BY_EXT));
  const previous = process.cwd();
  process.chdir(tree);
  try {
    for (const target of paths) outline.walk(target, extensions, files, notes);
    const symbols = files.flatMap((f) => outline.outlineFile(f, notes));
    if (symbols.length > outline.MAX_SYMBOLS) {
      notes.push(`truncated: ${symbols.length - outline.MAX_SYMBOLS} more symbol(s) — narrow --paths`);
      symbols.length = outline.MAX_SYMBOLS;
    }
    const lines = symbols.map((s) => `${s.file}:${s.line}\t${s.kind}\t${s.name}`);
    return { body: lines.join('\n'), symbols: symbols.length, files: files.length, notes };
  } finally {
    process.chdir(previous);
  }
}

function writeMap(runDir, source, head, body, notes) {
  const ticket = path.basename(runDir);
  const text = [
    `# Codebase map — ${ticket}`,
    '',
    `## Source: ${source} @ ${head}`,
    '',
    '```',
    body.trimEnd(),
    '```',
    ...notes.map((n) => `- ${n}`),
    '',
    '## Explorer findings',
    '',
    "(append the explorer dispatch's return here, or state why none was dispatched)",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(runDir, 'codebase-map.md'), text);
}

function main() {
  const argv = process.argv.slice(2);
  const worktree = takeFlag(argv, '--worktree');
  const pathsArg = takeFlag(argv, '--paths');
  const runDir = argv[0];
  if (!runDir || !fs.existsSync(runDir)) {
    console.error('usage: survey.js <runDir> [--worktree <path>] [--paths <dir>[,<dir>]] — the run dir must exist (ledger.js init creates it)');
    process.exit(1);
  }
  const tree = path.resolve(worktree || '.');
  const head = outline.headSha(tree);
  const paths = pathsArg ? pathsArg.split(',').map((p) => p.trim()).filter(Boolean) : ['.'];
  const res = fromOutline(tree, paths);
  const source = `outline.js ${paths.join(' ')}`;
  writeMap(runDir, source, head, res.body, res.notes);
  process.stdout.write(
    JSON.stringify({ file: path.join(runDir, 'codebase-map.md'), source, head, symbols: res.symbols, files: res.files, notes: res.notes }, null, 2) + '\n'
  );
}

if (require.main === module) main();
