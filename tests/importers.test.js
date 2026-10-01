'use strict';
// The invariant under test: a focused QA read is handed the files that import what changed,
// per stack, including the importers of a file the change deleted.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, mkTmpDir, rmDir } = require('./helpers.js');
const { importersOf } = require(path.join(SCRIPTS_DIR, 'importers.js'));

function tree(files) {
  const root = mkTmpDir('tl-imp');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

test('importers are found per stack: js and ts, dart package and relative, python, go', () => {
  const root = tree({
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': "import { a } from './a';\n",
    'src/c.js': "const a = require('./a');\n",
    'src/d.tsx': "export { a } from './a.js';\n",
    'src/e.ts': "import { x } from 'lodash';\n",
    'pubspec.yaml': 'name: shop\n',
    'lib/core/api.dart': 'class Api {}\n',
    'lib/ui/home.dart': "import 'package:shop/core/api.dart';\n",
    'lib/core/cache.dart': "import 'api.dart';\n",
    'lib/ui/other.dart': "import 'package:other/core/api.dart';\n",
    'app/models.py': 'class M: pass\n',
    'app/views.py': 'from app.models import M\n',
    'app/sub/admin.py': 'from .. import models\n',
    'app/rel.py': 'from .models import M\n',
    'go.mod': 'module example.com/svc\n',
    'store/store.go': 'package store\n',
    'api/handler.go': 'package api\n\nimport (\n\t"fmt"\n\t"example.com/svc/store"\n)\n',
  });
  try {
    const { importers } = importersOf(root, ['src/a.ts', 'lib/core/api.dart', 'app/models.py', 'store/store.go']);
    assert.deepStrictEqual(importers['src/a.ts'], ['src/b.ts', 'src/c.js', 'src/d.tsx']);
    assert.deepStrictEqual(importers['lib/core/api.dart'], ['lib/core/cache.dart', 'lib/ui/home.dart']);
    assert.deepStrictEqual(importers['app/models.py'], ['app/rel.py', 'app/sub/admin.py', 'app/views.py']);
    assert.deepStrictEqual(importers['store/store.go'], ['api/handler.go']);
  } finally {
    rmDir(root);
  }
});

test('the importers of a deleted file are still found, since they are the ones that break', () => {
  const root = tree({ 'src/user.js': "import { gone } from './gone';\n" });
  try {
    assert.deepStrictEqual(importersOf(root, ['src/gone.js']).importers['src/gone.js'], ['src/user.js']);
  } finally {
    rmDir(root);
  }
});
