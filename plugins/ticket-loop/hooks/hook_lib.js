'use strict';
// Shared helpers for the ticket-loop hooks (zero deps). The hooks resolve the SAME
// per-repo profile the skill uses (.agents/ticket-loop.config.json) so enforcement
// follows the config instead of hardcoding a stack.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_REL_PATH = path.join('.agents', 'ticket-loop.config.json');
const RUNS_REL = path.join('.agents', 'ticket-runs');
// The org policy ships beside the skill in the plugin layout; a hand-copied hook set has no policy.
let policyLib = null;
try {
  policyLib = require(path.join(__dirname, '..', 'skills', 'ticket-loop', 'scripts', 'policy.js'));
} catch {
  policyLib = null;
}
const LEDGER_REL = path.join('skills', 'ticket-loop', 'scripts', 'ledger.js');
const MAX_ROOT_SEARCH_DEPTH = 8;
const DEFAULT_TIMEOUT_MS = 120000;

// cmd.exe metacharacters that make the win32 shell fallback unsafe to attempt.
const WIN_SHELL_UNSAFE = /[&|<>^"%]/;

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < MAX_ROOT_SEARCH_DEPTH; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

// Returns { found, root, config, error? }. A missing or unparsable config means the
// hooks stay inert — the skill (not the hooks) owns telling the user to add one.
function loadConfig(startDir) {
  const root = findRepoRoot(startDir || process.cwd());
  const configPath = path.join(root, CONFIG_REL_PATH);
  if (!fs.existsSync(configPath)) return { found: false, root, config: {} };
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { found: true, root, config: policyLib ? policyLib.applyPolicy(config, policyLib.readPolicy()).cfg : config };
  } catch (e) {
    return { found: false, root, config: {}, error: `config parse error: ${e.message}` };
  }
}

// Expand a command template ("npx eslint {file}") into argv. Placeholders must be
// whole whitespace-separated tokens; an array value expands to multiple argv entries.
// Templates are repo-owned config (trusted); substitutions may be tool input (not).
function buildArgv(template, subs) {
  const out = [];
  for (const tok of String(template).trim().split(/\s+/)) {
    if (subs && Object.prototype.hasOwnProperty.call(subs, tok)) {
      const v = subs[tok];
      if (Array.isArray(v)) out.push(...v);
      else out.push(String(v));
    } else {
      out.push(tok);
    }
  }
  return out;
}

// Spawn argv without a shell. On Windows, .bat/.cmd launchers (npx, flutter, gradlew) throw
// EINVAL on shell-less spawns, so retry via shell with pre-quoted args — but ONLY when
// no arg carries cmd.exe metacharacters (substituted args can be tool input).
function runArgv(argv, opts = {}) {
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const [cmd, ...args] = argv;
  let res = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, timeout });
  const retriable = res.error && ['EINVAL', 'ENOENT'].includes(res.error.code);
  if (retriable && process.platform === 'win32') {
    const unsafe = argv.find((a) => WIN_SHELL_UNSAFE.test(a));
    if (unsafe) {
      return { error: new Error(`refusing win32 shell fallback: unsafe characters in "${unsafe}"`) };
    }
    const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
    res = spawnSync(cmd, quoted, { encoding: 'utf8', cwd: opts.cwd, timeout, shell: true });
  }
  return res;
}

// Run a repo-owned verify command string (may contain &&, ./..., etc) through the
// shell. NEVER interpolate tool input into these — config strings only.
function runShell(command, opts = {}) {
  return spawnSync(command, {
    encoding: 'utf8',
    cwd: opts.cwd,
    timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    shell: true,
  });
}

