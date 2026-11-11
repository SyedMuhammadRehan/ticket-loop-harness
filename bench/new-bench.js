#!/usr/bin/env node
// Makes the Depot repo the ticket loop is tested on. The agent under test gets the app, its
// tickets and a profile; the answer key stays here.
//
// usage: node bench/new-bench.js <target folder>
'use strict';
const path = require('path');
const { makeRepo, ticketIds } = require('./lib.js');

const target = process.argv[2];
if (!target || target.startsWith('-')) {
  console.error('usage: node bench/new-bench.js <target folder>');
  process.exit(1);
}
try {
  const dest = makeRepo(path.resolve(target));
  console.log(`new-bench: Depot is ready at ${dest}`);
  console.log(`  tickets: ${ticketIds().join(', ')} under tickets/`);
  console.log('  next: open a NEW Claude Code session in that folder, then /ticket-loop:setup');
  console.log('  run one: /ticket-loop T01   (paste tickets/T01.md when it asks for the ticket)');
  console.log(`  score it: node ${path.join('bench', 'score.js')} T01 ${dest}`);
} catch (err) {
  console.error(`new-bench: ${err.message}`);
  process.exit(1);
}
