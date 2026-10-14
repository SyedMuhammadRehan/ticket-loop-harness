'use strict';
// Write policy for the frozen/control-plane namespace. Pure functions, no I/O, so the
// whole policy is unit-testable against crafted payloads.
//
// The policy is default-DENY, because enumerating write syntaxes cannot work: `python -c
// "open(p,'w')"`, `[System.IO.File]::WriteAllText(p,...)`, `cd <dir> && sed -i`, and
// `$(...)` inside an otherwise-sanctioned command all write without any nameable verb.
// Hence:
//
//   a command that MENTIONS a protected path is DENIED unless it is either
//     (a) an exact sanctioned harness invocation, or
//     (b) demonstrably read-only.
//
// Commands that never mention a protected path are not evaluated at all, which keeps the
// session-wide blast radius of this hook near zero.
//
// Scope note: paths are protected in three tiers. Secrets (the chain key, the signing key)
// are refused to every command, reads included. Frozen run artifacts are ALWAYS protected.
// The control plane (the profile, the enforcement sources, session hook state) is protected
// only while a ticket run is ACTIVE — otherwise this hook would make the harness itself,
// and any repo's own config, undevelopable.
//
// Every pattern here runs on commands up to the hook's timeout in size, and a timed-out hook
// lets the call through. A `prefix[^x]*suffix` pattern retried from every prefix is quadratic,
// so each such span is written `(?:(?!prefix)[^x])*`: it stops at the next prefix, and every
// character is scanned from one start only.
const path = require('path');
const os = require('os');

// --- path normalisation ---------------------------------------------------------------