// Active = initialized (budget.json) and not yet CLOSED (no closed.json, which only
// `ledger.js close` writes, and only against a sealed report receipt). Newest first, so a
// stale run dir left lying around never shadows the one in flight.
//
// Reading report.md as "the run is over" is what let an orchestrator at the cap write one
// unprotected file and carry on dispatching, uncounted.
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
    .filter((dir) => fs.existsSync(path.join(dir, 'budget.json')) && !fs.existsSync(path.join(dir, 'closed.json')))
    .map((dir) => ({ dir, mtime: fs.statSync(dir).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((r) => r.dir);
}

// Search the install layouts in order of specificity: plugin root, project-local skill,
// user-level skill, then relative to this hooks dir (repo checkout / manual copy).
function findLedger(root) {
  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT && path.join(process.env.CLAUDE_PLUGIN_ROOT, LEDGER_REL),
    path.join(root, '.claude', LEDGER_REL),
    path.join(os.homedir(), '.claude', LEDGER_REL),
    path.join(root, '.claude', 'skills', 'ticket-loop', 'scripts', 'ledger.js'),
    path.join(__dirname, '..', LEDGER_REL),
    path.join(__dirname, '..', 'skills', 'ticket-loop', 'scripts', 'ledger.js'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// The run's counters from `ledger.js status`. Callers decide what an unreadable status means
// for them; here it is reported, never swallowed.
function runStatus(ledger, runDir, cwd, timeoutMs) {
  const res = spawnSync(process.execPath, [ledger, 'status', runDir], { encoding: 'utf8', cwd, timeout: timeoutMs });
  if (res.error) return { error: res.error.message };
  if (res.status !== 0) return { error: (res.stderr || '').trim() || `ledger.js status exited ${res.status}`, stderr: res.stderr || '' };
  try {
    const status = JSON.parse(res.stdout);
    return { status: { ...status, open: status.open || [], sessions: status.sessions || [] } };
  } catch (e) {
    return { error: `ledger.js status returned unreadable JSON (${e.message})` };
  }
}

// A run this session has never written to, from a status. Null when it is this session's own,
// or when nothing has been written yet for anyone to own.
function foreignRunNote(status, sessionId, runDir, staleHours) {
  if (!sessionId || status.sessions.length === 0 || status.sessions.includes(sessionId)) return null;
  const idle = status.idleMinutes == null ? 'an unknown time' : status.idleMinutes >= 120 ? `${Math.round(status.idleMinutes / 60)} h` : `${status.idleMinutes} min`;
  const stale = Number.isInteger(staleHours) && status.idleMinutes != null && status.idleMinutes >= staleHours * 60;
  return (
    `run ${path.basename(runDir)} was started by another session and this one has not touched it; last activity ${idle} ago` +
    `${stale ? ' — ABANDONED by the profile\'s staleRunHours' : ''}. While it is open it arms every gate in this repo. ` +
    `Finish it with /ticket-loop ${path.basename(runDir)}, or end it: ledger.js archive ${runDir}`
  );
}

function describeOpenDispatch(o) {
  const state = o.stalled
    ? `no outcome and no sign of life for ${o.minutesQuiet} min — STALLED`
    : `still out (${o.minutesOpen} min), no outcome yet`;
  return `seq ${o.seqs[0]} (${o.label || 'unlabelled'}): ${state}`;
}

// File names this plugin ships as hooks. A copy of one under a repo's own `.claude/hooks/`, or a
// settings entry that runs one from there, is a pre-plugin install still registered beside the
// plugin, so every edit and every stop runs both.
const HARNESS_HOOK_FILES = [
  'stop_gate.js', 'freeze_guard.js', 'dispatch_guard.js', 'post_edit.js', 'dart_post_edit.js',
  'read_hint.js', 'subagent_return.js', 'session_start.js', 'notify_hook.js', 'guard_policy.js', 'hook_lib.js', 'hygiene.js',
];

function settingsHookCommands(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const out = [];
  for (const groups of Object.values((parsed && parsed.hooks) || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const h of (group && group.hooks) || []) if (h && typeof h.command === 'string') out.push(h.command);
    }
  }
  return out;
}

// Each stale copy found, with where it is and how to remove it. The plugin cache is never one.
function staleCopies(root, home = os.homedir()) {
  const found = [];
  const hooksDir = path.join(root, '.claude', 'hooks');
  for (const name of HARNESS_HOOK_FILES) {
    if (fs.existsSync(path.join(hooksDir, name))) {
      found.push({ where: path.join(hooksDir, name), fix: `delete it; the plugin ships ${name}` });
    }
  }
  for (const base of [root, home]) {
    const skill = path.join(base, '.claude', 'skills', 'ticket-loop');
    if (fs.existsSync(path.join(skill, 'SKILL.md'))) {
      found.push({ where: skill, fix: 'delete the folder; the plugin ships the skill, and a copy shadows it' });
    }
  }
  const files = HARNESS_HOOK_FILES.map((n) => n.replace('.', '\\.')).join('|');
  const names = new RegExp(String.raw`(^|[\\/\s"'])(` + files + String.raw`)\b|skills[\\/]ticket-loop[\\/]`);
  const settingsFiles = [
    path.join(root, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.local.json'),
    path.join(home, '.claude', 'settings.json'),
  ];
  for (const file of settingsFiles) {
    for (const command of settingsHookCommands(file)) {
      if (names.test(command) && !/plugins[\\/]cache|CLAUDE_PLUGIN_ROOT/.test(command)) {
        found.push({ where: `${file}: ${command}`, fix: 'remove this hook entry; the plugin registers its own' });
      }
    }
  }
  return found;
}

const NOTIFY_STATE = path.join('.claude', 'hooks', 'state', 'notify-state.json');
let notifyLib;

// Send through the person's notify channels unless the same key was sent within repeatMs. Never
// throws: a hook that cannot notify still has to do its own job.
async function notifyOnce(root, key, repeatMs, text) {
  if (notifyLib === undefined) {
    try {
      notifyLib = require(path.join(__dirname, '..', 'skills', 'ticket-loop', 'scripts', 'notify.js'));
    } catch {
      notifyLib = null;
    }
  }
  if (!notifyLib) return { sent: 0, note: 'notify.js is not beside these hooks' };
  const file = path.join(root, NOTIFY_STATE);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    state = {};
  }
  if (Date.now() - (state[key] || 0) < repeatMs) return { sent: 0, note: 'sent recently' };
  let result;
  try {
    result = await notifyLib.send(text);
  } catch (err) {
    return { sent: 0, error: err.message };
  }
  if (result.sent) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...state, [key]: Date.now() }));
    } catch (err) {
      result.stateError = err.message;
    }
  }
  return result;
}

function readStdinJson() {
  try {
    let raw = fs.readFileSync(0, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function combinedOutput(res) {
  return `${res.stdout || ''}\n${res.stderr || ''}`;
}

function tail(text, lines) {
  return text.split('\n').slice(-lines).join('\n');
}

module.exports = {
  CONFIG_REL_PATH,
  findRepoRoot,
  loadConfig,
  activeRuns,
  findLedger,
  runStatus,
  notifyOnce,
  staleCopies,
  HARNESS_HOOK_FILES,
  foreignRunNote,
  describeOpenDispatch,
  buildArgv,
  runArgv,
  runShell,
  readStdinJson,
  combinedOutput,
  tail,
};
