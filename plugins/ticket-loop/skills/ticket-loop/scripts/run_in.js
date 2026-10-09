#!/usr/bin/env node
// Run one check command with the worktree as its working directory, and exit with its code.
// Tools such as ESLint resolve their config from where they run, so a worktree path handed in
// from the main repo fails before checking anything; `cd` is refused by the playbook because the
// session's directory persists across calls.
//
// usage: run_in.js <worktree> <command> [args...]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runIn(dir, words) {
  const cwd = path.resolve(dir || '');
  if (!dir || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { error: `not a directory: ${dir}` };
  if (!words.length) return { error: 'no command given' };
  // The words were split by the calling shell, so they are joined back for the platform shell:
  // profile commands such as `flutter test --exclude-tags golden` or `npx eslint .` need it on
  // Windows, where .cmd launchers do not start without one.
  const command = words.map((w) => (/[\s"]/.test(w) ? `"${w.replace(/"/g, '\\"')}"` : w)).join(' ');
  const res = spawnSync(command, { cwd, shell: true, stdio: 'inherit' });
  if (res.error) return { error: res.error.message };
  return { status: res.status === null ? 1 : res.status };
}

function main() {
  const [dir, ...words] = process.argv.slice(2);
  const r = runIn(dir, words);
  if (r.error) {
    console.error(`run_in: ${r.error}\nusage: run_in.js <worktree> <command> [args...]`);
    process.exit(2);
  }
  process.exit(r.status);
}

if (require.main === module) main();
module.exports = { runIn };
