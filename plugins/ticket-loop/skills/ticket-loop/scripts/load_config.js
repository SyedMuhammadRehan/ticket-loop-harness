#!/usr/bin/env node
// Resolve the per-repo ticket-loop profile (zero deps). Reads
// <repoRoot>/.agents/ticket-loop.config.json, merges over defaults, prints JSON (or --get key).
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  stack: 'unknown',
  ticketSource: 'manual', // jira | github | gitlab | trello | manual
  designSource: 'none', // none | figma | openapi
  verify: {
    analyze: null,
    test: null,
    pubGet: null,
    codegen: null,
  },
  riskPaths: [],
  worktreePrefix: '../ticket-',
  buildResolverAgent: null,
  memoryFile: null,
  attribution: {
    // Commit trailer for repos that require AI disclosure; null = clean commits.
    commitTrailer: null,
  },
  // Model per dispatch role; 'inherit' = the session model.
  models: {
    survey: 'inherit',
    implementer: 'inherit',
    fixer: 'inherit',
    qa: 'inherit',
  },
  // Changed-line count at or under which the QA judge reads focused; 0 = always sweep.
  qaScope: {
    smallDiffLines: 60,
  },
  // A dispatch costs its whole prompt before it does any work, so small jobs are cheaper
  // done inline. Both are advisory to the orchestrator and reported afterwards, not enforced
  // at the dispatch — nothing at that moment can know how large the change will turn out.
  dispatchPolicy: {
    minSliceLines: 50,
    promptBudgetChars: 32000,
  },
};

const VALID_DESIGN_SOURCES = ['none', 'figma', 'openapi'];
const VALID_TICKET_SOURCES = ['jira', 'github', 'gitlab', 'trello', 'manual'];
const MODEL_ROLES = Object.keys(DEFAULTS.models);

