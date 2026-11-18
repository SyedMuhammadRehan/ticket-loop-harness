'use strict';
// What a run cost, read from Claude Code's own session logs rather than from figures the
// orchestrator types: every model call the run's sessions made inside the run's window.
//
// One reply is logged as one line per content block, each carrying the reply's whole usage, so a
// call is counted once by its message id. Context per call is everything sent in (fresh, cached
// and newly cached input); it is what a long-lived session pays again on every turn.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

function projectsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// A session's log sits in the folder of the directory it was started in, which need not be the repo.
function logsOf(sessionId, configDir) {
  const root = path.join(configDir, 'projects');
  for (const project of listDir(root)) {
    const main = path.join(root, project, `${sessionId}.jsonl`);
    if (!fs.existsSync(main)) continue;
    const agentDir = path.join(root, project, sessionId, 'subagents');
    return { main, agents: listDir(agentDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(agentDir, f)) };
  }
  return null;
}

function emptyTally() {
  return { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, contextAvg: 0, contextMax: 0, total: 0 };
}

function tally(files, from, to) {
  const calls = new Map();
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = entry.type === 'assistant' && entry.message && entry.message.usage;
      const at = Date.parse(entry.timestamp);
      if (!usage || !(at >= from && at <= to)) continue;
      calls.set(`${file}|${entry.message.id || entry.uuid}`, usage);
    }
  }
  const t = emptyTally();
  for (const u of calls.values()) {
    const input = u.input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const cacheWrite = u.cache_creation_input_tokens || 0;
    const context = input + cacheRead + cacheWrite;
    t.calls++;
    t.input += input;
    t.cacheRead += cacheRead;
    t.cacheWrite += cacheWrite;
    t.output += u.output_tokens || 0;
    t.contextMax = Math.max(t.contextMax, context);
    t.total += context + (u.output_tokens || 0);
  }
  t.contextAvg = t.calls ? Math.round((t.input + t.cacheRead + t.cacheWrite) / t.calls) : 0;
  return t;
}

// sessions: ids sealed in the run's chain. window: { from, to } as ISO times.
function usageOf(sessions, window, configDir = path.dirname(projectsDir())) {
  const from = Date.parse(window.from);
  const to = window.to ? Date.parse(window.to) : Date.now();
  const missing = [];
  const main = [];
  const agents = [];
  for (const id of sessions) {
    const logs = SESSION_ID.test(String(id)) ? logsOf(id, configDir) : null;
    if (!logs) {
      missing.push(id);
      continue;
    }
    main.push(logs.main);
    agents.push(...logs.agents);
  }
  return { window: { from: window.from, to: window.to || null }, missing, main: tally(main, from, to), agents: tally(agents, from, to) };
}

module.exports = { usageOf, projectsDir };
