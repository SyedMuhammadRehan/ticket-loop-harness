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
// Scope note: paths are protected in two tiers. Frozen run artifacts are ALWAYS protected.
// The control plane (the profile, the enforcement sources, session hook state) is protected
// only while a ticket run is ACTIVE — otherwise this hook would make the harness itself,
// and any repo's own config, undevelopable.

// --- protected namespaces ------------------------------------------------------------

// Always protected: the frozen contract, the counters, the end-of-run marker, and the sealed
// receipt chain (both its in-git home and the non-git fallback dir chain.js falls back to).
const FROZEN_PATH_PATTERNS = [
  /(^|\/)ticket-runs\/(.+\/)?clearances\.json$/,
  /(^|\/)ticket-runs\/(.+\/)?done\.md$/,
  /(^|\/)ticket-runs\/(.+\/)?budget\.json$/,
  /(^|\/)ticket-runs\/(.+\/)?closed\.json$/,
  /\.approved\.md$/,
  /(^|\/)\.?ticket-loop(-chain)?\/[^/]+\/chain(\.\d+)?\.jsonl$/,
  /(^|\/)\.?ticket-loop(-chain)?\/[^/]+\/(key|head\.json)$/,
];

// Protected only while a run is active: rewriting any of these mid-run disarms the gates.
const CONTROL_PLANE_PATTERNS = [
  /(^|\/)\.agents\/ticket-loop\.config\.json$/,
  /(^|\/)\.claude\/hooks\/state\//,
  /(^|\/)\.claude\/settings(\.local)?\.json$/,
  /(^|\/)hooks\/(freeze_guard|stop_gate|dispatch_guard|hook_lib|guard_policy)\.js$/,
  /(^|\/)hooks\/hooks\.json$/,
  /(^|\/)scripts\/(ledger|chain|validate_done|freeze_done)\.js$/,
];

