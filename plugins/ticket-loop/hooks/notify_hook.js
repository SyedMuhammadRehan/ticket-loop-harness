#!/usr/bin/env node
// Notification and Stop hook: while a ticket run is open, tell the person when the session is
// waiting on them — a permission prompt, a question, or a turn that ended mid-run — so nobody
// walks back to a session that has been frozen for hours while they assumed it was working.
//
// Outside a run it returns at once, like every hook here. It never blocks: the event has
// already happened, and a failed send must not wedge the session.
'use strict';
const path = require('path');
const lib = require('./hook_lib.js');

// A turn ending mid-run fires on every reply; one message per quiet spell is enough.
const STOP_REPEAT_MS = 10 * 60 * 1000;
const SAME_MESSAGE_REPEAT_MS = 2 * 60 * 1000;


// What to say for this event, or null when it is not worth a message.
function messageFor(input, root, runs) {
  const repo = path.basename(root);
  const run = runs.map((r) => path.basename(r)).join(', ');
  if (input.hook_event_name === 'Notification') {
    const kind = input.notification_type || 'notification';
    if (!/permission_prompt|idle_prompt|agent_needs_input|elicitation_dialog/.test(kind)) return null;
    const what = kind === 'permission_prompt' ? 'is waiting for a permission' : 'is waiting for you';
    return { key: `n:${input.message || kind}`, repeatMs: SAME_MESSAGE_REPEAT_MS, text: `ticket-loop ${run} in ${repo} ${what}: ${input.message || kind}` };
  }
  if (input.hook_event_name === 'Stop') {
    return { key: 'stop', repeatMs: STOP_REPEAT_MS, text: `ticket-loop ${run} in ${repo}: the session stopped and the run is still open. Open it to see what it needs, or reply on a channel it asked you on.` };
  }
  return null;
}

function agentsWorking(root, runs) {
  const ledger = lib.findLedger(root);
  if (!ledger) return false;
  return runs.some((runDir) => {
    const { status } = lib.runStatus(ledger, runDir, root, 10000);
    return !!status && status.open.some((o) => !o.stalled);
  });
}

async function main() {
  const input = lib.readStdinJson();
  if (!input) process.exit(0);
  const root = lib.findRepoRoot(input.cwd || process.cwd());
  const runs = lib.activeRuns(root);
  if (runs.length === 0) process.exit(0);
  const msg = messageFor(input, root, runs);
  if (!msg) process.exit(0);
  // A turn that ends while the run's own agents are still working is waiting on them, not on you.
  if (input.hook_event_name === 'Stop' && agentsWorking(root, runs)) process.exit(0);
  const result = await lib.notifyOnce(root, msg.key, msg.repeatMs, msg.text);
  if (result.error) console.error(`notify_hook: ${result.error}`);
  if (result.stateError) console.error(`notify_hook: could not record what was sent (${result.stateError}); a repeat may follow`);
  for (const r of result.results || []) if (!r.ok) console.error(`notify_hook: ${r.type} failed (${r.error})`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`notify_hook: ${err.message}`);
    process.exit(0);
  });
}
module.exports = { messageFor };