// A skill binds at session start; the hooks reload from disk on every call. So after a
// `plugin update` a session can run an old playbook against new enforcement, which fails late
// and reads as a harness bug. Compare this file's own plugin version against the newest one
// installed beside it. Silent outside the versioned cache layout (a checkout has no siblings).
function pluginVersionSkew() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const manifest = [path.join(dir, 'plugin.json'), path.join(dir, '.claude-plugin', 'plugin.json')].find((p) =>
      fs.existsSync(p)
    );
    if (manifest) {
      try {
        const running = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
        if (!running) return null;
        const parts = (v) => v.split('.').map(Number);
        const newer = (a, b) => {
          const [x, y] = [parts(a), parts(b)];
          for (let k = 0; k < 3; k++) if ((x[k] || 0) !== (y[k] || 0)) return (x[k] || 0) > (y[k] || 0);
          return false;
        };
        const siblings = fs
          .readdirSync(path.dirname(dir), { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name) && newer(d.name, running))
          .map((d) => d.name);
        return { running, newest: siblings.sort((a, b) => (newer(a, b) ? 1 : -1)).pop() || null };
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Preflight for the stop gate's own parameters, all of which are only fixable BEFORE a run
// starts: mid-run, stop_gate blocks every turn-end without a usable block and freeze_guard
// holds this file frozen, so the only exit is archiving the run.
function stopGateWarnings(cfg) {
  const sg = cfg.hooks && cfg.hooks.stopGate;
  if (!sg || typeof sg !== 'object') {
    return [
      'no hooks.stopGate block — while a run is active the stop gate refuses every turn-end ' +
        'without one, and the profile is frozen for that window, so the run would have to be ' +
        'archived to add it. Add the block now, before starting.',
    ];
  }
  const warnings = [];
  if (!Array.isArray(sg.extensions) || sg.extensions.length === 0) {
    warnings.push(
      'hooks.stopGate.extensions is empty — no changed file can match it, so every turn-end ' +
        'reports "NOTHING was verified" while looking configured.'
    );
  }
  if ((sg.mode || 'full') === 'targeted' && !sg.testCommand) {
    warnings.push('hooks.stopGate.mode is "targeted" but there is no hooks.stopGate.testCommand — nothing would ever run.');
  }
  if ((sg.mode || 'full') === 'full' && !(cfg.verify && cfg.verify.test)) {
    warnings.push('hooks.stopGate.mode is "full" but verify.test is null — the gate has no suite to run.');
  }
  if (sg.exclude) {
    try {
      new RegExp(sg.exclude);
    } catch (e) {
      // stop_gate drops an unparsable exclude and filters nothing, so a typo silently widens
      // what gets tested.
      warnings.push(`hooks.stopGate.exclude is not a valid regex (${e.message}) — it would be ignored, excluding nothing.`);
    }
  }
  return warnings;
}

// --- verify.test falsifiability -------------------------------------------------------

// The stop gate's verdict is exactly this command's exit code, so a command that cannot exit
// non-zero certifies every turn-end while proving nothing. Detection inspects; it never runs
// the configured command, because that would make every profile load execute repo-supplied
// shell. Inspection is therefore a heuristic, and every rule here stays silent when it cannot
// tell — a warning nobody believes is worse than no warning.
const ENTRYPOINT_READ_LIMIT = 256 * 1024;
const TEST_FILE_SCAN_LIMIT = 200;
const MAX_SCAN_DEPTH = 6;
const FILTER_FLAGS = ['--test-name-pattern', '--grep', '--filter', '--name', '-k', '-run'];
const TEST_NAME_FORMS = [
  /\b(?:test|it)\s*\(\s*['"`]([^'"`]+)/g,
  /^[ \t]*def[ \t]+(test_\w+)/gm,
  /^[ \t]*func[ \t]+(Test\w+)/gm,
];
const ENV_REF_FORMS = [
  /process\.env(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\])/g,
  /os\.environ(?:\.get\(\s*['"](\w+)['"]|\[\s*['"](\w+)['"]\s*\])/g,
];
const ZERO_EXIT = /(?:process|sys|os)\.exit\s*\(\s*0\s*\)/g;
// How far back from an exit(0) an env reference still plausibly guards it.
const GUARD_WINDOW = 200;

function readCapped(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > ENTRYPOINT_READ_LIMIT) return null;
  return fs.readFileSync(file, 'utf8');
}

function tokenize(cmd) {
  return cmd.split(/\s+/).filter(Boolean);
}

// The first token naming a file that actually exists under the repo: the script whose exit
// code the command reports.
function entrypointOf(tokens, root) {
  for (const tok of tokens.slice(1)) {
    const bare = tok.replace(/^['"]|['"]$/g, '');
    if (!bare || bare.startsWith('-') || !/\.\w+$/.test(bare)) continue;
    const abs = path.resolve(root, bare);
    const inside = path.relative(root, abs);
    if (inside && !inside.startsWith('..') && !path.isAbsolute(inside) && fs.existsSync(abs)) {
      return { rel: bare, abs };
    }
  }
  return null;
}

function filterOf(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    for (const flag of FILTER_FLAGS) {
      if (tok === flag && tokens[i + 1] && !tokens[i + 1].startsWith('-')) {
        return { flag, value: tokens[i + 1] };
      }
      if (tok.startsWith(`${flag}=`)) return { flag, value: tok.slice(flag.length + 1) };
    }
  }
  return null;
}

function collectTestNames(dir, names, budget, depth = 0) {
  let scanned = budget;
  if (depth > MAX_SCAN_DEPTH) return scanned;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return scanned;
  }
  for (const entry of entries) {
    if (scanned <= 0) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      // Directories count against the same budget as files: bounding only the files read
      // still lets a wide tree cost a full walk on every profile load.
      scanned = collectTestNames(full, names, scanned - 1, depth + 1);
      continue;
    }
    if (!/[._](test|spec)\.\w+$|^test_\w+\.\w+$/i.test(entry.name)) continue;
    scanned--;
    let src;
    try {
      src = readCapped(full);
    } catch {
      continue;
    }
    if (!src) continue;
    for (const form of TEST_NAME_FORMS) {
      form.lastIndex = 0;
      let m;
      while ((m = form.exec(src))) names.add(m[1]);
    }
  }
  return scanned;
}

function matchesSomeTest(pattern, names) {
  let re = null;
  try {
    re = new RegExp(pattern);
  } catch {
    // An unparsable pattern is still a literal the runner may match on.
  }
  for (const name of names) {
    if (name.includes(pattern) || (re && re.test(name))) return true;
  }
  return false;
}

// An env var read just before an exit(0) is the classic self-disabling suite: green in CI
// where it is set, green-and-empty everywhere else. Only the environment preflight can
// actually observe decides it.
function unsetGuardOf(src) {
  ZERO_EXIT.lastIndex = 0;
  let exitMatch;
  while ((exitMatch = ZERO_EXIT.exec(src))) {
    // Only the statement the exit sits in can be its guard. A reference merely NEARBY —
    // `const level = process.env.LOG_LEVEL || 'info'` a line above an ordinary
    // `if (failures === 0) exit(0)` — reads as a guard and is not one, and this warning
    // states what it found as fact.
    const from = Math.max(0, exitMatch.index - GUARD_WINDOW);
    const preceding = src.slice(from, exitMatch.index);
    const window = preceding.slice(Math.max(...[';', '{', '}'].map((c) => preceding.lastIndexOf(c) + 1)));
    let nearest = null;
    for (const form of ENV_REF_FORMS) {
      form.lastIndex = 0;
      let m;
      while ((m = form.exec(window))) nearest = m[1] || m[2];
    }
    if (nearest && process.env[nearest] === undefined) return nearest;
  }
  return null;
}

// A right-hand side that succeeds no matter what the left-hand side did.
const ALWAYS_TRUE = /^(?:true|:|exit\s+0|echo\b[^;&|]*)$/;
// Per binary, because the same letters mean unrelated things elsewhere: -p is pytest's
// plugin flag and Go's parallelism flag, -e is Maven's error flag and RSpec's example filter.
const INLINE_EVAL_FLAGS = {
  node: ['-e', '--eval', '-p', '--print'],
  ruby: ['-e'],
  perl: ['-e'],
  python: ['-c'],
  python3: ['-c'],
  sh: ['-c'],
  bash: ['-c'],
  zsh: ['-c'],
};

// The exit code the shell finally reports is not the suite's.
function discardedExitCode(cmd) {
  const alternatives = cmd.split(/\|\|/).slice(1);
  for (const alt of alternatives) {
    const tail = alt.trim().replace(/;+$/, '');
    if (ALWAYS_TRUE.test(tail)) {
      return `the "|| ${tail}" tail succeeds whatever the suite did, so the command exits 0 either way`;
    }
  }
  // `&&` is not a separator here: the suite failing stops the tail from running at all.
  const last = cmd.split(/;|(?<!&)&(?!&)/).map((s) => s.trim()).filter(Boolean).pop();
  if (last && /^exit\s+0$/.test(last)) {
    return `it ends in an unconditional "${last}", which replaces the suite's exit code with 0`;
  }
  return null;
}

// A one-liner supplied on the command line is not the repo's suite, whatever it returns.
function inlineProgram(tokens) {
  const binary = path.basename(tokens[0] || '').replace(/\.exe$/i, '');
  const flags = INLINE_EVAL_FLAGS[binary];
  if (!flags) return null;
  for (const tok of tokens.slice(1)) {
    if (flags.includes(tok)) {
      return `it runs an inline program given with ${tok}, not the repo's tests — nothing in the repo can turn it red`;
    }
  }
  return null;
}

function verifyTestWarnings(cfg, root) {
  const cmd = cfg.verify && cfg.verify.test;
  if (typeof cmd !== 'string' || !cmd.trim()) return [];
  try {
    const tokens = tokenize(cmd);
    const entrypoint = entrypointOf(tokens, root);
    const reason =
      discardedExitCode(cmd) ||
      inlineProgram(tokens) ||
      emptyFilter(tokens, entrypoint, root) ||
      selfDisablingEntrypoint(entrypoint);
    return reason ? [`verify.test "${cmd}" cannot report a failure — ${reason}`] : [];
  } catch {
    // Preflight resolves the profile for every hook; a detector that throws would take all of
    // them down over an advisory warning.
    return [];
  }
}

function emptyFilter(tokens, entrypoint, root) {
  const filter = filterOf(tokens);
  if (!filter) return null;
  const names = new Set();
  const searchDir = entrypoint ? path.dirname(entrypoint.abs) : root;
  collectTestNames(searchDir, names, TEST_FILE_SCAN_LIMIT);
  if (names.size === 0 || matchesSomeTest(filter.value, names)) return null;
  return (
    `${filter.flag} selects "${filter.value}", which matches no test declared under ` +
    `${path.relative(root, searchDir) || '.'} — the command runs an empty suite and exits 0`
  );
}

function selfDisablingEntrypoint(entrypoint) {
  if (!entrypoint) return null;
  const src = readCapped(entrypoint.abs);
  const guard = src && unsetGuardOf(src);
  if (!guard) return null;
  return (
    `${entrypoint.rel} exits 0 early when $${guard} is unset, and $${guard} is unset now — ` +
    `the command reports success without running the suite`
  );
}

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function deepMerge(base, over) {
  if (over == null) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    const b = base ? base[k] : undefined;
    const o = over[k];
    out[k] =
      o && typeof o === 'object' && !Array.isArray(o) && b && typeof b === 'object'
        ? deepMerge(b, o)
        : o;
  }
  return out;
}

function resolve() {
  const root = findRepoRoot(process.cwd());
  const configPath = path.join(root, '.agents', 'ticket-loop.config.json');
  const warnings = [];
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      warnings.push(`config parse error at ${configPath}: ${e.message} — using defaults`);
    }
  } else {
    warnings.push(
      `no .agents/ticket-loop.config.json found — using conservative defaults ` +
        `(designSource=none, no verify commands). Add a config to enable a stack.`
    );
  }
  const cfg = deepMerge(DEFAULTS, userConfig);

  if (!VALID_TICKET_SOURCES.includes(cfg.ticketSource)) {
    warnings.push(
      `invalid ticketSource "${cfg.ticketSource}" — must be one of ${VALID_TICKET_SOURCES.join(', ')}; forcing "manual"`
    );
    cfg.ticketSource = 'manual';
  }
  if (!VALID_DESIGN_SOURCES.includes(cfg.designSource)) {
    warnings.push(
      `invalid designSource "${cfg.designSource}" — must be one of ${VALID_DESIGN_SOURCES.join(', ')}; forcing "none"`
    );
    cfg.designSource = 'none';
  }
  if (!cfg.verify || cfg.verify.test == null) {
    warnings.push('no verify.test command configured — Stage 5 cannot run the suite; skill must ask.');
  }
  for (const role of Object.keys(cfg.models)) {
    if (!MODEL_ROLES.includes(role)) {
      warnings.push(`unknown models role "${role}" — ignored (valid: ${MODEL_ROLES.join(', ')})`);
      delete cfg.models[role];
    } else if (typeof cfg.models[role] !== 'string' || !cfg.models[role].trim()) {
      warnings.push(`invalid models.${role} — must be a model name or "inherit"; forcing "inherit"`);
      cfg.models[role] = 'inherit';
    }
  }
  if (!Number.isInteger(cfg.qaScope.smallDiffLines) || cfg.qaScope.smallDiffLines < 0) {
    warnings.push(
      `invalid qaScope.smallDiffLines "${cfg.qaScope.smallDiffLines}" — must be an integer >= 0; forcing ${DEFAULTS.qaScope.smallDiffLines}`
    );
    cfg.qaScope.smallDiffLines = DEFAULTS.qaScope.smallDiffLines;
  }
  for (const [key, min] of [['minSliceLines', 0], ['promptBudgetChars', 1]]) {
    const v = cfg.dispatchPolicy[key];
    if (!Number.isInteger(v) || v < min) {
      warnings.push(`invalid dispatchPolicy.${key} "${v}" — must be an integer >= ${min}; forcing ${DEFAULTS.dispatchPolicy[key]}`);
      cfg.dispatchPolicy[key] = DEFAULTS.dispatchPolicy[key];
    }
  }
  warnings.push(...stopGateWarnings(cfg));
  warnings.push(...verifyTestWarnings(cfg, root));
  const skew = pluginVersionSkew();
  if (skew && skew.newest) {
    warnings.push(
      `STALE SKILL: this playbook is v${skew.running} but v${skew.newest} is installed. Skills bind ` +
        `at session start, so an update mid-session leaves the playbook old while the hooks run new — ` +
        `the run will fail late in ways that look like harness bugs. STOP and start a new session.`
    );
  }
  cfg._meta = {
    repoRoot: root,
    configPath,
    configFound: fs.existsSync(configPath),
    skillVersion: skew ? skew.running : null,
    newerVersionInstalled: skew ? skew.newest : null,
    warnings,
  };
  return cfg;
}

function main() {
  const cfg = resolve();
  const getIdx = process.argv.indexOf('--get');
  if (getIdx !== -1 && process.argv[getIdx + 1]) {
    const val = process.argv[getIdx + 1]
      .split('.')
      .reduce((o, k) => (o == null ? undefined : o[k]), cfg);
    process.stdout.write(val == null ? '' : typeof val === 'string' ? val : JSON.stringify(val));
    process.stdout.write('\n');
    return;
  }
  process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
}

if (require.main === module) main();
module.exports = { resolve, DEFAULTS, findRepoRoot, deepMerge };
