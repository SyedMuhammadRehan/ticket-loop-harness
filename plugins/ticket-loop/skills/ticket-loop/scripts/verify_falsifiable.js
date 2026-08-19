'use strict';
// Can the profile's verify.test command report a failure at all? The stop gate's verdict is
// exactly that command's exit code, so one that cannot exit non-zero certifies every turn-end
// while proving nothing.
//
// Only shapes decidable from the command string are reported. Two shapes are deliberately NOT
// decided, and re-adding them is a design decision rather than an improvement:
//
//   - a filter that matches no test (`--test-name-pattern=nope`), which needs the runner's
//     name surface AND its file discovery reconstructed from source;
//   - an entrypoint that exits 0 early under an environment variable, which needs a guard
//     condition evaluated and every failing path in the file ruled out.
//
// Six adversarial rounds each found one more spelling past whatever rule bounded those two:
// braces, directory depth, string concatenation, comparison operators, discovery globs. They
// are not decidable by inspection; answering them soundly means running the command, which a
// profile resolver must not do.
const path = require('path');

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
// A right-hand side that succeeds no matter what the left-hand side did.
const ALWAYS_TRUE = /^(?:true|:|exit\s+0|echo\b[^;&|]*)$/;
const CONSTANT_SUCCESS =
  /^\s*(?:true|:|pass|exit\s+0|(?:process|sys|os)\.exit\s*\(\s*0\s*\)|exit\s*\(\s*0\s*\))\s*;?\s*$/;
const SHELL_OPERATOR = /[;&|]/;

// Quote-aware: splitting on whitespace turns `-c "npm test"` into the token `"npm`, and a rule
// that then judges the body is judging its own parse.
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
    // A shell wrapper around the real suite is an inline program that CAN go red. Only a body
    // with no failure path cannot.
    if (!CONSTANT_SUCCESS.test(body)) return null;
    return (
      `the inline program given with ${tokens[i]} is "${body}", which always succeeds. ` +
      `The repo's tests never run, so nothing in the repo can turn it red`
    );
  }
  return null;
}

function verifyTestWarnings(cfg) {
  const cmd = cfg.verify && cfg.verify.test;
  if (typeof cmd !== 'string' || !cmd.trim()) return [];
  try {
    const reason = discardedExitCode(cmd) || inlineProgram(tokenize(cmd), cmd);
    return reason ? [`verify.test "${cmd}" cannot report a failure: ${reason}`] : [];
  } catch {
    // Preflight resolves the profile for every hook; a detector that throws would take all of
    // them down over an advisory warning.
    return [];
  }
}

module.exports = { verifyTestWarnings };
