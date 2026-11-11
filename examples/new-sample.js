#!/usr/bin/env node
// Makes a throwaway git repo from examples/sample-app, for a first ticket-loop run that cannot
// touch anything you care about.
//
// usage: node examples/new-sample.js <target folder>
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SOURCE = path.join(__dirname, 'sample-app');

function fail(message) {
  console.error(`new-sample: ${message}`);
  process.exit(1);
}

function git(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (res.error) fail(`git is not available (${res.error.message})`);
  if (res.status !== 0) fail(`git ${args[0]} failed: ${(res.stderr || '').trim()}`);
}

function main() {
  const target = process.argv[2];
  if (!target || target.startsWith('-')) fail('usage: node examples/new-sample.js <target folder>');
  const dest = path.resolve(target);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) fail(`${dest} already exists and is not empty`);
  fs.cpSync(SOURCE, dest, { recursive: true });
  git(dest, ['init', '-q', '-b', 'main']);
  git(dest, ['add', '-A']);
  // An identity for this one commit only: a fresh machine may have none configured.
  git(dest, ['-c', 'user.name=ticket-loop sample', '-c', 'user.email=sample@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'chore: the todo sample']);
  console.log(`new-sample: a sample repo is ready at ${dest}`);
  console.log('  next: open a Claude Code session in that folder and type /ticket-loop:setup');
  console.log('  then: /ticket-loop "<paste TICKET.md>" --dry-run');
}

main();
