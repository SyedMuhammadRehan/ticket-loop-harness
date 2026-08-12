# CLAUDE.md — ticket-loop-harness

A Claude Code plugin: a loop-engineering harness that takes a ticket to a reviewed branch.
This is infrastructure, not application code. Read the constraints below before changing
anything — several of them are counter-intuitive and exist because a review broke the
obvious version.

## What this repo is

`plugins/ticket-loop/` is the shipped plugin: a skill (the stage playbook), four hooks (the
enforcement layer), five scripts (the mechanical checks), and three subagent prompts.
`tests/` covers the scripts and hooks. Everything else is docs.

## Hard constraints

- **Zero runtime dependencies.** Node ≥ 18 standard library only, in the plugin and the
  tests. No `npm install` step for a user, ever.
- **Cross-platform.** Windows and POSIX both. `git bash` and PowerShell are both live here;
  `mode: 0o600` is a no-op on Windows; `.bat` shims need the shell fallback in `hook_lib.js`.
- **Hooks must never wedge a session on malformed input** (exit 0), but **must** block real
  violations (exit 2). Both halves are tested.
- **Fail closed only where a run is active.** Outside a ticket run every hook returns
  immediately — a broken install must not break unrelated projects.

## The rule that matters most

**A guarantee stated in prose is not a guarantee.** If a doc claims something is enforced,
there must be code that enforces it and a test that fails when that code is removed. Three
adversarial reviews of this repo found that the enforcement layer was largely aspirational;
every fix moved a claim from prose into a script, a hook, or a sealed receipt. When you add a
mechanism, add the test that kills it — and prefer mutation-testing it (break the guard on
purpose, confirm the suite goes red) over trusting a green run.

Corollary: **do not claim in README/INSTALL what the code does not do.** The "Yours to
uphold" section exists to list the gaps honestly. Add to it rather than quietly overstating.

`INVARIANTS.md` is the map: every guarantee, its enforcing symbol, and the test that kills it.
Read it before changing the enforcement layer — the defects that keep recurring are
interactions between two rows, which the code alone does not make visible. Adding a mechanism
means adding a row; `tests/invariants.test.js` fails when a cited symbol or test stops
existing, and when an enforcement file has no row at all.

## Testing

```
node tests/run.js          # the whole suite; must be green before any commit
claude plugin validate .   # manifest must pass before touching .claude-plugin/
```

Tests spawn the real scripts as child processes against temp git repos — they are not unit
tests with mocks, deliberately, because the failures worth catching are process- and
filesystem-level. A test that would still pass if its mechanism were deleted is a bug: name
the invariant, then prove the test fails without it.

## Comments

Match the surrounding density. State constraints the code cannot express — why merge-base
rather than `git status`, why default-deny, why a fallback is refused on Windows. Never
narrate change history ("used to", "the regression this fixes", "CRITICAL FIX"); that is a
commit message, and it rots. Never add AI-attribution markers.

## Versioning

`package.json`, `plugins/ticket-loop/.claude-plugin/plugin.json`, and
`.claude-plugin/marketplace.json` must agree. The marketplace version governs installs, so a
mismatch there ships the wrong thing silently.

## Git

Branch from `main`, PR back, conventional commit prefixes. Never push or merge without being
asked. The harness itself never pushes — neither should work on it.
