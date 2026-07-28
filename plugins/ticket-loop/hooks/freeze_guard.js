#!/usr/bin/env node
// PreToolUse hook: deny writes to frozen run artifacts — done.md, *.approved.md, and
// budget.json (the script-managed dispatch/replan counters). Two surfaces:
//   - Edit/Write:      tool_input.file_path is checked against the frozen patterns.
//   - Bash/PowerShell: tool_input.command is checked (case-folded — Windows paths are
//     case-insensitive) for (a) a frozen-file reference combined with a write indicator,
//     and (b) delete commands aimed at a run dir — wiping the dir would let ledger.js
//     init restart the budget at zero.
// The harness's own writers (freeze_done.js, ledger.js, validate_done.js) are exempt
// ONLY when they are the entire command — no chaining, no redirection — so a mention in
// a comment or a `&& echo > done.md` tail can't ride the exemption.
//
// Known residual gaps (documented, not silently accepted): a run dir can still be
// MOVED (the sanctioned CLEAN-RESTART archive step needs that), and repo-wide
// destructive commands that never name ticket-runs (e.g. `git clean -fdx`) are not
// caught. Stage 7's tamper check remains the backstop.
'use strict';
const fs = require('fs');

const FROZEN_PATH_PATTERNS = [
  /(^|\/)ticket-runs\/(.+\/)?done\.md$/,
  /(^|\/)ticket-runs\/(.+\/)?budget\.json$/,
  /\.approved\.md$/,
];

// Command-string references to frozen files (matched against the LOWERCASED command).
// done.md / budget.json require a ticket-runs path segment (bare "done.md" elsewhere is
// someone else's file); *.approved.md is distinctive enough on its own.
const FROZEN_REF_PATTERNS = [
  /ticket-runs[\/\\][^\s"']*[\/\\]done\.md/,
  /ticket-runs[\/\\][^\s"']*[\/\\]budget\.json/,
  /[\w.-]+\.approved\.md/,
];

const WRITE_INDICATORS = [
  />/, // covers > and >>
  /\b(rm|unlink|mv|cp|tee|truncate|dd|del|erase|rmdir|rd|shred)\b/,
  /\bsed\b[^|;&]*(\s-[a-z]*i|\s--in-place)/,
  /\bperl\b[^|;&]*\s-[a-z]*i/,
  /\b(set-content|add-content|out-file|remove-item|move-item|copy-item|clear-content|new-item)\b/,
];

// Any reference to a path under ticket-runs/ (run dirs and their contents).
const RUN_DIR_REF = /ticket-runs[\/\\][^\s"']+/;

// Delete-ish verbs: combined with a run-dir reference they can erase budget.json /
// done.approved.md without ever naming them (rm -rf <dir>, del <dir>\*, ...).
const DELETE_VERBS = /\b(rm|rmdir|rd|del|erase|unlink|shred|remove-item)\b/;

// Exemption for the harness's own writers: must be the WHOLE command — starts with
// node, names the script, and contains no chaining/redirection/newlines after it.
const SANCTIONED_COMMAND =
  /^\s*("[^"]*node(\.exe)?"|node(\.exe)?)\s+[^;&|<>\r\n]*\b(freeze_done|validate_done|ledger)\.js\b[^;&|<>\r\n]*$/;

function isFrozenPath(filePath) {
  const p = String(filePath).replace(/\\/g, '/').toLowerCase();
  return FROZEN_PATH_PATTERNS.some((re) => re.test(p));
}

// Returns the offending fragment, or null when the command is fine.
function commandViolation(command) {
  const cmd = String(command).toLowerCase();
  if (SANCTIONED_COMMAND.test(cmd)) return null;

  const refPattern = FROZEN_REF_PATTERNS.find((re) => re.test(cmd));
  if (refPattern && WRITE_INDICATORS.some((re) => re.test(cmd))) {
    return cmd.match(refPattern)[0];
  }

  const dirRef = cmd.match(RUN_DIR_REF);
  if (dirRef && DELETE_VERBS.test(cmd)) return dirRef[0];

  return null;
}

function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const toolInput = (input && input.tool_input) || {};

  if (toolInput.file_path && isFrozenPath(toolInput.file_path)) {
    console.error(
      `BLOCKED: ${toolInput.file_path} is a frozen run artifact. ` +
        `Criteria may be ADDED in done-additions.md; counters change only via ledger.js.`
    );
    process.exit(2);
  }

  if (typeof toolInput.command === 'string') {
    const hit = commandViolation(toolInput.command);
    if (hit) {
      console.error(
        `BLOCKED: this command writes to or deletes a frozen run artifact (${hit}). ` +
          `done.md / *.approved.md are read-only after the freeze (additions go in ` +
          `done-additions.md); budget.json and run dirs change only via ledger.js / ` +
          `the sanctioned archive step.`
      );
      process.exit(2);
    }
  }
  process.exit(0);
}

if (require.main === module) main();
module.exports = { isFrozenPath, commandViolation };
