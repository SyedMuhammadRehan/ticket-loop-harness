#!/usr/bin/env node
// Writes the top of a run's codebase-map.md from the profile's survey.source command, or from
// the plugin's outline when none is configured. The map names the command and the commit it
// was read from, so a reader can tell what produced it and whether the tree has moved since.
//
// usage: survey.js <runDir> [--worktree <path>] [--paths <dir>[,<dir>]]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const outline = require('./outline.js');

const SOURCE_TIMEOUT_MS = 120000;
const MAX_BODY_CHARS = 60000;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'ticket-loop.config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function takeFlag(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1 || argv[at + 1] === undefined) return null;
  const value = argv[at + 1];
  argv.splice(at, 2);
  return value;
}

function fromSource(command, tree) {
  const res = spawnSync(command, { shell: true, cwd: tree, encoding: 'utf8', timeout: SOURCE_TIMEOUT_MS });
  if (res.status !== 0 || res.error) {
    const why = res.error ? res.error.message : `exit ${res.status}`;
    const tail = (res.stderr || '').trim().split('\n').slice(-5).join('\n');
    return { ok: false, note: `survey.source failed (${why})${tail ? `: ${tail}` : ''}` };
  }
  let body = res.stdout || '';
  let note = null;
  if (body.length > MAX_BODY_CHARS) {
    note = `survey.source output truncated at ${MAX_BODY_CHARS} characters`;
    body = body.slice(0, MAX_BODY_CHARS);
  }
  return { ok: true, body, note };
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
    '(append the explorer dispatch\'s return here, or state why none was dispatched)',
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
  const cfg = readConfig();
  const command = cfg.survey && typeof cfg.survey.source === 'string' && cfg.survey.source.trim() ? cfg.survey.source.trim() : null;
  const paths = pathsArg ? pathsArg.split(',').map((p) => p.trim()).filter(Boolean) : ['.'];
  const notes = [];
  let source;
  let body;
  let symbols = null;

  if (command) {
    const res = fromSource(command, tree);
    if (res.ok) {
      source = command;
      body = res.body;
      if (res.note) notes.push(res.note);
    } else {
      notes.push(res.note);
    }
  }
  if (body === undefined) {
    const res = fromOutline(tree, paths);
    source = `outline.js ${paths.join(' ')}`;
    body = res.body;
    symbols = res.symbols;
    notes.push(...res.notes);
  }
  writeMap(runDir, source, head, body, notes);
  process.stdout.write(
    JSON.stringify({ file: path.join(runDir, 'codebase-map.md'), source, head, symbols, bytes: body.length, notes }, null, 2) + '\n'
  );
}

if (require.main === module) main();
