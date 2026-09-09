#!/usr/bin/env node
// Prints the top-level declarations of a tree with their line numbers, so an implementer reads
// a range instead of a file. Advisory: a regex misses what a parser would catch, and a miss
// costs one wider read. The header names the commit the lines were read from, because line
// numbers from a tree that has since moved are worse than none.
//
// usage: outline.js <path>... [--ext .js,.py]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', 'target',
  '.dart_tool', '__pycache__', '.venv', 'venv', '.agents', '.playwright-mcp',
]);
const MAX_FILE_BYTES = 512 * 1024;
const BINARY_PROBE_BYTES = 8192;
// Past this the outline is itself the thing being read whole; the tail is dropped with a note.
const MAX_SYMBOLS = 2000;

// Block comments and docstrings that span lines are the one context a column-0 declaration
// pattern reads wrongly, so they are tracked; template literals are not.
const BLOCK_COMMENT = { js: ['/*', '*/'], go: ['/*', '*/'], dart: ['/*', '*/'], py: ['"""', '"""'] };

const IDENT = '[A-Za-z_$][\\w$]*';
const RULES = {
  js: [
    { kind: 'function', re: new RegExp(`^(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`) },
    { kind: 'class', re: new RegExp(`^(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+(${IDENT})`) },
    { kind: 'const', re: new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*=`) },
    { kind: 'type', re: new RegExp(`^(?:export\\s+)?(?:interface|type|enum)\\s+(${IDENT})`) },
    { kind: 'export', re: /^module\.exports(?:\.([A-Za-z_$][\w$]*))?\s*=/, fallback: 'module.exports' },
  ],
  py: [
    { kind: 'function', re: /^(?:async\s+)?def\s+(\w+)/ },
    { kind: 'class', re: /^class\s+(\w+)/ },
  ],
  go: [
    { kind: 'function', re: /^func\s+(?:\([^)]*\)\s*)?(\w+)/ },
    { kind: 'type', re: /^type\s+(\w+)/ },
  ],
  dart: [
    { kind: 'class', re: /^(?:abstract\s+)?(?:class|mixin|enum|extension)\s+(\w+)/ },
    // A return type, a lower-case name, a parameter list, then the body opener. Keywords never
    // carry a return type, so control flow does not match.
    { kind: 'function', re: /^(?:[A-Z][\w<>?,\s]*|void|dynamic|int|double|String|bool|num)\s+([a-z_]\w*)\s*\([^)]*\)\s*(?:async\*?\s*)?(?:=>|\{)/ },
  ],
};
const LANG_BY_EXT = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js',
  '.py': 'py',
  '.go': 'go',
  '.dart': 'dart',
};

function headSha(cwd) {
  const res = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 });
  return res.status === 0 ? res.stdout.trim() : 'no-git';
}

function isBinary(buffer) {
  const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
  return probe.includes(0);
}

function walk(target, extensions, files, notes) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    notes.push(`skipped: ${target} (not found)`);
    return;
  }
  if (stat.isFile()) {
    files.push(target);
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    notes.push(`skipped: ${target} (${err.code || 'unreadable'})`);
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(target, entry.name), extensions, files, notes);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(path.join(target, entry.name));
    }
  }
}

function outlineFile(file, notes) {
  const lang = LANG_BY_EXT[path.extname(file)];
  if (!lang) return [];
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (err) {
    notes.push(`skipped: ${file} (${err.code || 'unreadable'})`);
    return [];
  }
  if (buffer.length > MAX_FILE_BYTES) {
    notes.push(`skipped: ${file} (${buffer.length} bytes, over ${MAX_FILE_BYTES})`);
    return [];
  }
  if (isBinary(buffer)) return [];
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/') || file;
  const symbols = [];
  const lines = buffer.toString('utf8').split('\n');
  const [open, close] = BLOCK_COMMENT[lang];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (inBlock) {
      if (line.includes(close)) inBlock = false;
      continue;
    }
    const opensAt = line.indexOf(open);
    if (opensAt !== -1 && !line.includes(close, opensAt + open.length)) {
      inBlock = true;
      if (opensAt === 0) continue;
    }
    // Column 0 is what marks a declaration as top-level, so indentation is kept unless a
    // leading comment was the thing occupying it.
    const parts = line.split(open);
    const code =
      parts.length === 1
        ? line
        : parts
            .map((part, n) => {
              if (n === 0) return part;
              const end = part.indexOf(close);
              return end === -1 ? '' : part.slice(end + close.length);
            })
            .join('')
            .trimStart();
    for (const rule of RULES[lang]) {
      const m = rule.re.exec(code);
      if (!m) continue;
      symbols.push({ file: rel, line: i + 1, kind: rule.kind, name: m[1] || rule.fallback });
      break;
    }
  }
  return symbols;
}

function main() {
  const argv = process.argv.slice(2);
  let extensions = new Set(Object.keys(LANG_BY_EXT));
  const at = argv.indexOf('--ext');
  if (at !== -1 && argv[at + 1]) {
    extensions = new Set(
      argv[at + 1]
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => (e.startsWith('.') ? e : `.${e}`))
    );
    argv.splice(at, 2);
  }
  const targets = argv.length ? argv : ['.'];
  const notes = [];
  const files = [];
  for (const target of targets) walk(target, extensions, files, notes);

  const symbols = files.flatMap((f) => outlineFile(f, notes));
  if (symbols.length > MAX_SYMBOLS) {
    notes.push(`truncated: ${symbols.length - MAX_SYMBOLS} more symbol(s) — narrow the path`);
    symbols.length = MAX_SYMBOLS;
  }
  const out = [`# outline of ${targets.join(' ')} @ ${headSha(process.cwd())} — ${files.length} file(s), ${symbols.length} symbol(s)`];
  for (const s of symbols) out.push(`${s.file}:${s.line}\t${s.kind}\t${s.name}`);
  for (const note of notes) out.push(`# ${note}`);
  process.stdout.write(out.join('\n') + '\n');
}

main();
