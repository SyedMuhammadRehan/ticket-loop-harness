# Stage 7 — IMPLEMENT

One slice per AC, or per criterion when finer, in `approach.md`'s `## Slice order`
(riskiest first; any sensible order without an approach). All work happens in `<wt>`.
**Before each slice**, dispatched or inline, declare the files it is expected to touch (from
`## Boundary` and the map; globs allowed, every layer the slice crosses):
`node <SKILL_DIR>/scripts/ledger.js slice <runDir> <C-id> --files <glob>[,<glob>]`
Stage 9 lists every changed file outside all declared scopes; needing one is allowed and
recorded, not hidden.

**Red run** (a `(test)` criterion, its test written, nothing implemented): `node <SKILL_DIR>/scripts/ledger.js red <runDir> <C-id> --cwd <wt>`.
**Inline or dispatch.** Do a slice yourself, with the same TDD discipline and red run, the implementer
prompt's ladder, and the same ledger entry, when it is test-only or a one-file change expected
under `dispatchPolicy.minSliceLines` (default 50). Dispatch when the slice is feature-sized,
needs a fresh context, or is the QA judge. **Before EVERY dispatch** (survey, implementer,
fixer, QA): `node <SKILL_DIR>/scripts/ledger.js dispatch <runDir> "<kind>: <slice-or-check> [<model>]"`
Exit 2 means the dispatch budget is spent: do not dispatch; go to Stage 11 as INCOMPLETE. The
`dispatch_guard` hook counts the tool call either way and also refuses it at the token ceiling
or the QA cap; this call labels it for the report.
**When a dispatch returns**, seal what it cost, using the total tokens and duration the Agent
tool reports on completion and never an estimate:
`node <SKILL_DIR>/scripts/ledger.js outcome <runDir> <seq> ok "<note>" --tokens <n> --ms <n>`

**Implementer dispatch:** `prompts/implementer.md`, filling `{TICKET}`, `{WORKTREE_PATH}`, `{RUN_DIR}`, `{SCRIPTS_DIR}`,
`{SLICE}` (the criterion text), `{SLICE_ID}` (e.g. C3), `{DONE_LIST}` (done.md plus
done-additions.md), `{DESIGN_EXCERPT}`, `{CODEBASE_MAP}` (the outline lines for the slice's
files, re-run when HEAD moved past the stamp, plus the map lines that bear on THIS slice) and
`{APPROACH}` (`## Chosen` + `## Boundary` + relevant failure modes; both `n/a — trivial
change` when skipped), `{LEDGER_FORBIDDEN}` (every `forbidden-now` line from `ledger.md`).
Fill the sections where they are; do not reorder them or prepend a preamble.
**Model:** when the profile's `models.<role>` is not `inherit`, pass it as the Agent tool's
`model` and put it in the dispatch label. Never change a tier on your own judgement.
**A dispatch that dies** (stall, crash, session limit) gets `outcome <runDir> <seq> died
"<what killed it>"` instead; re-dispatching costs another slot, so say so in the report. Every
dispatch needs one or the other: the next dispatch names any left open, the stop gate refuses
to end the turn and `close` refuses the run while one is open (`status` lists them as `open`).
Dispatches that write a file must append each section to the run dir as it completes.

**GATE C:** an edit under an uncleared `riskPaths` glob is denied by the hook and the
implementer returns `GATE_C`. Stop and ask the human; never record a clearance to unblock a
slice. Deleting or weakening an existing test has no glob: re-check every returned diff and
re-run a slice that does it. After each green slice:
`git -C <wt> add -A -- . ':(exclude)test/golden' && git -C <wt> commit -m "wip(<TICKET>): <slice> green"`
with `attribution.commitTrailer` as a second `-m` when it is a string, and no attribution of
any kind when null. Commits happen only in the worktree; never push or touch main (publishing is Stage 11).
