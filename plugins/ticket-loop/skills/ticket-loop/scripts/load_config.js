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
    // Trailer appended to every worktree commit, e.g. "Co-Authored-By: ...".
    // null (default) = clean commits with NO AI attribution — the repo owner's
    // policy decides, never the loop.
    commitTrailer: null,
  },
};

const VALID_DESIGN_SOURCES = ['none', 'figma', 'openapi'];
const VALID_TICKET_SOURCES = ['jira', 'github', 'gitlab', 'trello', 'manual'];

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
  cfg._meta = { repoRoot: root, configPath, configFound: fs.existsSync(configPath), warnings };
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
main();
