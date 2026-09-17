'use strict';
// A codebase map that does not say where it came from cannot be judged stale. The survey
// script is the plugin's own outline, stamped with the commit it read; nothing outside the
// plugin is run to produce it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpDir, rmDir, runScript, SCRIPTS_DIR } = require('./helpers.js');

const SURVEY = path.join(SCRIPTS_DIR, 'survey.js');

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function mkRepo() {
  const root = mkTmpDir('tl-survey');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@test');
  git(root, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(root, '.agents', 'ticket-runs', 'T-1'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify({ verify: { test: 'x' } }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export function alpha() {}\nexport class Beta {}\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/ticket-runs/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, runDir: '.agents/ticket-runs/T-1', head: git(root, 'rev-parse', 'HEAD').trim() };
}

function survey(root, args) {
  const res = runScript(SURVEY, args, { cwd: root });
  assert.strictEqual(res.status, 0, res.stderr);
  return { out: JSON.parse(res.stdout), map: fs.readFileSync(path.join(root, '.agents', 'ticket-runs', 'T-1', 'codebase-map.md'), 'utf8') };
}

test('the map is stamped with the source command and the HEAD it was read from', () => {
  const { root, runDir, head } = mkRepo();
  try {
    const { out, map } = survey(root, [runDir, '--paths', 'src']);
    assert.strictEqual(out.head, head);
    assert.ok(map.includes(`## Source: outline.js src @ ${head}`), map);
  } finally {
    rmDir(root);
  }
});

test('the map is the outline of the named paths', () => {
  const { root, runDir } = mkRepo();
  try {
    const { out, map } = survey(root, [runDir, '--paths', 'src']);
    assert.ok(map.includes('src/a.js:1\tfunction\talpha'), map);
    assert.ok(map.includes('src/a.js:2\tclass\tBeta'), map);
    assert.strictEqual(out.symbols, 2);
    assert.ok(map.includes('## Explorer findings'), 'the map leaves room for the explorer dispatch');
  } finally {
    rmDir(root);
  }
});

test('nothing in the script runs a configured or external command', () => {
  const src = fs.readFileSync(SURVEY, 'utf8');
  assert.ok(!/child_process|spawn|exec/.test(src), 'survey.js must not run commands; the map is the plugin\'s own outline');
});

test('it refuses a run dir that does not exist', () => {
  const { root } = mkRepo();
  try {
    const res = runScript(SURVEY, ['.agents/ticket-runs/NOPE'], { cwd: root });
    assert.strictEqual(res.status, 1);
  } finally {
    rmDir(root);
  }
});
