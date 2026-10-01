#!/usr/bin/env node
// Which files import the changed files, so a focused QA read is handed its consumers instead of
// being told to go and find them. Regex over import lines, not a parser: a missed importer costs
// the judge one search, and the scope never limits what the judge may conclude.
//
// A specifier is resolved to candidate paths and matched against the target set, never against
// the filesystem, so a deleted file's importers are found too — they are the ones that break.
//
// usage: importers.js <tree> <file>...   prints { "<file>": ["<importer>", ...], ... }
'use strict';
const fs = require('fs');
const path = require('path');
const { walk, LANG_BY_EXT } = require('./outline.js');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_SCANNED_FILES = 20000;
const MAX_IMPORTERS_PER_FILE = 50;
const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

const SPECIFIERS = {
  js: [
    /\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  dart: [/^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm],
  py: [/^\s*from\s+(\.*[\w.]*)\s+import\s+([\w\s,()*]+)/gm, /^\s*import\s+([\w.,\s]+)$/gm],
  go: [/"([^"\s]+)"/g],
};

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function readText(abs) {
  try {
    if (fs.statSync(abs).size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function repoFacts(tree) {
  const pubspec = readText(path.join(tree, 'pubspec.yaml')) || '';
  const goMod = readText(path.join(tree, 'go.mod')) || '';
  return {
    dartPackage: (pubspec.match(/^name:\s*([\w-]+)/m) || [])[1] || null,
    goModule: (goMod.match(/^module\s+(\S+)/m) || [])[1] || null,
  };
}

function jsCandidates(fromDir, spec) {
  if (!spec.startsWith('.')) return [];
  const base = toPosix(path.posix.normalize(path.posix.join(fromDir, spec)));
  const stem = base.replace(/\.(m|c)?js$/, '');
  const out = [base];
  for (const ext of JS_EXTS) out.push(`${base}${ext}`, `${stem}${ext}`, `${base}/index${ext}`);
  return out;
}

function dartCandidates(fromDir, spec, facts) {
  if (spec.startsWith('dart:')) return [];
  const pkg = /^package:([\w-]+)\/(.+)$/.exec(spec);
  if (pkg) return pkg[1] === facts.dartPackage ? [`lib/${pkg[2]}`] : [];
  return [toPosix(path.posix.normalize(path.posix.join(fromDir, spec)))];
}

function pyModuleFiles(dotted) {
  const rel = dotted.replace(/\./g, '/');
  return rel ? [`${rel}.py`, `${rel}/__init__.py`] : ['__init__.py'];
}

function pyCandidates(fromDir, match) {
  const out = [];
  const roots = ['', 'src/'];
  const add = (module, names) => {
    const dots = (/^\.+/.exec(module) || [''])[0].length;
    const rest = module.slice(dots);
    const prefixes = dots
      ? [path.posix.normalize(path.posix.join(fromDir, '../'.repeat(dots - 1))).replace(/^\.$/, '')]
      : roots;
    for (const prefix of prefixes) {
      const join = (m) => (prefix ? `${prefix.replace(/\/$/, '')}/` : '') + m;
      for (const f of pyModuleFiles(rest)) out.push(join(f));
      for (const n of names) for (const f of pyModuleFiles(rest ? `${rest}.${n}` : n)) out.push(join(f));
    }
  };
  if (match.length === 3) {
    const names = match[2].replace(/[()]/g, '').split(',').map((n) => n.trim().split(/\s+/)[0]).filter((n) => n && n !== '*');
    add(match[1], names);
  } else {
    for (const m of match[1].split(',')) {
      const mod = m.trim().split(/\s+/)[0];
      if (mod) add(mod, []);
    }
  }
  return out;
}

function goImportBlock(text) {
  const blocks = [];
  for (const m of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) blocks.push(m[1]);
  for (const m of text.matchAll(/^import\s+(?:\w+\s+)?("[^"]+")/gm)) blocks.push(m[1]);
  return blocks.join('\n');
}

// For each source file under the tree, which targets does it import?
function importersOf(tree, targets) {
  const root = path.resolve(tree);
  const wanted = new Set(targets.map(toPosix));
  const facts = repoFacts(root);
  const goDirs = new Map();
  for (const t of wanted) {
    if (t.endsWith('.go') && facts.goModule) {
      const dir = path.posix.dirname(t);
      goDirs.set(dir === '.' ? facts.goModule : `${facts.goModule}/${dir}`, t);
    }
  }
  const files = [];
  const notes = [];
  walk(root, new Set(Object.keys(LANG_BY_EXT)), files, notes);
  const result = Object.fromEntries([...wanted].map((t) => [t, []]));
  const truncated = [];
  let scanned = 0;
  for (const abs of files) {
    if (scanned++ >= MAX_SCANNED_FILES) {
      notes.push(`stopped after ${MAX_SCANNED_FILES} files; importers beyond that are not listed`);
      break;
    }
    const rel = toPosix(path.relative(root, abs));
    const lang = LANG_BY_EXT[path.extname(abs)];
    const text = readText(abs);
    if (!text || !SPECIFIERS[lang]) continue;
    const fromDir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const hits = new Set();
    if (lang === 'go') {
      for (const m of goImportBlock(text).matchAll(SPECIFIERS.go[0])) {
        const target = goDirs.get(m[1]);
        if (target && path.posix.dirname(target) !== fromDir) {
          for (const t of wanted) if (t.endsWith('.go') && path.posix.dirname(t) === path.posix.dirname(target)) hits.add(t);
        }
      }
    } else {
      for (const re of SPECIFIERS[lang]) {
        for (const m of text.matchAll(re)) {
          const candidates =
            lang === 'js' ? jsCandidates(fromDir || '.', m[1]) :
            lang === 'dart' ? dartCandidates(fromDir || '.', m[1], facts) :
            pyCandidates(fromDir, m);
          for (const c of candidates) if (wanted.has(c)) hits.add(c);
        }
      }
    }
    for (const t of hits) {
      if (t === rel) continue;
      if (result[t].length >= MAX_IMPORTERS_PER_FILE) {
        if (!truncated.includes(t)) truncated.push(t);
        continue;
      }
      result[t].push(rel);
    }
  }
  for (const t of Object.keys(result)) result[t].sort();
  return { importers: result, truncated, notes };
}

function main() {
  const [tree, ...targets] = process.argv.slice(2);
  if (!tree || targets.length === 0) {
    console.error('usage: importers.js <tree> <file>...');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(importersOf(tree, targets), null, 2) + '\n');
}

if (require.main === module) main();
module.exports = { importersOf, MAX_IMPORTERS_PER_FILE };
