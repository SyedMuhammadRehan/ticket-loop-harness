'use strict';
// Portable test entry: `node --test <dir>` and glob args behave differently across
// Node versions/platforms, so enumerate the files ourselves and hand them to --test.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(__dirname, f));

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status == null ? 1 : res.status);
