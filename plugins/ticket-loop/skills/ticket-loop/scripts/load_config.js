#!/usr/bin/env node
// Resolve the per-repo ticket-loop profile (zero deps). Reads
// <repoRoot>/.agents/ticket-loop.config.json, merges over defaults, prints JSON (or --get key).
'use strict';
const fs = require('fs');
const path = require('path');
const { verifyTestWarnings } = require('./verify_falsifiable.js');

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
  // Where installed dependencies live, so a fresh worktree can reuse the main repo's copy
  // instead of installing again. Reuse happens only when `lockfile` is byte-identical in both,
  // so the verified tree is the one this branch actually resolves to. Both null = always
  // install (`node_modules`/`package-lock.json`, `.venv`/`requirements.txt`).
  deps: {
    dir: null,
    lockfile: null,
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
  warnings.push(...verifyTestWarnings(cfg));
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
