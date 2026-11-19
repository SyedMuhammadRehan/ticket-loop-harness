'use strict';
// A run should start in a session that is not already carrying earlier work. Every later call
// re-sends that context, which makes it the largest cost a run can carry, and everything the run
// needs is in its files. Fresh sessions reached `init` at 78,000–155,000 tokens; one carrying a
// day of other tickets reached it at 378,000.
//
// This is a cost check, not a safety gate: an unreadable log, an unknown size or a malformed
// payload lets the run start.
const fs = require('fs');

const DEFAULT_LIMIT = 200000;
const TAIL_BYTES = 4 * 1024 * 1024;
const RUN_START = /\bledger\.js["']?\s+init\b/;
const KEEP = /--keep-context\b/;

function isRunStart(command) {
  return typeof command === 'string' && RUN_START.test(command) && !KEEP.test(command);
}

// The context the session's latest main-session call carried. Read from the end of the log, so
// a long session costs one bounded read.
function currentContext(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let text;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const usage = entry.type === 'assistant' && !entry.isSidechain && entry.message && entry.message.usage;
    if (!usage) continue;
    return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  }
  return null;
}

function limitOf(config) {
  const v = config && config.maxStartContext;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_LIMIT;
}

// The refusal for a run start in a session over the limit, or null.
function startVerdict(command, transcriptPath, config) {
  if (!isRunStart(command)) return null;
  const limit = limitOf(config);
  if (limit === 0) return null;
  const context = currentContext(transcriptPath);
  if (context === null || context <= limit) return null;
  return (
    `this session already carries ${context.toLocaleString('en-US')} tokens of context from earlier work, ` +
    `over the ${limit.toLocaleString('en-US')} a run starts with (maxStartContext in the profile).\n` +
    `  Every call in the run would re-send it. Stop and tell the person to start a new session (or /clear),\n` +
    `  then run the ticket again there: the run's state lives in its files, so nothing is lost.\n` +
    `  Only if the person says to keep this context: add --keep-context "<their reason>" to the init call.`
  );
}

module.exports = { startVerdict, currentContext, DEFAULT_LIMIT };
