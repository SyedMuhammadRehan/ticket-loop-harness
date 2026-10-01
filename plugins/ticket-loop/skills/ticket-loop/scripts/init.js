#!/usr/bin/env node
// Write a starter profile for this repo from what the repo itself shows: its stack, its test
// command, its default branch, its ticket host. Every value is a guess to review, and the output
// says which ones it could not make. It never overwrites a profile and never runs mid-run, since
// the profile is the control plane a run is sealed against.
//
// usage: init.js [--dry-run]      run from anywhere inside the repo
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROFILE_REL = path.join('.agents', 'ticket-loop.config.json');
const IGNORES = ['.agents/ticket-runs/', '.claude/hooks/state/'];

function git(root, args) {
  const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15000 });
  return res.status === 0 ? res.stdout.trim() : null;
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function read(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

function openRun(root) {
  const runs = path.join(root, '.agents', 'ticket-runs');
  try {
    return fs
      .readdirSync(runs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.includes('._old_'))
      .find((e) => fs.existsSync(path.join(runs, e.name, 'budget.json')) && !fs.existsSync(path.join(runs, e.name, 'closed.json')));
  } catch {
    return null;
  }
}

// One stack per repo; the first manifest found wins and the others are reported.
function detectStack(root) {
  const found = [];
  const pubspec = read(root, 'pubspec.yaml');
  if (pubspec !== null) {
    const flutter = /^\s*flutter\s*:\s*$|sdk:\s*flutter/m.test(pubspec);
    found.push({
      stack: flutter ? 'flutter' : 'dart',
      verify: {
        analyze: 'dart analyze',
        test: flutter ? 'flutter test' : 'dart test',
        pubGet: flutter ? 'flutter pub get' : 'dart pub get',
        codegen: /build_runner/.test(pubspec) ? 'dart run build_runner build --delete-conflicting-outputs' : null,
      },
      extensions: ['.dart'],
      exclude: '\\.(g|freezed|gr|config|gen)\\.dart$',
      postEdit: { format: 'dart format {file}', analyze: 'dart analyze {file}' },
      riskPaths: ['pubspec.yaml', 'pubspec.lock'],
      deps: { dir: '.dart_tool', lockfile: 'pubspec.lock' },
    });
  }
  const pkgText = read(root, 'package.json');
  if (pkgText !== null) {
    let scripts = {};
    try {
      scripts = JSON.parse(pkgText).scripts || {};
    } catch {
      scripts = {};
    }
    const hasTest = typeof scripts.test === 'string' && !/no test specified/.test(scripts.test);
    const lock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].find((f) => read(root, f) !== null) || 'package-lock.json';
    const runner = lock === 'pnpm-lock.yaml' ? 'pnpm' : lock === 'yarn.lock' ? 'yarn' : 'npm';
    found.push({
      stack: 'node',
      verify: {
        analyze: scripts.lint ? `${runner} run lint` : scripts.typecheck ? `${runner} run typecheck` : null,
        test: hasTest ? `${runner} test` : null,
        pubGet: runner === 'npm' ? 'npm ci' : `${runner} install --frozen-lockfile`,
        codegen: null,
      },
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
      exclude: '\\.d\\.ts$',
      postEdit: null,
      riskPaths: ['package.json', lock],
      deps: { dir: 'node_modules', lockfile: lock },
    });
  }
  const pyproject = read(root, 'pyproject.toml');
  const requirements = read(root, 'requirements.txt');
  if (pyproject !== null || requirements !== null || read(root, 'setup.py') !== null) {
    const text = `${pyproject || ''}\n${requirements || ''}`;
    const ruff = /\bruff\b/.test(text);
    found.push({
      stack: 'python',
      verify: {
        analyze: ruff ? 'ruff check .' : null,
        test: /\bpytest\b/.test(text) || fs.existsSync(path.join(root, 'tests')) ? 'pytest -q' : null,
        pubGet: requirements !== null ? 'pip install -r requirements.txt' : 'pip install -e .',
        codegen: null,
      },
      extensions: ['.py'],
      exclude: null,
      postEdit: ruff ? { format: 'ruff format {file}', analyze: 'ruff check {file}' } : null,
      riskPaths: ['pyproject.toml', 'requirements*.txt', '**/migrations/**'],
      deps: { dir: null, lockfile: null },
    });
  }
  if (read(root, 'go.mod') !== null) {
    found.push({
      stack: 'go',
      verify: { analyze: 'go vet ./...', test: 'go test ./...', pubGet: 'go mod download', codegen: null },
      extensions: ['.go'],
      exclude: null,
      postEdit: { format: 'gofmt -w {file}', analyze: null },
      riskPaths: ['go.mod', 'go.sum'],
      deps: { dir: null, lockfile: null },
    });
  }
  return found;
}

