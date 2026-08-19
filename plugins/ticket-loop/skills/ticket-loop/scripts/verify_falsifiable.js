'use strict';
// Can the profile's verify.test command report a failure at all? The stop gate's verdict is
// exactly that command's exit code, so one that cannot exit non-zero certifies every
// turn-end while proving nothing.
//
// Every rule here asks "can I prove no red path exists?" and stays silent otherwise, including
// when what it reconstructed may be incomplete.
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
const NAME_DECL = /\b(?:test|it|describe)(?:\.\w+)*\s*\(\s*/g;
// The files Node's own runner loads. Collecting names from a narrower set than the runner
// discovers is how a partially-scanned repo confidently reports "matches nothing".
const TEST_FILE_NAME = /(?:[._-](test|spec)\.[cm]?js$|^test[-.].*\.[cm]?js$|^test\.[cm]?js$)/i;
const TEST_DIR = /^tests?$/i;
const SOURCE_FILE = /\.[cm]?js$/i;

function isTestFile(name, dir) {
  if (TEST_FILE_NAME.test(name)) return true;
  return TEST_DIR.test(path.basename(dir)) && SOURCE_FILE.test(name);
}

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
const PRELOAD_FLAGS = new Set([
  '--require', '-r', '--import', '--loader', '--experimental-loader', '--env-file', '--test-reporter',
]);
const SHELL_OPERATOR = /[;&|]/;
const ALWAYS_TRUE = /^(?:true|:|exit\s+0|echo\b[^;&|]*)$/;
const CONSTANT_SUCCESS =
  /^\s*(?:true|:|pass|exit\s+0|(?:process|sys|os)\.exit\s*\(\s*0\s*\)|exit\s*\(\s*0\s*\))\s*;?\s*$/;

const ZERO_EXIT = /(?:process|sys|os)\.exit\s*\(\s*0\s*\)/g;
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

// The script whose exit code the command reports — which is not merely the first filename on
// the line. A preload is loaded before the entrypoint and decides nothing about it, and two
// remaining candidates mean the entrypoint cannot be told apart from an argument.
function entrypointOf(tokens, root) {
  const candidates = [];
  for (let i = 1; i < tokens.length; i++) {
    const bare = tokens[i];
    if (PRELOAD_FLAGS.has(tokens[i - 1])) continue;
    if (!bare || bare.startsWith('-') || !/\.\w+$/.test(bare)) continue;
    const abs = path.resolve(root, bare);
    const inside = path.relative(root, abs);
    if (inside && !inside.startsWith('..') && !path.isAbsolute(inside) && fs.existsSync(abs)) {
      candidates.push({ rel: bare, abs });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
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
    if (!isTestFile(entry.name, dir)) continue;
    scan.budget--;
    let src;
    try {
      src = readCapped(full);
    } catch {
      // A file the runner would load but this cannot read leaves a hole in the name set.
      scan.truncated = true;
      continue;
    }
    if (!src) {
      scan.truncated = true;
      continue;
    }
    scan.bytes -= src.length;
    if (!readNames(src, names)) scan.truncated = true;
  }
}

// A name is READ only when the argument is exactly a quoted literal followed by `,`.
// Concatenation, template substitution and variables fail that by construction rather than by
// enumeration — and a name set with a hole in it cannot say "matches nothing".
function readNames(src, names) {
  NAME_DECL.lastIndex = 0;
  let complete = true;
  let m;
  while ((m = NAME_DECL.exec(src))) {
    const rest = src.slice(m.index + m[0].length);
    const quote = rest[0];
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      complete = false;
      continue;
    }
    const end = rest.indexOf(quote, 1);
    if (end === -1 || (quote === '`' && rest.slice(1, end).includes('${'))) {
      complete = false;
      continue;
    }
    if (rest.slice(end + 1).trimStart()[0] !== ',') {
      complete = false;
      continue;
    }
    names.add(rest.slice(1, end));
  }
  return complete;
}

function matchesSomeTest(pattern, names) {
  // Node documents the regex-literal spelling, `--test-name-pattern=/adds/i`.
  const literal = pattern.match(/^\/(.*)\/(\w*)$/);
  const source = literal ? literal[1] : pattern;
  let re = null;
  try {
    re = new RegExp(source, literal ? literal[2] : '');
  } catch {
    // An unparsable pattern is still a literal the runner may match on.
  }
  for (const name of names) {
    if (name.includes(source) || (re && re.test(name))) return true;
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

// Split `if (cond) body` / `if cond: body` into its two halves.
function splitConditional(clause) {
  const open = clause.indexOf('(');
  const colon = clause.indexOf(':');
  if (open !== -1 && (colon === -1 || open < colon)) {
    let depth = 0;
    for (let i = open; i < clause.length; i++) {
      if (clause[i] === '(') depth++;
      else if (clause[i] === ')' && --depth === 0) {
        return { condition: clause.slice(open + 1, i), body: clause.slice(i + 1) };
      }
    }
    return { condition: null, body: '' };
  }
  if (colon !== -1) return { condition: clause.slice(0, colon), body: clause.slice(colon + 1) };
  return { condition: null, body: '' };
}

// True while the conditional's body is still open. A `;` at depth 0 has ended it, so an exit
// after that point is an unrelated statement the conditional does not guard.
function bodyStillOpen(body) {
  let depth = 0;
  for (const ch of body) {
    if (ch === '{' || ch === '(') depth++;
    else if (ch === '}' || ch === ')') depth--;
    else if (ch === ';' && depth <= 0) return false;
  }
  return true;
}

// The environment variable the exit is conditional on, and whether the condition holds right
// now. Polarity decides that: `if (!env.X) exit(0)` is opt-in and fires when X is absent,
// `if (env.X) exit(0)` is opt-out and fires when X is present.
function guardOfExit(src, exitIndex) {
  const from = Math.max(0, exitIndex - GUARD_WINDOW);
  const preceding = src.slice(from, exitIndex);
  CONDITIONAL.lastIndex = 0;
  let conditionalAt = -1;
  let m;
  while ((m = CONDITIONAL.exec(preceding))) conditionalAt = m.index;
  if (conditionalAt === -1) return null;
  const { condition, body } = splitConditional(preceding.slice(conditionalAt));
  if (condition === null || !bodyStillOpen(body)) return null;

  const direct = envNamesIn(condition);
  let name = direct.length ? direct[direct.length - 1] : null;
  let expression = condition;
  if (!name) {
    // `const enabled = process.env.RUN_TESTS; if (!enabled) exit(0)` — one level of naming.
    ENV_BINDING.lastIndex = 0;
    let binding;
    while ((binding = ENV_BINDING.exec(preceding))) {
      const [, alias, envA, envB] = binding;
      if (new RegExp(`\\b${alias}\\b`).test(condition)) {
        name = envA || envB;
        expression = condition.replace(new RegExp(`\\b${alias}\\b`), 'process.env.PLACEHOLDER');
      }
    }
  }
  if (!name) return null;
  const taken = evaluateGuard(expression, process.env[name]);
  return taken === null || !taken.holds ? null : { name, describes: taken.describes };
}

// A closed grammar over one environment variable. Anything outside it is not read, because a
// condition half-understood is how "$X is set" gets asserted about `$X === 'production'`.
function evaluateGuard(condition, value) {
  const present = value !== undefined && value !== '';
  const stripped = condition.replace(/\s+/g, ' ').trim();
  const ref = /(?:process\.env(?:\.\w+|\[\s*['"]\w+['"]\s*\])|os\.environ(?:\.get\(\s*['"]\w+['"]\s*\)|\[\s*['"]\w+['"]\s*\]))/;

  const compared = stripped.match(
    new RegExp(`^\\(*\\s*${ref.source}\\s*(===|!==|==|!=)\\s*(['"])(.*?)\\2\\s*\\)*$`)
  );
  if (compared) {
    const [, op, , literal] = compared;
    const equal = value === literal;
    const holds = op === '===' || op === '==' ? equal : !equal;
    return { holds, describes: `is ${op.startsWith('!') ? 'not ' : ''}"${literal}"` };
  }

  const nullish = stripped.match(new RegExp(`^\\(*\\s*${ref.source}\\s*(===|==)\\s*(undefined|null)\\s*\\)*$`));
  if (nullish) return { holds: !present, describes: 'is unset' };

  const negated = stripped.match(new RegExp(`^\\(*\\s*(?:!|not\\s+)\\s*${ref.source}\\s*\\)*$`));
  if (negated) return { holds: !present, describes: 'is unset' };

  const bare = stripped.match(new RegExp(`^\\(*\\s*${ref.source}\\s*\\)*$`));
  if (bare) return { holds: present, describes: 'is set' };

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

function inlineProgram(tokens, cmd) {
  // Only when the inline program IS the command. `sh -c "true" && node tests/run.js` runs the
  // real suite afterwards, so what the inline body returns settles nothing.
  if (SHELL_OPERATOR.test(cmd)) return null;
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
  if (!filter) return null;
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

// An early exit whose guard evaluates true right now ends the process before the suite runs,
// so what the rest of the file could have returned does not arise.
function selfDisablingEntrypoint(entrypoint) {
  if (!entrypoint) return null;
  const src = readCapped(entrypoint.abs);
  if (!src) return null;
  ZERO_EXIT.lastIndex = 0;
  let exitMatch;
  while ((exitMatch = ZERO_EXIT.exec(src))) {
    const guard = guardOfExit(src, exitMatch.index);
    if (guard) {
      return (
        `${entrypoint.rel} exits 0 when $${guard.name} ${guard.describes}, and it ` +
        `${guard.describes} now — the command reports success without running the suite`
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
      inlineProgram(tokens, cmd) ||
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
