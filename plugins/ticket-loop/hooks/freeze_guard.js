#!/usr/bin/env node
// PreToolUse hook: deny writes to frozen run artifacts and, while a ticket run is active,
// to the enforcement control plane. The decision logic lives in guard_policy.js; this file
// is the I/O shell (read stdin, work out whether a run is active, exit 0 or 2).
//
// Surfaces covered: Edit/Write/NotebookEdit (file_path / notebook_path) and Bash/PowerShell
// (command, default-deny — see guard_policy.js for why the old verb blocklist was replaced).
//
// Residual gaps, stated rather than implied: an agent that can run arbitrary code CAN still
// reach these files (it could read the chain key, or write through a tool surface this hook
// does not see). What changed is that every such route now requires a deliberate, unusual
// command that this hook denies by default, and `ledger.js verify` reports the result as
// TAMPERED afterwards. Enforcement here is tamper-EVIDENT, not tamper-PROOF.
'use strict';
const fs = require('fs');
const path = require('path');
const policy = require('./guard_policy.js');
const lib = require('./hook_lib.js');

const RUNS_REL = path.join('.agents', 'ticket-runs');

// A run is ACTIVE if a run dir has been initialized (budget.json exists) and not yet CLOSED
// (no closed.json). Deliberately a filesystem heuristic and not a require() of the skill's
// chain.js: in the manual install the hooks and scripts land in different trees.
//
// The signal must not be any file the loop writes as ordinary work — report.md as the "run
// is over" marker would make the run's own deliverable the off switch for every gate, so a
// plain Write would release the budget and the control-plane freeze. closed.json is written
// only by `ledger.js close`, which requires a sealed report receipt, and this hook denies
// writes to it.
function activeRuns(root) {
  const runsDir = path.join(root, RUNS_REL);
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.includes('._old_'))
    .map((e) => path.join(runsDir, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'budget.json')) && !fs.existsSync(path.join(dir, 'closed.json')));
}

function deny(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(2);
}

function main() {
  const input = lib.readStdinJson();
  if (!input) process.exit(0); // never let a malformed payload wedge the session
  const toolInput = input.tool_input || {};

  const root = lib.findRepoRoot(input.cwd || process.cwd());
  const runActive = activeRuns(root).length > 0;

  const target = toolInput.file_path || toolInput.notebook_path;
  if (target) {
    const verdict = policy.pathVerdict(target, { runActive });
    if (verdict) deny(`${target} is a ${verdict.reason}.`);
  }

  if (typeof toolInput.command === 'string') {
    const verdict = policy.commandVerdict(toolInput.command, { runActive });
    if (verdict) {
      deny(
        `${verdict.reason}.\n` +
          `  Read-only inspection (cat / git diff / grep) is allowed. Writes go through the harness:\n` +
          `    criteria      -> done-additions.md (additive only)\n` +
          `    counters/gates-> node <scripts>/ledger.js <cmd> <runDir>\n` +
          `    clean restart -> node <scripts>/ledger.js archive <runDir>`
      );
    }
  }

  process.exit(0);
}

if (require.main === module) main();
module.exports = { activeRuns };
