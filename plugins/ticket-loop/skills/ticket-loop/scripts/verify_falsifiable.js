'use strict';
// Can the profile's verify.test command report a failure at all? The stop gate's verdict is
// exactly that command's exit code, so one that cannot exit non-zero certifies every
// turn-end while proving nothing.
//
// Every rule here asks "can I prove no red path exists?" and stays silent otherwise. The
// complementary question — "can I find evidence this cannot fail?" — reads the same and is
// not: its false-positive surface is unbounded, and an advisory warning is worth nothing to a
// reader who has learned to ignore it. A miss costs that reader nothing.
//
// Inspection only. Running the configured command to find out would make every profile load
// execute repo-supplied shell.
const fs = require('fs');
const path = require('path');

const ENTRYPOINT_READ_LIMIT = 256 * 1024;
const TEST_FILE_SCAN_LIMIT = 200;
const TOTAL_READ_LIMIT = 4 * 1024 * 1024;
const MAX_SCAN_DEPTH = 6;
const GUARD_WINDOW = 200;

// The one filter flag whose match surface can be reconstructed from source. pytest's -k and
// go's -run also select on classes, modules and subtest paths, so any verdict about them
// would be a guess about another runner's semantics.
const FILTER_FLAGS = ['--test-name-pattern'];
const TEST_NAME_FORMS = [/\b(?:test|it|describe)\s*\(\s*['"`]([^'"`]+)/g];
const SELECTION_EXPRESSION = /\s|\b(?:and|or|not)\b/;

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
const ALWAYS_TRUE = /^(?:true|:|exit\s+0|echo\b[^;&|]*)$/;
const CONSTANT_SUCCESS =
  /^\s*(?:true|:|pass|exit\s+0|(?:process|sys|os)\.exit\s*\(\s*0\s*\)|exit\s*\(\s*0\s*\))\s*;?\s*$/;

const ZERO_EXIT = /(?:process|sys|os)\.exit\s*\(\s*0\s*\)/g;
// Any one of these means the file can end non-zero, and then nothing about it is
// unfalsifiable however its environment reads look.
const RED_PATHS = [
  /(?:process|sys|os)\.exit\s*\(\s*(?!0\s*\))/,
  /\bthrow\b/,
  /\braise\b/,
  /process\.exitCode\s*=/,
];
const ENV_REF_FORMS = [
  /process\.env(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\])/g,
  /os\.environ(?:\.get\(\s*['"](\w+)['"]|\[\s*['"](\w+)['"]\s*\])/g,
];
const ENV_BINDING = /(?:const|let|var)\s+(\w+)\s*=\s*(?:process\.env\.(\w+)|os\.environ\.get\(\s*['"](\w+)['"])/g;
const CONDITIONAL = /\b(?:if|elif|unless)\b/g;

function readCapped(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > ENTRYPOINT_READ_LIMIT) return null;
  return fs.readFileSync(file, 'utf8');
}

// Quote-aware: splitting on whitespace turns `-k "not slow"` into the token `"not`, and a
// rule that then reports "matches no test" is reporting its own parse.
function tokenize(cmd) {
  const tokens = [];
  const token = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = token.exec(cmd))) {
    tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return tokens;
}

function stripQuotes(value) {
  return value.replace(/^["']|["']$/g, '');
}

// The first token naming a file that exists inside the repo: the script whose exit code the
// command reports.
function entrypointOf(tokens, root) {
  for (const bare of tokens.slice(1)) {
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
        return { flag, value: stripQuotes(tokens[i + 1]) };
      }
      if (tok.startsWith(`${flag}=`)) return { flag, value: stripQuotes(tok.slice(flag.length + 1)) };
    }
  }
  return null;
}

// Bounded, and it records when a bound cut the walk short: a partial name set cannot tell a
// filter that matches nothing from one whose test was never reached.
function collectTestNames(dir, names, scan, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) {
    scan.truncated = true;
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory contributes no names; the caller's truncation check decides
    // what that silence means.
    return;
  }
  for (const entry of entries) {
    if (scan.budget <= 0 || scan.bytes <= 0) {
      scan.truncated = true;
      return;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      // Directories spend the budget too; bounding only the files read still lets a wide
      // tree cost a full walk on every profile load.
      scan.budget--;
      collectTestNames(full, names, scan, depth + 1);
      continue;
    }
    if (!/[._](test|spec)\.\w+$/i.test(entry.name)) continue;
    scan.budget--;
    let src;
    try {
      src = readCapped(full);
    } catch {
      // A file that cannot be read contributes no names, same as one that holds none.
      continue;
    }
    if (!src) continue;
    scan.bytes -= src.length;
    for (const form of TEST_NAME_FORMS) {
      form.lastIndex = 0;
      let m;
      while ((m = form.exec(src))) names.add(m[1]);
    }
  }
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

function envNamesIn(text) {
  const found = [];
  for (const form of ENV_REF_FORMS) {
    form.lastIndex = 0;
    let m;
    while ((m = form.exec(text))) found.push(m[1] || m[2]);
  }
  return found;
}

// The environment variable the exit is conditional on, resolved from the enclosing
// conditional rather than from proximity: an env read that merely sits nearby is not a guard,
// and this warning states what it found as fact.
function guardOfExit(src, exitIndex) {
  const from = Math.max(0, exitIndex - GUARD_WINDOW);
  const preceding = src.slice(from, exitIndex);
  CONDITIONAL.lastIndex = 0;
  let conditionalAt = -1;
  let m;
  while ((m = CONDITIONAL.exec(preceding))) conditionalAt = m.index;
  if (conditionalAt === -1) return null;
  const region = preceding.slice(conditionalAt);

  const direct = envNamesIn(region);
  if (direct.length) return direct[direct.length - 1];

  // `const enabled = process.env.RUN_TESTS; if (!enabled) exit(0)` — one level of naming.
  ENV_BINDING.lastIndex = 0;
  let binding;
  while ((binding = ENV_BINDING.exec(preceding))) {
    const [, alias, envA, envB] = binding;
    if (new RegExp(`\\b${alias}\\b`).test(region)) return envA || envB;
  }
  return null;
}

function discardedExitCode(cmd) {
  for (const alt of cmd.split(/\|\|/).slice(1)) {
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

function inlineProgram(tokens) {
  const binary = path.basename(tokens[0] || '').replace(/\.exe$/i, '');
  const flags = INLINE_EVAL_FLAGS[binary];
  if (!flags) return null;
  for (let i = 1; i < tokens.length; i++) {
    if (!flags.includes(tokens[i])) continue;
    const body = stripQuotes(tokens[i + 1] || '');
    // A shell wrapper around the real suite — `sh -c "node tests/run.js"` — is an inline
    // program that CAN go red. Only a body with no failure path cannot.
    if (!CONSTANT_SUCCESS.test(body)) return null;
    return (
      `the inline program given with ${tokens[i]} is "${body}", which always succeeds — ` +
      `the repo's tests never run, so nothing in the repo can turn it red`
    );
  }
  return null;
}

function emptyFilter(tokens, entrypoint, root) {
  const filter = filterOf(tokens);
  // A selection expression is not a name to look for; matching it against test names would
  // report the parse rather than the suite.
  if (!filter || SELECTION_EXPRESSION.test(filter.value)) return null;
  const names = new Set();
  const scan = { budget: TEST_FILE_SCAN_LIMIT, bytes: TOTAL_READ_LIMIT, truncated: false };
  const searchDir = entrypoint ? path.dirname(entrypoint.abs) : root;
  collectTestNames(searchDir, names, scan);
  if (scan.truncated || names.size === 0 || matchesSomeTest(filter.value, names)) return null;
  return (
    `${filter.flag} selects "${filter.value}", which matches no test declared under ` +
    `${path.relative(root, searchDir) || '.'} — the command runs an empty suite and exits 0`
  );
}

function selfDisablingEntrypoint(entrypoint) {
  if (!entrypoint) return null;
  const src = readCapped(entrypoint.abs);
  if (!src) return null;
  // Containment first: one path that can end non-zero is enough to make the file falsifiable,
  // whatever else it does.
  if (RED_PATHS.some((re) => re.test(src))) return null;
  ZERO_EXIT.lastIndex = 0;
  let exitMatch;
  while ((exitMatch = ZERO_EXIT.exec(src))) {
    const guard = guardOfExit(src, exitMatch.index);
    if (guard && process.env[guard] === undefined) {
      return (
        `${entrypoint.rel} exits 0 when $${guard} is unset, $${guard} is unset now, and the ` +
        `file has no path that ends non-zero — the command reports success without running the suite`
      );
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

module.exports = { verifyTestWarnings };
