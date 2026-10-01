#!/usr/bin/env node
// SessionStart hook: say at the start of a session what will otherwise surface only as refusals.
//
// An open ticket run arms every gate in the repo, and a pre-plugin copy of these hooks runs
// beside the plugin's on every edit and stop. Both were found weeks late in a field repo, by the
// refusals they caused. This names them once, up front, and stays silent when there is nothing.
//
// Always exit 0: a session must start whatever this finds or fails to read.
'use strict';
const path = require('path');
const lib = require('./hook_lib.js');

const LEDGER_TIMEOUT_MS = 10000;

function runLines(root, runs, sessionId, staleHours) {
  const ledger = lib.findLedger(root);
  return runs.map((runDir) => {
    const name = path.basename(runDir);
    const res = ledger ? lib.runStatus(ledger, runDir, root, LEDGER_TIMEOUT_MS) : {};
    if (!res.status) return `ticket run ${name} is open; while it is, every gate in this repo is armed`;
    const foreign = lib.foreignRunNote(res.status, sessionId, runDir, staleHours);
    if (foreign) return foreign;
    return `ticket run ${name} is open and this session has written to it; resume with /ticket-loop ${name}`;
  });
}

function notice(input) {
  const root = lib.findRepoRoot(input.cwd || process.cwd());
  const runs = lib.activeRuns(root);
  const stale = lib.staleCopies(root);
  if (runs.length === 0 && stale.length === 0) return null;

  const { config } = runs.length ? lib.loadConfig(root) : { config: {} };
  const lines = runLines(root, runs, input.session_id, config.staleRunHours);
  if (stale.length) {
    lines.push(
      `${stale.length} pre-plugin copy(ies) of the ticket-loop hooks are still registered, so they run beside the plugin's:\n` +
        stale.map((s) => `  - ${s.where} (${s.fix})`).join('\n')
    );
  }
  const summary = [
    runs.length ? `${runs.length} open ticket run(s)` : null,
    stale.length ? `${stale.length} stale ticket-loop hook copy(ies)` : null,
  ].filter(Boolean).join(' and ');
  return {
    systemMessage: `ticket-loop: ${summary} in this repo. Details are in the session context; doctor.js lists fixes.`,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `ticket-loop at session start:\n- ${lines.join('\n- ')}` },
  };
}

function main() {
  const input = lib.readStdinJson();
  if (!input) process.exit(0);
  let out = null;
  try {
    out = notice(input);
  } catch (err) {
    console.error(`session_start: could not check this repo (${err.message})`);
  }
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

if (require.main === module) main();
module.exports = { notice };
