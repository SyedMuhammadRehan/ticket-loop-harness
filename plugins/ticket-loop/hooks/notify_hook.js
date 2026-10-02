#!/usr/bin/env node
// Notification and Stop hook: while a ticket run is open, tell the person when the session is
// waiting on them — a permission prompt, a question, or a turn that ended mid-run — so nobody
// walks back to a session that has been frozen for hours while they assumed it was working.
//
// Outside a run it returns at once, like every hook here. It never blocks: the event has
// already happened, and a failed send must not wedge the session.
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./hook_lib.js');

const STATE_FILE = path.join('.claude', 'hooks', 'state', 'notify-state.json');
// A turn ending mid-run fires on every reply; one message per quiet spell is enough.
const STOP_REPEAT_MS = 10 * 60 * 1000;
const SAME_MESSAGE_REPEAT_MS = 2 * 60 * 1000;

let notifyLib = null;
try {
  notifyLib = require(path.join(__dirname, '..', 'skills', 'ticket-loop', 'scripts', 'notify.js'));
} catch {
  notifyLib = null;
}

function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(root, state) {
  try {
    fs.mkdirSync(path.dirname(path.join(root, STATE_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, STATE_FILE), JSON.stringify(state));
  } catch (err) {
    console.error(`notify_hook: could not record what was sent (${err.message}); a repeat may follow`);
  }
}

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

async function main() {
  const input = lib.readStdinJson();
  if (!input || !notifyLib) process.exit(0);
  const root = lib.findRepoRoot(input.cwd || process.cwd());
  const runs = lib.activeRuns(root);
  if (runs.length === 0) process.exit(0);
  const msg = messageFor(input, root, runs);
  if (!msg) process.exit(0);
  const state = readState(root);
  const last = state[msg.key] || 0;
  if (Date.now() - last < msg.repeatMs) process.exit(0);
  const result = await notifyLib.send(msg.text);
  if (result.error) console.error(`notify_hook: ${result.error}`);
  else if (result.sent) writeState(root, { ...state, [msg.key]: Date.now() });
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
