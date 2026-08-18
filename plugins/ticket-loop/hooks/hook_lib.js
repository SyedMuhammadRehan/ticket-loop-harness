'use strict';
// Shared helpers for the ticket-loop hooks (zero deps). The hooks resolve the SAME
// per-repo profile the skill uses (.agents/ticket-loop.config.json) so enforcement
// follows the config instead of hardcoding a stack.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_REL_PATH = path.join('.agents', 'ticket-loop.config.json');
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
    return { found: true, root, config: JSON.parse(fs.readFileSync(configPath, 'utf8')) };
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
  buildArgv,
  runArgv,
  runShell,
  readStdinJson,
  combinedOutput,
  tail,
};
