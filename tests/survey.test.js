'use strict';
// A codebase map that does not say where it came from cannot be judged stale or trusted. The
// survey script writes the map from a configured command or the plugin's outline, and stamps
// it with both the source and the commit it read.
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

function mkRepo(config) {
  const root = mkTmpDir('tl-survey');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@test');
  git(root, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(root, '.agents', 'ticket-runs', 'T-1'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'ticket-loop.config.json'), JSON.stringify(config));
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
  const { root, runDir, head } = mkRepo({ verify: { test: 'x' }, survey: { source: 'node -e "console.log(\'GRAPH REPORT: 3 communities\')"' } });
  try {
    const { out, map } = survey(root, [runDir]);
    assert.strictEqual(out.head, head);
    assert.ok(map.includes(`@ ${head}`), map);
    assert.ok(map.includes('## Source: node -e'), map);
    assert.ok(map.includes('GRAPH REPORT: 3 communities'), map);
    assert.strictEqual(out.symbols, null, 'a configured source is used as-is, not outlined');
  } finally {
    rmDir(root);
  }
});

test('with no source configured the map is the outline of the tree', () => {
  const { root, runDir } = mkRepo({ verify: { test: 'x' } });
  try {
    const { out, map } = survey(root, [runDir, '--paths', 'src']);
    assert.ok(map.includes('## Source: outline.js src @'), map);
    assert.ok(map.includes('src/a.js:1\tfunction\talpha'), map);
    assert.ok(map.includes('src/a.js:2\tclass\tBeta'), map);
    assert.strictEqual(out.symbols, 2);
  } finally {
    rmDir(root);
  }
});

test('a source command that fails falls back to the outline and says so', () => {
  const { root, runDir } = mkRepo({ verify: { test: 'x' }, survey: { source: 'node -e "process.exit(3)"' } });
  try {
    const { out, map } = survey(root, [runDir, '--paths', 'src']);
    assert.ok(map.includes('## Source: outline.js src @'), map);
    assert.ok(map.includes('survey.source failed (exit 3)'), map);
    assert.ok(out.notes.some((n) => n.includes('failed')), JSON.stringify(out.notes));
  } finally {
    rmDir(root);
  }
});

test('it refuses a run dir that does not exist', () => {
  const { root } = mkRepo({ verify: { test: 'x' } });
  try {
    const res = runScript(SURVEY, ['.agents/ticket-runs/NOPE'], { cwd: root });
    assert.strictEqual(res.status, 1);
  } finally {
    rmDir(root);
  }
});