// Windows opens `done.md::$DATA`, `done.md.` and `done.md ` as done.md itself, so a name is
// matched as the filesystem will resolve it, not as it was spelled.
function normalisePath(filePath) {
  const str = String(filePath).replace(/\\/g, '/').toLowerCase();
  const lead = str.match(/^([a-z]:)?\/*/)[0];
  const isAbsolute = lead.endsWith('/');
  const out = [];
  for (const part of str.slice(lead.length).split('/')) {
    const seg = part.replace(/:.*$/, '').replace(/ +$/, '');
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbsolute) out.push('..');
      continue;
    }
    const name = seg.replace(/[. ]+$/, '');
    if (name) out.push(name);
  }
  return lead + out.join('/');
}

// --- protected namespaces ------------------------------------------------------------

// Always protected: the frozen contract, the counters, the end-of-run marker, the sealed
// receipt chain (both its in-git home and the non-git fallback dir chain.js falls back to),
// its append lock, and the signing key.
const FROZEN_PATH_PATTERNS = [
  /^(?=(?:[\s\S]*\/)?ticket-runs\/)[\s\S]*\/(clearances\.json|done\.md|budget\.json|closed\.json)$/,
  /\.approved\.md$/,
  /(^|\/)\.?ticket-loop(-chain)?\/[^/]+\/chain(\.\d+)?\.jsonl$/,
  /(^|\/)\.?ticket-loop(-chain)?\/[^/]+\/(key|head\.json|lock)$/,
  /(^|\/)\.claude\/ticket-loop\/signing\//,
];

// Never readable by the agent: whoever holds these can re-seal or re-sign a forged history.
const SECRET_PATH_PATTERNS = [
  /(^|\/)\.?ticket-loop(-chain)?\/[^/]+\/key$/,
  /(^|\/)\.claude\/ticket-loop\/signing(\/(?![^/]*\.pub$)|$)/,
];

// A search rooted at one of these reads the keys inside it.
const SECRET_DIR_PATTERNS = [
  /(^|\/)\.git$/,
  /(^|\/)\.git\/([^/]+\/)*ticket-loop(\/[^/]+)?$/,
  /(^|\/)\.ticket-loop-chain(\/[^/]+)?$/,
  /(^|\/)\.claude\/ticket-loop$/,
];

// The plugin's own tree, wherever it is installed: `<x>/ticket-loop[-y]/[<version>/]hooks/`
// and the like. The `ticket-loop` segment keeps an arbitrary repo's `src/hooks/` out of it.
const PLUGIN_LAYOUT = /(^|\/)ticket-loop[^/]*\/(v?\d[^/]*\/)?(hooks|agents|skills|\.claude-plugin)\//;

// Protected only while a run is active: rewriting any of these mid-run disarms the gates.
const CONTROL_PLANE_PATTERNS = [
  /(^|\/)\.agents\/ticket-loop\.config\.json$/,
  /(^|\/)\.agents\/ticket-loop\.trust$/,
  /(^|\/)\.claude\/ticket-loop\//,
  /(^|\/)\.claude\/hooks\//,
  /(^|\/)\.claude\/agents\/ticket-loop[^/]*$/,
  /(^|\/)\.claude\/settings(\.local)?\.json$/,
  /(^|\/)hooks\/(freeze_guard|stop_gate|dispatch_guard|hook_lib|guard_policy)\.js$/,
  /(^|\/)hooks\/hooks\.json$/,
  /(^|\/)scripts\/(ledger|chain|validate_done|freeze_done)\.js$/,
  /(^|\/)skills\/ticket-loop\//,
  PLUGIN_LAYOUT,
];

// --- glob reach -----------------------------------------------------------------------

const GLOB_CHAR = /[*?[\]{}]/;
const MAX_BRACE_EXPANSIONS = 64;

// One path segment of a shell glob against one name, by state-set simulation: linear in the
// pattern times the name, whatever the pattern holds.
function globSegmentMatches(pattern, name) {
  const alts = expandBraces(pattern);
  if (alts === null) return true;
  return alts.some((alt) => simulateSegment(compileSegment(alt), name));
}

// For each position, where the next `ch` at or after it is (-1 if none): one pass, so finding
// the close of every opener stays linear however many openers there are.
function nextIndexOf(str, ch) {
  const out = new Array(str.length + 1).fill(-1);
  for (let i = str.length - 1; i >= 0; i--) out[i] = str[i] === ch ? i : out[i + 1];
  return out;
}

function expandBraces(pattern) {
  const nextClose = nextIndexOf(pattern, '}');
  let alts = [''];
  let i = 0;
  while (i < pattern.length) {
    const close = pattern[i] === '{' ? nextClose[i] : -1;
    if (close > i) {
      const options = pattern.slice(i + 1, close).split(',');
      alts = alts.flatMap((a) => options.map((o) => a + o));
      if (alts.length > MAX_BRACE_EXPANSIONS) return null;
      i = close + 1;
    } else {
      alts = alts.map((a) => a + pattern[i]);
      i++;
    }
  }
  return alts;
}

function compileSegment(pattern) {
  const nextClose = nextIndexOf(pattern, ']');
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const close = c === '[' && i + 2 <= pattern.length ? nextClose[i + 2] : -1;
    if (c === '*') {
      if (tokens[tokens.length - 1] !== 'star') tokens.push('star');
    } else if (c === '?') tokens.push('any');
    else if (close > i) {
      const body = pattern.slice(i + 1, close);
      const negate = body[0] === '!' || body[0] === '^';
      const set = negate ? body.slice(1) : body;
      tokens.push({ test: (ch) => classHas(set, ch) !== negate });
      i = close;
    } else tokens.push({ test: (ch) => ch === c });
  }
  return tokens;
}

function classHas(set, ch) {
  for (let i = 0; i < set.length; i++) {
    if (set[i + 1] === '-' && i + 2 < set.length) {
      if (ch >= set[i] && ch <= set[i + 2]) return true;
      i += 2;
    } else if (set[i] === ch) return true;
  }
  return false;
}

function simulateSegment(tokens, name) {
  let cur = new Array(name.length + 1).fill(false);
  cur[0] = true;
  for (const tok of tokens) {
    const next = new Array(name.length + 1).fill(false);
    for (let k = 0; k <= name.length; k++) {
      if (tok === 'star') next[k] = cur[k] || (k > 0 && next[k - 1]);
      else if (k > 0 && cur[k - 1]) next[k] = tok === 'any' || tok.test(name[k - 1]);
    }
    if (!next.includes(true)) return false;
    cur = next;
  }
  return cur[name.length];
}

// Directory names a glob segment must not be able to expand to. A dotted or bracketed segment
// is checked against all of them; a plain one only against the run directory, and only once it
// spells enough of a name to mean it — `t*` in an ordinary repo is not an attack on anything.
const DOT_TARGETS = ['.agents', '.git', '.ticket-loop-chain', 'ticket-runs'];
const PLAIN_TARGETS = ['ticket-runs'];
const MIN_PLAIN_PREFIX = 3;

function globReachesNamespace(probe) {
  for (const token of probe.split(/[\s;|&<>()=]+/)) {
    if (!GLOB_CHAR.test(token)) continue;
    for (const seg of token.split(/[\/\\]/)) {
      if (!GLOB_CHAR.test(seg)) continue;
      const dotted = /^[.[{]/.test(seg);
      if (!dotted && seg.search(GLOB_CHAR) < MIN_PLAIN_PREFIX) continue;
      if ((dotted ? DOT_TARGETS : PLAIN_TARGETS).some((t) => globSegmentMatches(seg, t))) return true;
    }
  }
  return false;
}

// A chain-dir token that is not one named record file: a listing, a glob or a key all read the
// key, and only the record files have a reason to be read directly.
const CHAIN_DIR_TOKEN = /\.git[\/\\](?:(?!\.git[\/\\])[^\s\/\\]*[\/\\])*ticket-loop(?![\w.-])|\.ticket-loop-chain/;
const CHAIN_RECORD_FILE = /[\/\\](chain(\.\d+)?\.jsonl|head\.json)$/;
function namesChainDirBeyondRecords(probe) {
  return probe.split(/[\s;|&<>()=]+/).some((token) => {
    const relativeGlob = /^ticket-loop[\/\\]/.test(token) && GLOB_CHAR.test(token);
    if (!CHAIN_DIR_TOKEN.test(token) && !relativeGlob) return false;
    return GLOB_CHAR.test(token) || /(^|[\/\\])\.\.([\/\\]|$)/.test(token) || !CHAIN_RECORD_FILE.test(token);
  });
}

// A frozen file reached through a wildcard or a variable in its directory part.
const FROZEN_FILE_BEHIND_GLOB =
  /[*?[\]{}$](?:[^\s;|&<>*?[\]{}$]*[\/\\])?(done\.md|budget\.json|closed\.json|clearances\.json|done\.approved\.md)(?=$|[\s;|&<>)])/;

// Command-string references to the same namespaces. Quotes are stripped before matching,
// so a path with spaces ("…/ticket-runs/PROJ 1/done.md") cannot slip past a \S-style class.
const PROTECTED_REFS = [
  { re: /ticket-loop(-chain)?[\/\\][^\s\/\\]+[\/\\]key(?![\w.-])/, tier: 'secret', what: 'the receipt chain key' },
  { re: /ticket-loop[\/\\]signing(?![\/\\][^\s\/\\*?[\]{}]*\.pub(?=$|[\s;|&<>)]))/, tier: 'secret', what: 'the attestation signing key' },
  { test: namesChainDirBeyondRecords, tier: 'secret', what: 'the receipt chain directory beyond its record files' },
  { re: /ticket-runs/, tier: 'frozen', what: 'a ticket run directory' },
  { re: /\.approved\.md/, tier: 'frozen', what: 'a frozen approved artifact' },
  // Approved artifacts are not confined to .agents/, so the namespace globs below do not
  // cover a wildcard aimed at one.
  { re: /[*?[\]{}][^\s*?[\]{}]*\.approved\.md/, tier: 'frozen', what: 'a glob reaching a frozen approved artifact' },
  { re: /ticket-loop[\/\\](?:(?!ticket-loop[\/\\])\S)*chain(\.\d+)?\.jsonl/, tier: 'frozen', what: 'the sealed receipt chain' },
  // The chain DIRECTORY, not just the file inside it: `rm -rf .git/ticket-loop` names no
  // chain.jsonl, and a following `init` would reset every counter. Anchored on the git dir
  // (or the non-git fallback name) so the repo's own plugins/ticket-loop/** tree is not
  // swept up — that would deny work on the harness itself.
  { re: /\.git[\/\\](?:(?!\.git[\/\\])\S)*ticket-loop(?![\w.-])/, tier: 'frozen', what: 'the receipt chain directory' },
  { re: /\.ticket-loop-chain/, tier: 'frozen', what: 'the receipt chain directory' },
  // A wildcard under .agents/ or .git/ reaches the namespace without spelling it, so
  // `rm -rf .agents/ticket-*/done.md` names no protected path while deleting one.
  { re: /\.agents[\/\\](?:(?!\.agents[\/\\])[^\s*?[\]{}])*[*?[\]{}]/, tier: 'frozen', what: 'a glob reaching into .agents/' },
  { re: /\.git[\/\\](?:(?!\.git[\/\\])[^\s*?[\]{}])*[*?[\]{}]/, tier: 'frozen', what: 'a glob reaching into .git/' },
  { re: /ticket-[*?[\]{}]/, tier: 'frozen', what: 'a glob reaching the run directories' },
  { test: globReachesNamespace, tier: 'frozen', what: 'a glob that can expand to .agents, .git or the run directory' },
  { re: /ticket-loop\.config\.json/, tier: 'control', what: 'the enforcement profile' },
  { re: /ticket-loop\.trust/, tier: 'control', what: 'the trusted signing keys' },
  { re: /\.claude[\/\\]hooks[\/\\]/, tier: 'control', what: 'the installed hooks or their session state' },
  { re: /\.claude[\/\\]settings(\.local)?\.json/, tier: 'control', what: 'Claude Code settings' },
  { re: /\.claude[\/\\]ticket-loop[\/\\]/, tier: 'control', what: 'the org policy or notify config' },
  { re: /\.claude[\/\\]agents[\/\\]ticket-loop/, tier: 'control', what: 'the QA judge definition' },
  { re: /\b(freeze_guard|stop_gate|dispatch_guard|hook_lib|guard_policy)\.js\b/, tier: 'control', what: 'an enforcement hook source' },
  { re: /\b(ledger|chain|validate_done|freeze_done)\.js\b/, tier: 'control', what: 'an enforcement script source' },
  { re: /ticket-loop(?:(?!ticket-loop)[^\s\/\\])*[\/\\](v?\d[^\s\/\\]*[\/\\])?(hooks|agents|skills|\.claude-plugin)[\/\\]/, tier: 'control', what: 'the ticket-loop plugin tree' },
  { re: /skills[\/\\]ticket-loop[\/\\]/, tier: 'control', what: 'the ticket-loop skill' },
  // The parent directories: removing or renaming one takes every protected file with it.
  { re: /(^|[\s=(\/\\])\.(agents|git)[\/\\]?(?=$|[\s;|&)<>])/, tier: 'control', what: 'the .agents or .git directory itself' },
  { re: FROZEN_FILE_BEHIND_GLOB, tier: 'control', what: 'a frozen run file behind a wildcard' },
];

// --- sanctioned harness invocations --------------------------------------------------

// The harness's own entry points. A sanctioned call is `node <script> <args>` and nothing
// else: no node flag (`-e`, `-r`, `--import` run other code first), the script first, and the
// script one of these by exact name.
const HARNESS_SCRIPTS = new Set(['freeze_done.js', 'validate_done.js', 'ledger.js', 'chain.js', 'survey.js', 'publish.js', 'notify.js']);
const HARNESS_SCRIPT = /\b(freeze_done|validate_done|ledger|chain|survey|publish|notify)\.js\b/;
// Records only the harness's own processes write: a phone answer and a subagent's return.
const HARNESS_ONLY_SUBCOMMANDS = new Set(['approval', 'returned']);
// `$` ( ) and backtick are refused because $(...) / `...` execute inside an otherwise
// perfectly sanctioned-looking command line; % and ! expand under cmd.exe.
const SHELL_META = /[;&|<>$`()%!\r\n]/;
const SHELL_WORD = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;

function shellWords(s) {
  return (String(s).match(SHELL_WORD) || []).map((w) => w.replace(/["']/g, ''));
}

function baseName(p) {
  return String(p).replace(/^.*[\/\\]/, '');
}

function isSanctioned(statement, opts = {}) {
  const s = stripNullRedirection(statement);
  if (/["']/.test(s.replace(/"[^"]*"|'[^']*'/g, ''))) return false;
  if (SHELL_META.test(maskQuoted(s))) return false;
  const words = shellWords(s);
  if (words.length < 2 || !/^node(\.exe)?$/i.test(baseName(words[0]))) return false;
  const script = words[1];
  const name = baseName(script).toLowerCase();
  if (!HARNESS_SCRIPTS.has(name)) return false;
  const args = words.slice(2).map((w) => w.toLowerCase());
  if (name === 'ledger.js' && HARNESS_ONLY_SUBCOMMANDS.has(args[0])) return false;
  if (args.some((a) => a === '--source' || a.startsWith('--source='))) return false;
  const dirs = opts.harnessDirs || [];
  return dirs.length === 0 || insideHarness(script, dirs, opts);
}

// The script must be the installed harness's own file, not one that shares its name.
function insideHarness(script, dirs, opts) {
  const isWin = (opts.platform || process.platform) === 'win32';
  const P = isWin ? path.win32 : path.posix;
  let s = String(script);
  if (/^~(?=$|[\/\\])/.test(s)) s = (opts.home || os.homedir()) + s.slice(1);
  // Git Bash spells C:\x as /c/x.
  if (isWin) s = s.replace(/^\/([a-z])(?=\/)/i, '$1:');
  const real = (p) => {
    if (typeof opts.realpath !== 'function') return p;
    try {
      return opts.realpath(p);
    } catch {
      return p;
    }
  };
  const fold = (p) => (isWin ? P.normalize(p).toLowerCase() : P.normalize(p)).replace(/[\/\\]+$/, '');
  const dir = fold(P.dirname(real(P.resolve(opts.cwd || process.cwd(), s))));
  return dirs.some((d) => fold(P.resolve(d)) === dir || fold(real(P.resolve(d))) === dir);
}

// --- read-only recognition ------------------------------------------------------------

const READ_ONLY_VERBS = new Set([
  'cat', 'type', 'less', 'more', 'head', 'tail', 'nl', 'wc', 'ls', 'dir', 'tree', 'stat',
  'file', 'grep', 'egrep', 'fgrep', 'rg', 'ack', 'findstr', 'select-string', 'sls',
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'test-path', 'measure-object',
  'diff', 'cmp', 'comm', 'sort', 'uniq', 'cut', 'md5sum', 'sha1sum', 'sha256sum', 'shasum',
  'echo', 'write-output', 'jq', 'true', 'false', 'git', 'find',
  'paste', 'fold', 'nl', 'tac', 'column', 'tr', 'expr', 'printf', 'date', 'stat', 'test', '[',
  'basename', 'dirname', 'realpath', 'readlink',
  // Directory changes are harmless on their own; every other segment must still be read-only.
  'cd', 'pushd', 'popd', 'set-location', 'chdir',
]);

const GIT_READ_SUBCOMMANDS = new Set([
  'diff', 'status', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list',
  'cat-file', 'blame', 'describe', 'shortlog', 'merge-base', 'symbolic-ref', 'name-rev',
  'grep', 'count-objects', 'var',
]);

// Inline code execution: an interpreter given a program on the command line can write
// anywhere without naming a single listed verb, so it disqualifies a command from ever being
// treated as read-only.
const INTERPRETER = String.raw`\b(?:python[\d.]*|py|node(?:\.exe)?|nodejs|deno|bun|ruby|perl|php|rscript|lua|osascript)\b`;
const SHELL_BINARY = String.raw`\b(?:bash|sh|zsh|ksh|dash|fish|cmd(?:\.exe)?)\b`;
const POWERSHELL = String.raw`\b(?:powershell|pwsh)(?:\.exe)?\b`;
const INLINE_EXEC = [
  new RegExp(`${INTERPRETER}(?:(?!${INTERPRETER})[^\\n])*\\s-{1,2}(c|e|r|p|n|eval|exec|print)\\b`),
  new RegExp(`${SHELL_BINARY}(?:(?!${SHELL_BINARY})[^\\n])*\\s(-c|\\/c|\\/k)\\b`),
  new RegExp(`${POWERSHELL}(?:(?!${POWERSHELL})[^\\n])*-(command|c|encodedcommand|e|ec)\\b`),
  /-encodedcommand/,
  /frombase64string/,
  /\[system\.io\./,
  /\[io\.file\]/,
  /\b(iex|invoke-expression)\b/,
  /\bexec\s*\(/,
];

// Piping anything into an interpreter is the same hazard by another route.
const PIPE_TO_SHELL = /\|\s*("?[^"|\s]*[\/\\])?(sh|bash|zsh|cmd(\.exe)?|powershell(\.exe)?|pwsh|python[\d.]*|node(\.exe)?|perl|ruby)\b/;

// Keeps a pipeline whole, unlike segments(): `echo <path> | xargs rm` names the target in one
// stage and deletes it in the next.
function statements(cmd) {
  return splitOutsideQuotes(cmd, /&&|\|\||[;\n\r]+/g);
}

// An operator inside quotes is an argument: a grep alternation `'a\|b'` is one pattern, not a
// pipeline. The mask keeps every character position so the split lands on the original text.
function maskQuotedInterior(str) {
  return String(str).replace(/"[^"]*"|'[^']*'/g, (m) => `${m[0]}${' '.repeat(m.length - 2)}${m[0]}`);
}

function splitOutsideQuotes(cmd, operatorRe) {
  const str = String(cmd);
  const masked = maskQuotedInterior(str);
  const out = [];
  let last = 0;
  for (const m of masked.matchAll(operatorRe)) {
    out.push(str.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(str.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

// After this, later statements operate in the namespace while naming nothing.
// Whole path segments only: a repo that merely lives under `ticket-loop-harness/` is not the
// chain directory, and a cd into it must not void the per-statement judging below.
const CD_VERB = String.raw`\b(?:cd|pushd|chdir|set-location|sl)\b`;
const CD_INTO_PROTECTED = new RegExp(
  `${CD_VERB}(?:(?!${CD_VERB})[^\\n;|&])*?[\\\\\\/\\s'"=](ticket-runs|ticket-loop|\\.ticket-loop-chain|\\.agents|\\.git)(?=$|[\\\\\\/\\s'";|&)])`
);

// Opaque execution — no legitimate use inside a ticket run, and the whole point is that
// the guard cannot see what it does.
const OPAQUE_EXEC = [
  /-encodedcommand/,
  /frombase64string/,
  /\bbase64\b(?:(?!\bbase64\b|-{1,2}(?:d|decode)\b)[^|\n])*-{1,2}(?:d|decode)\b[^\n|]*\|/,
];

// Repo-wide destruction that never names the run dir but removes it anyway.
const GIT_CLEAN = String.raw`\bgit\s+clean\b`;
const GIT_STASH = String.raw`\bgit\s+stash\b`;
const DESTRUCTIVE_REPO = [
  { re: new RegExp(`${GIT_CLEAN}(?:(?!${GIT_CLEAN})[^\\n])*-[a-z]*x`), what: 'git clean -x removes ignored files, including the run directory' },
  { re: new RegExp(`${GIT_CLEAN}(?:(?!${GIT_CLEAN})[^\\n])*-[a-z]*d`), what: 'git clean -d removes untracked directories, including the run directory' },
  { re: new RegExp(`${GIT_STASH}(?:(?!${GIT_STASH})[^\\n])*(-u\\b|--include-untracked|-a\\b|--all)`), what: 'git stash -u sweeps the untracked run directory out of the tree' },
  { re: /\bgit\s+reset\s+--hard\b/, what: 'git reset --hard discards in-flight worktree state' },
];

// `merge-base` is a read, hence the negative lookahead.
const GIT_WORD = String.raw`\bgit\b`;
const IN_GIT_STATEMENT = `(?:(?!${GIT_WORD})[^|;&\\n])*`;
const PUBLISHING = [
  { re: new RegExp(`${GIT_WORD}${IN_GIT_STATEMENT}\\bpush\\b`), what: 'git push — the loop hands you a branch; publishing it is yours' },
  { re: new RegExp(`${GIT_WORD}${IN_GIT_STATEMENT}\\bmerge(?!-)\\b`), what: 'git merge — merging is the human decision this loop exists to inform' },
  { re: new RegExp(`${GIT_WORD}${IN_GIT_STATEMENT}\\brebase\\b`), what: 'git rebase — rewriting history mid-run breaks the base the receipts are anchored to' },
  { re: /\bgh\b(?:(?!\bgh\b|\bpr\b)[^|;&\n])*\bpr\b(?:(?!\bgh\b)[^|;&\n])*\b(merge|create)\b/, what: 'gh pr — opening or merging a PR publishes work the run has not finished proving' },
  { re: /\bglab\b(?:(?!\bglab\b|\bmr\b)[^|;&\n])*\bmr\b(?:(?!\bglab\b)[^|;&\n])*\b(merge|create)\b/, what: 'glab mr — opening or merging an MR publishes work the run has not finished proving' },
];

// --- history rewrite ------------------------------------------------------------------

// The receipts are anchored to a base commit and the ticket branch; moving a ref under them
// is a rebase by another name.
const REF_REWRITE_SUBCOMMANDS = new Set(['update-ref', 'filter-branch', 'filter-repo', 'replace']);
const RESET_MODES = new Set(['--soft', '--hard', '--keep', '--merge']);
const COMMITISH = /^((head|@)[~^]|(orig_head|fetch_head)$|[0-9a-f]{7,40}$)|@\{/i;
const BRANCH_REWRITE_LONG = new Set(['--delete', '--force', '--move', '--copy']);
const BRANCH_REWRITE_SHORT = /^-[a-z]*[dDfmMC]/;
const GIT_OPTS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace']);

function gitCalls(cmd) {
  const calls = [];
  for (const seg of segments(maskQuotedInterior(cmd))) {
    const words = seg.split(/\s+/).filter(Boolean);
    const at = words.findIndex((w) => /^git(\.exe)?$/i.test(baseName(w)));
    if (at < 0) continue;
    let i = at + 1;
    while (i < words.length && words[i].startsWith('-')) i += GIT_OPTS_WITH_VALUE.has(words[i]) ? 2 : 1;
    if (i < words.length) calls.push({ sub: words[i].toLowerCase(), args: words.slice(i + 1) });
  }
  return calls;
}

function historyRewrite(cmd) {
  for (const { sub, args } of gitCalls(cmd)) {
    if (REF_REWRITE_SUBCOMMANDS.has(sub)) return `git ${sub} rewrites refs the run's receipts are anchored to`;
    if (sub === 'reset') {
      if (args.some((a) => RESET_MODES.has(a.toLowerCase()))) return 'git reset with a mode moves the branch under the run';
      const end = args.indexOf('--');
      const target = (end < 0 ? args : args.slice(0, end)).find((a) => !a.startsWith('-'));
      if (target && COMMITISH.test(target)) return `git reset ${target} moves the branch under the run`;
    }
    if (sub === 'branch' && args.some((a) => BRANCH_REWRITE_LONG.has(a.toLowerCase()) || BRANCH_REWRITE_SHORT.test(a))) {
      return 'git branch delete/force/move rewrites the branch the run is building';
    }
    if (sub === 'checkout' && args.includes('-B')) return 'git checkout -B resets an existing branch';
    if (sub === 'switch' && args.some((a) => a === '-C' || a === '--force-create')) return 'git switch -C resets an existing branch';
  }
  return null;
}

// `2>/dev/null`, `>NUL`, `2>&1` write nothing and appear in almost every inspection command,
// so they must not make one look like a redirection to a file.
const NULL_REDIRECTION = /(?<!\d)\d*>&\d+|(?<!\d)\d*>>?\s*(\/dev\/null|nul\b)/gi;
function stripNullRedirection(s) {
  return String(s).replace(NULL_REDIRECTION, ' ');
}

function stripQuotes(cmd) {
  return String(cmd).replace(/["']/g, '');
}

// A metacharacter inside quotes is literal text, not an operator. Used only to decide whether
// a command is a bare sanctioned invocation; the reference scan still reads through quotes, so
// a quoted protected path stays visible to it.
function maskQuoted(s) {
  const str = String(s);
  // The executable ("C:\Program Files\nodejs\node.exe") and the harness script's own path
  // are what the sanctioned check has to recognise — mask arguments, not those.
  return str.replace(/"[^"]*"|'[^']*'/g, (m, off) =>
    /^\s*$/.test(str.slice(0, off)) || HARNESS_SCRIPT.test(m.toLowerCase()) ? m : '""'
  );
}

function segments(cmd) {
  return splitOutsideQuotes(cmd, /\|\||&&|[;|\n\r]+/g);
}

const SORT_OUTPUT = /\bsort\b(?:(?!\bsort\b)[^|;&])*(\s-o|--output)/;
const FIND_ACTION = /\bfind\b(?:(?!\bfind\b)[^|;&])*\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/;

function isReadOnly(cmd) {
  const lower = String(cmd).toLowerCase();
  const unquoted = maskQuotedInterior(lower);
  if (/>/.test(stripNullRedirection(unquoted))) return false; // any redirection, including >>
  if (INLINE_EXEC.some((re) => re.test(lower))) return false;
  if (PIPE_TO_SHELL.test(unquoted)) return false;
  if (/\$\(|`/.test(lower)) return false; // command substitution can hide anything
  if (/\bsed\b/.test(lower)) return false; // sed writes via -i and via the `w` command
  // `sort -o F` truncates and rewrites F, so the verb alone does not make a statement safe.
  // No word boundary after -o: the target may be glued to it (`-oC:\path`).
  if (SORT_OUTPUT.test(lower)) return false;
  if (/\b(tee|awk|install|truncate|dd|shred)\b/.test(lower)) return false;
  // `find` deletes and executes through its own flags, not through a verb.
  if (FIND_ACTION.test(lower)) return false;

  for (const raw of segments(lower)) {
    // Loop scaffolding executes nothing by itself; the body is judged as its own segment.
    const seg = raw.replace(/^(do|then|else)\s+/, '');
    if (LOOP_SCAFFOLD.test(seg) || SHELL_ASSIGNMENT.test(seg)) continue;
    let tokens = seg.split(/\s+/).filter(Boolean);
    // `xargs <verb>` runs the verb once per input line; it is as read-only as that verb.
    if (tokens[0] === 'xargs') tokens = tokens.slice(1).filter((t) => !t.startsWith('-'));
    const verb = tokens[0] || '';
    if (!READ_ONLY_VERBS.has(verb)) return false;
    if (verb === 'git') {
      // `-C <dir>` and `-c <key=value>` take an argument, which is not the subcommand;
      // the case fold above makes them the same token.
      const args = tokens.slice(1);
      const positional = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-c') { i++; continue; }
        if (!args[i].startsWith('-')) positional.push(args[i]);
      }
      const sub = positional[0] || '';
      if (sub === 'worktree') {
        if (!/\bworktree\s+list\b/.test(seg)) return false;
      } else if (!GIT_READ_SUBCOMMANDS.has(sub)) {
        return false;
      }
    }
  }
  return true;
}

// `for f in <words>` / `done` / `fi` run nothing; a plain `NAME=value` assigns and runs nothing.
// Command substitution inside either is caught above before this is consulted.
const LOOP_SCAFFOLD = /^(for\s+\w+\s+in\s+[^;|&]*|while\s+[^;|&]*|done|fi|esac)$/;
const SHELL_ASSIGNMENT = /^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s;|&]*)$/;

// --- public verdicts ------------------------------------------------------------------

// Which protected namespaces does this command touch? Tier-aware so control-plane files
// are only in scope while a run is active. Read twice: as written, and with every backslash
// removed, because the shell drops the one in `ticket\-runs` while Windows needs the one in
// `.agents\ticket-runs`.
function protectedRefs(cmd, runActive) {
  const probe = stripQuotes(String(cmd).toLowerCase());
  const unescaped = probe.replace(/\\/g, '');
  const hits = (p, s) => (p.re ? p.re.test(s) : p.test(s));
  return PROTECTED_REFS.filter((p) => (p.tier !== 'control' || runActive) && (hits(p, probe) || hits(p, unescaped)));
}

// A risk path written through the shell is the same edit the Edit tool is refused.
function commandRiskVerdict(raw, opts) {
  const stmts = statements(raw);
  const writers = stmts.filter((s) => !isReadOnly(s));
  if (writers.length === 0) return null;
  const cds = stmts.filter((s) => /^(cd|pushd|chdir|set-location|sl)\b/i.test(s));
  const areas = opts.riskPaths.map((glob) => ({ glob, literal: normalisePath(String(glob).split(/[*?[]/)[0]) }));
  // A cd into a risk area carries the write there; a cd into its parent does not write it.
  return riskHitIn(writers, areas, opts) || riskHitIn(cds, [], opts);
}

function riskHitIn(stmts, areas, opts) {
  const seen = new Set();
  for (const stmt of stmts) {
    for (const word of shellWords(maskShellOperators(stmt))) {
      const token = word.replace(/^[^=\/\\]*=/, '');
      if (!token || token.startsWith('-') || seen.has(token)) continue;
      seen.add(token);
      const hit = riskHitForToken(token, areas, opts);
      if (hit) return hit;
    }
  }
  return null;
}

function maskShellOperators(stmt) {
  const masked = maskQuotedInterior(stmt);
  let out = '';
  for (let i = 0; i < stmt.length; i++) out += /[;|&<>()]/.test(masked[i]) ? ' ' : stmt[i];
  return out;
}

// The file itself, anything under it as a directory, or an ancestor of a risk area.
function riskHitForToken(token, areas, opts) {
  const t = normalisePath(token);
  if (!t) return null;
  const direct = riskVerdict(t, opts) || riskVerdict(`${t}/x`, opts);
  if (direct) return direct;
  const cleared = new Set(opts.cleared || []);
  const area = areas.find((a) => !cleared.has(a.glob) && a.literal.startsWith(`${t}/`));
  return area ? riskVerdict(`${area.literal}/x`, opts) : null;
}

// null when the command is fine, otherwise { reason, hit }.
function commandVerdict(cmd, opts = {}) {
  const runActive = !!opts.runActive;
  const raw = String(cmd);
  const lower = raw.toLowerCase();
  const allRefs = protectedRefs(lower, runActive);

  const secret = allRefs.find((r) => r.tier === 'secret');
  if (secret) {
    return {
      reason: `this command references ${secret.what}, which no command may read or write; the harness's own scripts use it`,
      hit: secret.what,
    };
  }

  if (isSanctioned(raw, opts)) return null;

  if (runActive) {
    for (const re of OPAQUE_EXEC) {
      if (re.test(lower)) {
        return {
          reason:
            'opaque command execution (encoded/base64-piped) is refused while a ticket run is active — ' +
            'the guard cannot inspect what it writes',
          hit: 'encoded command',
        };
      }
    }
    for (const d of DESTRUCTIVE_REPO) {
      if (d.re.test(lower)) {
        return { reason: d.what, hit: 'destructive repo command' };
      }
    }
    for (const pub of PUBLISHING) {
      if (pub.re.test(lower)) {
        return { reason: pub.what, hit: 'publishing command' };
      }
    }
    const rewrite = historyRewrite(raw);
    if (rewrite) return { reason: `${rewrite}; refused while a ticket run is active`, hit: 'history rewrite' };
    if ((opts.riskPaths || []).length > 0) {
      const risk = commandRiskVerdict(raw, opts);
      if (risk) return { reason: `this command writes a ${risk.reason}`, hit: 'risk-tier path' };
    }
  }

  const refs = allRefs;
  if (refs.length === 0) return null;

  if (isReadOnly(raw)) return null;

  // Per-statement judging stops a delete aimed elsewhere from condemning a read of the run
  // dir; anything below can carry an effect between statements, so it forfeits that. An
  // assignment or loop header that names a protected path hands it to later statements
  // through a variable, so the whole command is judged as one.
  const carriesPath = statements(raw).some((s) => {
    const low = s.toLowerCase();
    return (SHELL_ASSIGNMENT.test(low) || LOOP_SCAFFOLD.test(low)) && protectedRefs(low, runActive).length > 0;
  });
  const crossSegment = carriesPath || CD_INTO_PROTECTED.test(lower) || /\$\(|`/.test(lower) || PIPE_TO_SHELL.test(lower);
  if (!crossSegment) {
    // Sanctioned invocations too: the whole-command check above stops matching once anything follows.
    const offender = statements(raw).find((seg) => {
      if (protectedRefs(seg.toLowerCase(), runActive).length === 0) return false;
      return !isSanctioned(seg, opts) && !isReadOnly(seg);
    });
    if (!offender) return null;
    const segRefs = protectedRefs(offender.toLowerCase(), runActive);
    return {
      reason:
        `this command references ${segRefs[0].what} and is not a read-only command or a ` +
        `sanctioned harness invocation (default-deny on the protected namespace)`,
      hit: segRefs[0].what,
    };
  }

  return {
    reason:
      `this command references ${refs[0].what} and is not a read-only command or a sanctioned ` +
      `harness invocation (default-deny on the protected namespace)`,
    hit: refs[0].what,
  };
}

// Minimal glob for riskPaths: `**` (any depth; `**/` may also match nothing), `*` (one
// segment), `?`, rest literal, matched against the tail of the path so a repo-relative glob
// also matches an absolute worktree path. ledger.js matches the same language by regex. Run
// here as a state-set simulation, because a regex with two `.*` is quadratic on a long path
// and the path can be any token of a command. Not a full glob library on purpose — a riskPath
// is a coarse "this area needs a human" marker, where over-matching only costs a question.
const COMPILED_GLOBS = new Map();
function compileGlob(glob) {
  if (COMPILED_GLOBS.has(glob)) return COMPILED_GLOBS.get(glob);
  const g = String(glob).replace(/\\/g, '/').toLowerCase();
  const tokens = [];
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '*' && g[i + 1] === '*') {
      tokens.push('deep');
      i++;
      if (g[i + 1] === '/') i++;
    } else if (g[i] === '*') tokens.push('star');
    else if (g[i] === '?') tokens.push('one');
    else tokens.push(g[i]);
  }
  // Every literal run must appear in a matching path, which rejects most tokens without simulating.
  const literals = tokens.map((t) => (t.length === 1 ? t : '\0')).join('').split('\0').filter(Boolean);
  COMPILED_GLOBS.set(glob, { tokens, literals });
  return COMPILED_GLOBS.get(glob);
}

function globMatches(glob, filePath) {
  const { tokens, literals } = compileGlob(glob);
  const p = String(filePath).toLowerCase();
  if (!literals.every((lit) => p.includes(lit))) return false;
  let cur = new Array(p.length + 1).fill(false);
  cur[0] = true;
  for (let k = 0; k < p.length; k++) if (p[k] === '/') cur[k + 1] = true;
  for (const tok of tokens) {
    const next = new Array(p.length + 1).fill(false);
    for (let k = 0; k <= p.length; k++) {
      if (tok === 'deep') next[k] = cur[k] || (k > 0 && next[k - 1]);
      else if (tok === 'star') next[k] = cur[k] || (k > 0 && next[k - 1] && p[k - 1] !== '/');
      else if (k > 0 && cur[k - 1]) next[k] = tok === 'one' ? p[k - 1] !== '/' : p[k - 1] === tok;
    }
    if (!next.includes(true)) return false;
    cur = next;
  }
  return cur[p.length];
}

// A risk-tier edit is denied unless a human cleared that area and the clearance was RECORDED.
// Per-glob, so clearing one area never opens another.
function riskVerdict(filePath, opts = {}) {
  const riskPaths = opts.riskPaths || [];
  if (!opts.runActive || riskPaths.length === 0) return null;
  const p = normalisePath(filePath);
  const matches = riskPaths.filter((glob) => globMatches(glob, p));
  if (matches.length === 0) return null;
  // A path under several declared riskPaths is editable only when EVERY one is cleared —
  // matching just the first would make the outcome depend on the order globs appear in the
  // profile. Clearance matches the glob by identity, never the path: a pattern matched against
  // the file (`clear "**"`) would open every risk area at once.
  const cleared = new Set(opts.cleared || []);
  const uncleared = matches.find((glob) => !cleared.has(glob));
  if (!uncleared) return null;
  return {
    reason:
      `risk-tier path (matches riskPaths "${uncleared}") and no recorded clearance for it. ` +
      `GATE A/C requires a human to clear this area first; record it with ` +
      `"ledger.js clear <runDir> ${uncleared} <why>" once they have. Do NOT clear it yourself`,
  };
}

// null when the path is writable, otherwise { reason }.
function pathVerdict(filePath, opts = {}) {
  const p = normalisePath(filePath);
  if (FROZEN_PATH_PATTERNS.some((re) => re.test(p))) {
    return {
      reason:
        'frozen run artifact. Criteria may be ADDED in done-additions.md; counters and receipts ' +
        'change only via ledger.js',
    };
  }
  if (opts.runActive && CONTROL_PLANE_PATTERNS.some((re) => re.test(p))) {
    return {
      reason:
        'enforcement control plane (profile / hook source / hook state) and a ticket run is ACTIVE. ' +
        'Changing what the gates check while they are gating is not allowed — finish or archive the run first',
    };
  }
  return null;
}

// null when the agent may read the path, otherwise { reason }. A directory is refused when a
// search rooted there would read a key.
function secretPathVerdict(filePath, opts = {}) {
  const p = normalisePath(filePath);
  const patterns = opts.directory ? [...SECRET_PATH_PATTERNS, ...SECRET_DIR_PATTERNS] : SECRET_PATH_PATTERNS;
  if (!patterns.some((re) => re.test(p))) return null;
  return {
    reason:
      'a key the receipt chain or the attestation is sealed with. Whoever can read it can re-seal a ' +
      'forged history; only the harness scripts use it',
  };
}

module.exports = {
  commandVerdict,
  pathVerdict,
  riskVerdict,
  secretPathVerdict,
  globMatches,
  isReadOnly,
  isSanctioned,
  normalisePath,
  protectedRefs,
  segments,
};
