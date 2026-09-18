#!/usr/bin/env node
// SubagentStop hook: mark that a dispatched subagent came back.
//
// It records the return, not the result — only the orchestrator can say what a dispatch
// produced. What the mark buys is the distinction the record could not make before: a
// dispatch shown as returned with no outcome is one the orchestrator never accounted for; one
// never returned is a stall or a session that died mid-dispatch.
//
// Always exit 0. The subagent has already stopped, so there is nothing to block, and a return
// that cannot be recorded must not break the session — it surfaces instead as an open dispatch
// at the next dispatch, at the stop gate and at close.
'use strict';
const { spawnSync } = require('child_process');
const lib = require('./hook_lib.js');

const LEDGER_TIMEOUT_MS = 15000;

function recordReturn(input) {
  const root = lib.findRepoRoot(input.cwd || process.cwd());
  const runs = lib.activeRuns(root);
  if (runs.length === 0) return null;
  const ledger = lib.findLedger(root);
  if (!ledger) return 'subagent_return: ledger.js not found — the return was not recorded';

  const args = [ledger, 'returned', runs[0]];
  if (input.agent_id) args.push('--agent', String(input.agent_id));
  if (input.agent_type) args.push('--type', String(input.agent_type));
  if (typeof input.last_assistant_message === 'string') {
    args.push('--message-chars', String(input.last_assistant_message.length));
  }
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: root, timeout: LEDGER_TIMEOUT_MS });
  if (res.error) return `subagent_return: the return was not recorded (${res.error.message})`;
  if (res.status !== 0) return `subagent_return: the return was not recorded: ${(res.stderr || '').trim()}`;
  return null;
}

function main() {
  const input = lib.readStdinJson();
  if (!input) process.exit(0);
  const problem = recordReturn(input);
  if (problem) console.error(problem);
  process.exit(0);
}

if (require.main === module) main();
module.exports = { recordReturn };