// Command-string references to the same namespaces. Quotes are stripped before matching,
// so a path with spaces ("…/ticket-runs/PROJ 1/done.md") cannot slip past a \S-style class.
const PROTECTED_REFS = [
  { re: /ticket-runs/, tier: 'frozen', what: 'a ticket run directory' },
  { re: /[\w.-]+\.approved\.md/, tier: 'frozen', what: 'a frozen approved artifact' },
  // Approved artifacts are not confined to .agents/, so the namespace globs below do not
  // cover a wildcard aimed at one.
  { re: /[*?][^\s"']*\.approved\.md/, tier: 'frozen', what: 'a glob reaching a frozen approved artifact' },
  { re: /ticket-loop[\/\\][^\s]*[\/\\]?chain(\.\d+)?\.jsonl/, tier: 'frozen', what: 'the sealed receipt chain' },
  // The chain DIRECTORY, not just the file inside it: `rm -rf .git/ticket-loop` names no
  // chain.jsonl, and a following `init` would reset every counter. Anchored on the git dir
  // (or the non-git fallback name) so the repo's own plugins/ticket-loop/** tree is not
  // swept up — that would deny work on the harness itself.
  { re: /\.git[\/\\][^\s]*ticket-loop(?![\w.-])/, tier: 'frozen', what: 'the receipt chain directory' },
  { re: /\.ticket-loop-chain/, tier: 'frozen', what: 'the receipt chain directory' },
  // A wildcard under .agents/ or .git/ reaches the namespace without spelling it, so
  // `rm -rf .agents/ticket-*/done.md` names no protected path while deleting one.
  { re: /\.agents[\/\\][^\s"']*[*?]/, tier: 'frozen', what: 'a glob reaching into .agents/' },
  { re: /\.git[\/\\][^\s"']*[*?]/, tier: 'frozen', what: 'a glob reaching into .git/' },
  { re: /ticket-[*?]/, tier: 'frozen', what: 'a glob reaching the run directories' },
  { re: /ticket-loop\.config\.json/, tier: 'control', what: 'the enforcement profile' },
  { re: /\.claude[\/\\]hooks[\/\\]state/, tier: 'control', what: 'hook session state' },
  { re: /\.claude[\/\\]settings(\.local)?\.json/, tier: 'control', what: 'Claude Code settings' },
  { re: /\b(freeze_guard|stop_gate|dispatch_guard|hook_lib|guard_policy)\.js\b/, tier: 'control', what: 'an enforcement hook source' },
  { re: /\b(ledger|chain|validate_done|freeze_done)\.js\b/, tier: 'control', what: 'an enforcement script source' },
];

// --- sanctioned harness invocations --------------------------------------------------

// The harness's own writers. Must be the WHOLE command: starts with node, names one
// script, and contains no shell metacharacter that could smuggle a second command.
// `$` ( ) and backtick are excluded because $(...) / `...` execute inside an otherwise
// perfectly sanctioned-looking command line.
const SANCTIONED_COMMAND =
  /^\s*("[^"]*node(\.exe)?"|node(\.exe)?)\s+[^;&|<>$`()%!\r\n]*\b(freeze_done|validate_done|ledger|chain)\.js\b[^;&|<>$`()%!\r\n]*$/;

// --- read-only recognition ------------------------------------------------------------

const READ_ONLY_VERBS = new Set([
  'cat', 'type', 'less', 'more', 'head', 'tail', 'nl', 'wc', 'ls', 'dir', 'tree', 'stat',
  'file', 'grep', 'egrep', 'fgrep', 'rg', 'ack', 'findstr', 'select-string', 'sls',
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'test-path', 'measure-object',
  'diff', 'cmp', 'comm', 'sort', 'uniq', 'cut', 'md5sum', 'sha1sum', 'sha256sum', 'shasum',
  'echo', 'write-output', 'jq', 'true', 'false', 'git',
  // Directory changes are harmless on their own; every other segment must still be read-only.
  'cd', 'pushd', 'popd', 'set-location', 'chdir',
]);

const GIT_READ_SUBCOMMANDS = new Set([
  'diff', 'status', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list',
  'cat-file', 'blame', 'describe', 'shortlog', 'merge-base', 'symbolic-ref', 'name-rev',
  'grep', 'count-objects', 'var',
]);

// Inline code execution: an interpreter given a program on the command line can write
// anywhere without naming a single listed verb. This is the class that defeated the old
// blocklist, so it disqualifies a command from ever being treated as read-only.
const INLINE_EXEC = [
  /\b(python[\d.]*|py|node(\.exe)?|nodejs|deno|bun|ruby|perl|php|rscript|lua|osascript)\b[^\n]*\s-{1,2}(c|e|r|p|n|eval|exec|print)\b/,
  /\b(bash|sh|zsh|ksh|dash|fish|cmd(\.exe)?)\b[^\n]*\s(-c|\/c|\/k)\b/,
  /\b(powershell|pwsh)(\.exe)?\b[^\n]*-(command|c|encodedcommand|e|ec)\b/,
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
  return String(cmd)
    .split(/&&|\|\||[;\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// After this, later statements operate in the namespace while naming nothing.
const CD_INTO_PROTECTED = /\b(cd|pushd|chdir|set-location|sl)\b[^\n;|&]*?(ticket-runs|ticket-loop|\.ticket-loop-chain)/;

// Opaque execution — no legitimate use inside a ticket run, and the whole point is that
// the guard cannot see what it does.
const OPAQUE_EXEC = [/-encodedcommand/, /frombase64string/, /\bbase64\b[^|\n]*-{1,2}(d|decode)\b[^\n]*\|/];

// Repo-wide destruction that never names the run dir but removes it anyway.
const DESTRUCTIVE_REPO = [
  { re: /\bgit\s+clean\b[^\n]*-[a-z]*[xX]/, what: 'git clean -x removes ignored files, including the run directory' },
  { re: /\bgit\s+clean\b[^\n]*-[a-z]*d/, what: 'git clean -d removes untracked directories, including the run directory' },
  { re: /\bgit\s+stash\b[^\n]*(-u\b|--include-untracked|-a\b|--all)/, what: 'git stash -u sweeps the untracked run directory out of the tree' },
  { re: /\bgit\s+reset\s+--hard\b/, what: 'git reset --hard discards in-flight worktree state' },
];

// `2>/dev/null`, `>NUL`, `2>&1` write nothing and appear in almost every inspection command,
// so they must not make one look like a redirection to a file.
const NULL_REDIRECTION = /\d*>&\d+|\d*>>?\s*(\/dev\/null|nul\b)/gi;
function stripNullRedirection(s) {
  return String(s).replace(NULL_REDIRECTION, ' ');
}

function stripQuotes(cmd) {
  return String(cmd).replace(/["']/g, '');
}

function segments(cmd) {
  return String(cmd)
    .split(/\|\||&&|[;|\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstToken(segment) {
  const tok = segment.split(/\s+/)[0] || '';
  // Strip a leading path and any .exe so `/usr/bin/cat` and `cat.exe` both resolve.
  return tok.replace(/^.*[\/\\]/, '').replace(/\.exe$/, '').toLowerCase();
}

function isReadOnly(cmd) {
  const lower = String(cmd).toLowerCase();
  if (/>/.test(stripNullRedirection(lower))) return false; // any redirection, including >>
  if (INLINE_EXEC.some((re) => re.test(lower))) return false;
  if (PIPE_TO_SHELL.test(lower)) return false;
  if (/\$\(|`/.test(lower)) return false; // command substitution can hide anything
  if (/\bsed\b/.test(lower)) return false; // sed writes via -i and via the `w` command
  // `sort -o F` truncates and rewrites F, so the verb alone does not make a statement safe.
  // No word boundary after -o: the target may be glued to it (`-oC:\path`).
  if (/\bsort\b[^|;&]*(\s-o|--output)/.test(lower)) return false;
  if (/\b(tee|awk|xargs|install|truncate|dd|shred)\b/.test(lower)) return false;

  for (const seg of segments(lower)) {
    const verb = firstToken(seg);
    if (!READ_ONLY_VERBS.has(verb)) return false;
    if (verb === 'git') {
      const sub = (seg.split(/\s+/).filter((t) => t && !t.startsWith('-'))[1] || '').toLowerCase();
      if (sub === 'worktree') {
        if (!/\bworktree\s+list\b/.test(seg)) return false;
      } else if (!GIT_READ_SUBCOMMANDS.has(sub)) {
        return false;
      }
    }
  }
  return true;
}

// --- public verdicts ------------------------------------------------------------------

// Which protected namespaces does this command touch? Tier-aware so control-plane files
// are only in scope while a run is active.
function protectedRefs(cmd, runActive) {
  const probe = stripQuotes(String(cmd).toLowerCase());
  return PROTECTED_REFS.filter((p) => (p.tier === 'frozen' || runActive) && p.re.test(probe));
}

// null when the command is fine, otherwise { reason, hit }.
function commandVerdict(cmd, opts = {}) {
  const runActive = !!opts.runActive;
  const raw = String(cmd);
  const lower = raw.toLowerCase();

  if (SANCTIONED_COMMAND.test(stripNullRedirection(lower))) return null;

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
  }

  const refs = protectedRefs(lower, runActive);
  if (refs.length === 0) return null;

  if (isReadOnly(raw)) return null;

  // Per-statement judging stops a delete aimed elsewhere from condemning a read of the run
  // dir; anything below can carry an effect between statements, so it forfeits that.
  const crossSegment = CD_INTO_PROTECTED.test(lower) || /\$\(|`/.test(lower) || PIPE_TO_SHELL.test(lower);
  if (!crossSegment) {
    // Sanctioned invocations too: the anchored form above stops matching once anything follows.
    const offender = statements(raw).find((seg) => {
      const low = seg.toLowerCase();
      if (protectedRefs(low, runActive).length === 0) return false;
      return !SANCTIONED_COMMAND.test(stripNullRedirection(low)) && !isReadOnly(seg);
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

// null when the path is writable, otherwise { reason }.
// Minimal glob → RegExp for riskPaths: `**` (any depth), `*` (one segment), `?`, rest
// literal. Not a full glob library on purpose — a riskPath is a coarse "this area needs a
// human" marker, where over-matching only costs an extra question.
function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i++;
        if (g[i + 1] === '/') i++; // `**/` also matches zero directories
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // Match the tail of the path, so a repo-relative glob also matches an absolute worktree path.
  return new RegExp(`(^|/)${out}$`, 'i');
}

// A risk-tier edit is denied unless a human cleared that area and the clearance was RECORDED.
// Per-glob, so clearing one area never opens another.
function riskVerdict(filePath, opts = {}) {
  const riskPaths = opts.riskPaths || [];
  if (!opts.runActive || riskPaths.length === 0) return null;
  const p = String(filePath).replace(/\\/g, '/');
  const matches = riskPaths.filter((glob) => {
    try {
      return globToRegExp(glob).test(p);
    } catch {
      return false;
    }
  });
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

function pathVerdict(filePath, opts = {}) {
  const p = String(filePath).replace(/\\/g, '/').toLowerCase();
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

module.exports = {
  commandVerdict,
  pathVerdict,
  riskVerdict,
  globToRegExp,
  isReadOnly,
  protectedRefs,
  segments,
  firstToken,
  SANCTIONED_COMMAND,
};
