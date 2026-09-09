'use strict';
// The outline gives an implementer line numbers so it reads a range instead of a file. It is
// advisory, so it never fails a run; what it must guarantee is that a reader can tell which
// tree it describes, because line numbers from a tree that has since moved are worse than none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpDir, rmDir, runScript, SCRIPTS_DIR } = require('./helpers.js');

const OUTLINE = path.join(SCRIPTS_DIR, 'outline.js');

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function mkTree() {
  const root = mkTmpDir('tl-outline');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@test');
  git(root, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'shop.js'),
    [
      "'use strict';",
      'const RATE = 3;',
      'export function parseDuration(text) {',
      '  return text;',
      '}',
      'export default class Cart {',
      '  add() {}',
      '}',
      'async function hidden() {}',
      'module.exports = { parseDuration };',
    ].join('\n')
  );
  fs.writeFileSync(path.join(root, 'src', 'svc.py'), 'import os\n\nclass OrderService:\n    pass\n\n\nasync def fetch_orders(user):\n    return []\n');
  fs.writeFileSync(path.join(root, 'src', 'main.go'), 'package main\n\ntype Order struct{}\n\nfunc (o *Order) Total() int { return 0 }\n\nfunc main() {}\n');
  fs.writeFileSync(path.join(root, 'src', 'cart.dart'), "import 'x.dart';\n\nclass CartPage extends StatelessWidget {}\n\nFuture<void> loadCart() async {}\n");
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'export function shouldNotAppear() {}\n');
  fs.writeFileSync(path.join(root, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 3]));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function outline(root, ...args) {
  const res = runScript(OUTLINE, args, { cwd: root });
  return { ...res, lines: (res.stdout || '').split('\n').filter(Boolean) };
}

test('the outline is stamped with the HEAD it was read from', () => {
  const root = mkTree();
  try {
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const res = outline(root, 'src');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.lines[0].includes(head), `header must carry the HEAD sha: ${res.lines[0]}`);
  } finally {
    rmDir(root);
  }
});

test('top-level declarations are listed with their line numbers, per language', () => {
  const root = mkTree();
  try {
    const { lines } = outline(root, 'src');
    const has = (s) => lines.some((l) => l.includes(s));
    assert.ok(has('src/shop.js:3\tfunction\tparseDuration'), lines.join('\n'));
    assert.ok(has('src/shop.js:6\tclass\tCart'), lines.join('\n'));
    assert.ok(has('src/shop.js:2\tconst\tRATE'), lines.join('\n'));
    assert.ok(has('src/shop.js:9\tfunction\thidden'), lines.join('\n'));
    assert.ok(has('src/svc.py:3\tclass\tOrderService'), lines.join('\n'));
    assert.ok(has('src/svc.py:7\tfunction\tfetch_orders'), lines.join('\n'));
    assert.ok(has('src/main.go:3\ttype\tOrder'), lines.join('\n'));
    assert.ok(has('src/main.go:5\tfunction\tTotal'), lines.join('\n'));
    assert.ok(has('src/cart.dart:3\tclass\tCartPage'), lines.join('\n'));
    assert.ok(has('src/cart.dart:5\tfunction\tloadCart'), lines.join('\n'));
  } finally {
    rmDir(root);
  }
});

test('dependency and build directories are skipped, and a binary file does not break the run', () => {
  const root = mkTree();
  try {
    const res = outline(root, '.');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(!res.lines.some((l) => l.includes('shouldNotAppear')), 'node_modules leaked into the outline');
    assert.ok(!res.lines.some((l) => l.includes('blob.bin')), 'a binary file produced symbols');
  } finally {
    rmDir(root);
  }
});

test('a declaration inside a block comment or docstring is not a symbol, and the count is exact', () => {
  const root = mkTree();
  try {
    fs.writeFileSync(
      path.join(root, 'src', 'noisy.js'),
      ['/*', 'function phantom() {}', '*/', 'const real = 1; /* class NotReal {} */', '/* one-liner */ function alsoReal() {}'].join('\r\n')
    );
    fs.writeFileSync(path.join(root, 'src', 'doc.py'), '"""\ndef phantom():\n    pass\n"""\ndef real():\n    pass\n');
    const { lines } = outline(root, 'src/noisy.js', 'src/doc.py');
    const symbols = lines.filter((l) => !l.startsWith('#'));
    assert.deepStrictEqual(symbols, [
      'src/noisy.js:4\tconst\treal',
      'src/noisy.js:5\tfunction\talsoReal',
      'src/doc.py:5\tfunction\treal',
    ]);
  } finally {
    rmDir(root);
  }
});

test('--ext accepts extensions with or without the dot', () => {
  const root = mkTree();
  try {
    const dotted = outline(root, 'src', '--ext', '.py').lines.filter((l) => !l.startsWith('#'));
    const bare = outline(root, 'src', '--ext', 'py').lines.filter((l) => !l.startsWith('#'));
    assert.deepStrictEqual(bare, dotted);
    assert.ok(bare.length > 0 && bare.every((l) => l.startsWith('src/svc.py')), bare.join('\n'));
  } finally {
    rmDir(root);
  }
});

test('the output is capped with a note rather than dumped whole', () => {
  const root = mkTree();
  try {
    fs.writeFileSync(path.join(root, 'src', 'many.js'), Array.from({ length: 2100 }, (_, i) => `function f${i}() {}`).join('\n'));
    const res = outline(root, 'src/many.js');
    const symbols = res.lines.filter((l) => !l.startsWith('#'));
    assert.strictEqual(symbols.length, 2000);
    assert.ok(res.lines.some((l) => l.startsWith('# truncated: 100 more')), res.lines.slice(-2).join('\n'));
  } finally {
    rmDir(root);
  }
});

test('it never exits non-zero: a missing path is reported, not thrown', () => {
  const root = mkTree();
  try {
    const res = outline(root, 'does-not-exist');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok((res.stdout + res.stderr).includes('does-not-exist'));
  } finally {
    rmDir(root);
  }
});
