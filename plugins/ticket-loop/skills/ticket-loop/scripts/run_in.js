#!/usr/bin/env node
// Run one check command with the worktree as its working directory, and exit with its code.
// Tools such as ESLint resolve their config from where they run, so a worktree path handed in
// from the main repo fails before checking anything; `cd` is refused by the playbook because the
// session's directory persists across calls.
//
// usage: run_in.js <worktree> "<profile command string>"
//        run_in.js <worktree> <command> [args...]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const POSIX_PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const WIN_PLAIN = /^[A-Za-z0-9_@+=:,./\\-]+$/;

// cmd.exe toggles its quoting on every `"`, so an embedded quote is doubled to keep `&` and `|`
// inside the quotes, and backslashes before a quote are doubled for the program's own parser.
// cmd.exe still expands %VAR% inside quotes; nothing in quoting can stop that.
function quoteWord(word, platform = process.platform) {
  const w = String(word);
  if (platform === 'win32') {
    if (WIN_PLAIN.test(w)) return w;
    return `"${w.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1')}"`;
  }
  if (POSIX_PLAIN.test(w)) return w;
  return `'${w.replace(/'/g, `'\\''`)}'`;
}

// One word is the profile's command string, `&&` and all, and goes to the shell as written. Several
// words were split by the calling shell, so each is quoted back for the platform shell: profile
// commands such as `npx eslint .` need one on Windows, where .cmd launchers do not start without it.
function commandLine(words, platform = process.platform) {
  return words.length === 1 ? String(words[0]) : words.map((w) => quoteWord(w, platform)).join(' ');
}

function runIn(dir, words) {
  const cwd = path.resolve(dir || '');
  if (!dir || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { error: `not a directory: ${dir}` };
  if (!words.length) return { error: 'no command given' };
  const res = spawnSync(commandLine(words), { cwd, shell: true, stdio: 'inherit' });
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
module.exports = { runIn, commandLine, quoteWord };