function defaultBranch(root) {
  const remote = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remote) return remote.replace(/^origin\//, '');
  for (const name of ['main', 'master', 'develop']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== null) return name;
  }
  return git(root, ['branch', '--show-current']) || 'main';
}

function ticketSource(root) {
  const url = git(root, ['remote', 'get-url', 'origin']) || '';
  if (/github\.com/i.test(url)) return { source: 'github', note: null };
  if (/gitlab/i.test(url)) return { source: 'gitlab', note: null };
  if (/bitbucket/i.test(url)) return { source: 'manual', note: 'the remote is Bitbucket, which is not a ticket source yet; set jira if the tickets live there' };
  return { source: 'manual', note: url ? null : 'no origin remote, so tickets are pasted in (manual)' };
}

function buildProfile(root) {
  const stacks = detectStack(root);
  if (stacks.length === 0) return { error: 'no pubspec.yaml, package.json, pyproject.toml, requirements.txt, setup.py or go.mod found; copy a profile from config.example.json instead' };
  const s = stacks[0];
  const base = defaultBranch(root);
  const ticket = ticketSource(root);
  const stopGate = { extensions: s.extensions, mode: 'full', worktrees: 'all', baseRef: base, timeoutMs: 300000 };
  if (s.exclude) stopGate.exclude = s.exclude;
  const hooks = { stopGate };
  if (s.postEdit) hooks.postEdit = { extensions: s.extensions, ...(s.exclude ? { exclude: s.exclude } : {}), ...Object.fromEntries(Object.entries(s.postEdit).filter(([, v]) => v)) };
  const profile = {
    stack: s.stack,
    ticketSource: ticket.source,
    designSource: 'none',
    verify: s.verify,
    riskPaths: s.riskPaths,
    worktreePrefix: `../${path.basename(root)}-ticket-`,
    memoryFile: '.agents/ticket-loop-memory.md',
    deps: s.deps,
    attribution: { commitTrailer: null },
    hooks,
  };
  const review = [];
  if (stacks.length > 1) review.push(`several stacks found (${stacks.map((x) => x.stack).join(', ')}); the profile uses ${s.stack}`);
  for (const [k, v] of Object.entries(s.verify)) if (v === null && (k === 'test' || k === 'analyze')) review.push(`verify.${k} could not be found; set it before the first run`);
  if (ticket.note) review.push(ticket.note);
  review.push(`baseRef is ${base}; change it if tickets branch from somewhere else`);
  review.push('riskPaths holds only dependency manifests; add auth, API contracts and migrations for this repo');
  return { profile, review };
}

function ensureIgnored(root, dryRun) {
  const added = [];
  for (const entry of IGNORES) {
    const res = spawnSync('git', ['-C', root, 'check-ignore', '-q', `${entry}probe`], { timeout: 15000 });
    if (res.status !== 0) added.push(entry);
  }
  if (added.length && !dryRun) {
    const file = path.join(root, '.gitignore');
    const existing = read(root, '.gitignore') || '';
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(file, `${sep}# ticket-loop run state\n${added.join('\n')}\n`);
  }
  return added;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const root = findRoot(process.cwd());
  if (!root) {
    console.error('init: not inside a git repository');
    process.exit(1);
  }
  const target = path.join(root, PROFILE_REL);
  if (fs.existsSync(target)) {
    console.error(`init: ${target} already exists — edit it rather than regenerate it; doctor.js reports what is wrong with it`);
    process.exit(1);
  }
  const run = openRun(root);
  if (run) {
    console.error(`init: ticket run ${run.name} is open, and the profile is frozen while a run is active`);
    process.exit(1);
  }
  const built = buildProfile(root);
  if (built.error) {
    console.error(`init: ${built.error}`);
    process.exit(1);
  }
  const text = JSON.stringify(built.profile, null, 2) + '\n';
  const ignored = ensureIgnored(root, dryRun);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  console.log(`${dryRun ? 'would write' : 'wrote'} ${target}:\n${text}`);
  if (ignored.length) console.log(`${dryRun ? 'would add' : 'added'} to .gitignore: ${ignored.join(' ')}`);
  console.log(`review before the first run:\n${built.review.map((r) => `  - ${r}`).join('\n')}`);
}

if (require.main === module) main();
module.exports = { buildProfile, detectStack };
