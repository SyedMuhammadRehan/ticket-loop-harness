---
name: ticket-loop
description: Use when the user types /ticket-loop <TICKET-ID or task text>, optionally with --dry-run or --update-jira, or asks to take a Jira, GitHub, GitLab or Trello ticket (or a pasted task) all the way to a reviewed branch with hook-enforced gates, adversarial QA and an evidence report. The target repo must carry .agents/ticket-loop.config.json.
---

# Ticket Loop

You are the ORCHESTRATOR. You dispatch subagents, record receipts, and implement inline only
where a stage below says so. Hands-off: never ask "should I continue?"; ask a human only at
GATE A, GATE B, GATE C and the RESUME prompt. The design and the reasons behind every rule
are in README.md ("How the loop stays honest"); this file is the procedure.

**Constants:** STRIKES_PER_CLASS=3, MAX_REPLANS=2, MAX_DISPATCHES=25.
**Failure classes:** BUILD, TEST, TOKEN, RUNTIME, QA_BLOCK, GOLDEN_UPDATE_REQUIRED, FLAKY_VERIFIER.
**Run dir:** `.agents/ticket-runs/<TICKET>/`, created with its `screenshots/` subdir by
`ledger.js init` at Stage 0 (a plain `mkdir` there is refused by the write guard);
`<runDir>` below means that path and `<wt>` means `<worktreePrefix><TICKET>`. Counters, check
results, verdicts and gates live in a sealed chain under `<gitdir>/ticket-loop/<TICKET>/`,
written only by `<SKILL_DIR>/scripts/ledger.js`; `budget.json` is a read-only mirror and
`ledger.md` the human narrative.
**Working directory:** run every command from the MAIN repo root; reach the worktree with
`git -C <wt>` or absolute paths, never `cd`, and never prefix a harness command with `cd X &&`.
Pass script paths UNQUOTED: the write guard cannot recognise a quoted one.
**Config keys:** `{verify.test}`, `{verify.analyze}`, `{verify.pubGet}`, `{verify.codegen}`
mean the profile's resolved values. Substitute them; never infer a stack from the files you see.

## What is mechanical, and what is yours

Hooks and scripts enforce: the dispatch and re-plan caps; the freeze; writes to `done.md`,
`*.approved.md`, `closed.json` and the chain; the profile and hook sources while a run is
active; edits under a `riskPaths` glob until a clearance for that glob is sealed; every stage
gate costing the artifact it names; a check result naming its method, with `asserted` never
backing a PASS; a QA verdict sealing the contract it judged; the run staying active until
`ledger.js close` succeeds.

Yours, and visible in the report when missed: running `ledger.js verify` and pasting its real
output; GATE B; the strike count per class; honest failure classification; keeping
`done-additions.md` additive; recording a dispatch that died; never recording a clearance a
human did not give. A skipped stage records no gate; note it in `ledger.md` and the report.

**Editing a document after a receipt sealed it:** record it first, on every such edit:
`node <SKILL_DIR>/scripts/ledger.js revise <runDir> <file> --reason "<what changed and why>"`
A gate seals the file named as its `--evidence` (`approach.md`, and `ledger.md` when you cite
it). Until then a file is freely editable. `done.md`, `*.approved.md` and the profile are refused
outright. `done-additions.md` is never revised or hand-edited after a verdict: a new criterion
goes in with `ledger.js addition <runDir> "<criterion line>"`, which appends and re-seals it.

## Stage 0 — PREFLIGHT

1. `node <SKILL_DIR>/scripts/load_config.js`. Record `stack`, the resolved verify commands,
   and the first line of the stack's `--version` output for the report. STOP and ask when:
   - `configFound` is false or `verify.test` is null: ask for the missing commands and scope.
   - `_meta.warnings` names `hooks.stopGate`: show the warning, ask the user to add the block
     (`config.example.json` has one), and start again. Mid-run it cannot be fixed.
   - `_meta.newerVersionInstalled` is set: say which version you are (`_meta.skillVersion`),
     which is installed, and that a NEW SESSION is the only fix. Do not proceed.
2. If `memoryFile` is set: `node <SKILL_DIR>/scripts/memory.js read <memoryFile>`. Lessons
   are high-trust, Pending is hints; carry flaky tests into the flake policy and relevant
   lessons into prompts. A lesson never authorises skipping a test, a gate or a clearance.
3. Probe dependencies; degrade explicitly, never silently. Ticket source per `ticketSource`
   (`jira` → Atlassian MCP; `github` → `gh`; `gitlab` → `glab`; `trello` → Trello
   MCP; `manual` → nothing); unreachable → fall back to `manual` and ask the user to paste the
   ticket. Design source when `designSource != none` (`figma` → a Figma tool is callable;
   `openapi` → the contract is reachable); unavailable → the run is LOGIC-ONLY and every visual
   or contract check is SKIPPED with that reason. Playwright MCP unavailable → runtime
   criteria are SKIPPED with that reason.
4. Worktree (skip under `--dry-run`). If `git worktree list` shows `<wt>` or
   `git branch --list ticket/<TICKET>` is non-empty, ASK once: RESUME (keep everything, skip
   `init`, jump to Stage 8 to assess real state) or CLEAN RESTART (`git worktree remove <wt>`,
   `git branch -D ticket/<TICKET>`, `node <SKILL_DIR>/scripts/ledger.js archive <runDir>`,
   then `init --restart` in step 5). Never auto-delete; if `worktree remove` refuses, show
   the dirty files and let the human decide. Then `git worktree add <wt> -b ticket/<TICKET>`;
   record `git -C <wt> rev-parse HEAD` as the base SHA;
   `node <SKILL_DIR>/scripts/worktree_deps.js <wt>` prints `linked`, `present` or `install`,
   and only `install` means run `{verify.pubGet}`; then `{verify.codegen}` (skip null values).
   Any failure here → STOP. Never fall back to the user's tree.
5. `node <SKILL_DIR>/scripts/ledger.js init <runDir> <base-sha>` (add `--restart` after an
   archive; under `--dry-run` the base is `git rev-parse HEAD`). It seals the profile hash,
   writes `budget.json` and the `ledger.md` skeleton.
   If it warns that there is no config to seal, STOP and get a profile first.

## Stage 1 — INTAKE

1. Fetch the ticket per `ticketSource`: `jira` → Atlassian MCP `getJiraIssue`; `github` → `gh issue view <ID>
   --comments`; `gitlab` → `glab issue view <ID> --comments`; `trello` → Trello MCP;
   `manual` → the user's text is the ticket and `<TICKET>` is a short slug you choose.
   Extract summary, description, acceptance criteria verbatim, design links (only when
   `designSource != none`) from description and comments, and attachment names.
2. Write `<runDir>/ticket-brief.md`: numbered verbatim ACs, design links, screens and routes,
   and a RISK SCAN naming every `riskPaths` area the ticket implies, plus the always-on risk
   of deleting or weakening an existing test.
3. **GATE A (ask the human) if any of:** no acceptance criteria and no design link; only
   subjective goals with no measurable anchor; the RISK SCAN found a risk-tier area (name it,
   ask for clearance). Otherwise proceed. Low-risk ambiguities get a default, appended to
   `<runDir>/assumptions.md` as `- Q: <question> → default: <choice> (risk: low)`.
   When a human clears a risk area, and only then:
   `node <SKILL_DIR>/scripts/ledger.js clear <runDir> "<the glob>" "<what they approved and why>"`
4. Decide FAST-TRACK (Stage 2) before recording the gate, then:
   `node <SKILL_DIR>/scripts/ledger.js gate <runDir> intake --evidence <runDir>/ticket-brief.md`

## Stage 2 — FAST-TRACK CHECK

FAST-TRACK applies only when ALL FOUR hold: (1) the change is describable in one sentence
without an "and"; (2) it touches roughly one module, or is one mechanical edit repeated;
(3) it adds no dependency, API or contract surface, route, auth or permissions behaviour, and
no `riskPaths` file; (4) there is one obvious way to build it. Any doubt about (3) fails it.
On fast-track, write `fast-track: <the sentence> — <why all four hold>` into
`ticket-brief.md`, skip Stages 3 and 5, implement inline at Stage 7, and keep everything
else (worktree, chain, frozen done-list, verification, ONE QA dispatch, report, close). If a
condition turns out false mid-way, stop, write the approach record, continue on the full path,
and say so in the report.

## Stage 3 — SURVEY

Size the footprint from `ticket-brief.md`:
- **Trivial** (1–2 files, obvious area): skip. Write `survey: skipped (trivial)` in `ledger.md`.
- **Feature or subsystem**: `node <SKILL_DIR>/scripts/survey.js <runDir> --worktree <wt>
  --paths <area dirs>` writes the top of `<runDir>/codebase-map.md`: the outline of those
  paths, stamped with HEAD. Read it. When it already answers what a slice needs (layers,
  conventions, neighbours), skip the explorer and say so in `ledger.md`; otherwise dispatch ONE
  read-only `Explore` agent (Stage 7 dispatch rules apply) for what the map lacks, and append
  its return under `## Explorer findings`. Then
  `node <SKILL_DIR>/scripts/ledger.js gate <runDir> survey --evidence <runDir>/codebase-map.md`
- **Whole-system** (redesign, rewrite, migrate everything): STOP. Tell the human to decompose
  it into sub-tickets and run the loop once per sub-ticket.
The map is context, never a contract: a survey finding becomes a criterion only through
Stage 6 or `done-additions.md`. Reusable findings go to memory with
`memory.js add <memoryFile> convention <TICKET> "<finding>"`.

## Stage 4 — DESIGN

Skip when LOGIC-ONLY (mark SKIPPED in the report). For each Figma link in the brief:
`get_metadata`, then `get_screenshot` → `<runDir>/screenshots/figma_<node>.png`, then
`get_design_context` (plus `get_variable_defs` when tokens are referenced). Write
`<runDir>/design-spec.md` with `#colors`, `#typography`, `#spacing`, `#assets`: exact values
only, each with its Figma node source, nothing guessed.
**GATE B (ask the human) if** the design contradicts the ticket text (different component,
conflicting behaviour, mismatched counts or labels); name the contradiction.
`node <SKILL_DIR>/scripts/ledger.js gate <runDir> design --evidence <runDir>/design-spec.md`

## Stage 5 — APPROACH

Skip when the survey was skipped (write `approach: skipped (trivial)` in `ledger.md`). When
`codebase-map.md` exists, `validate_done.js` refuses the freeze until `approach.md` exists.
YOU write `<runDir>/approach.md`; it costs no dispatch. Exactly these sections:

```markdown
# Approach — <TICKET>
## Data
- <entity touched>: owner/source of truth is <where>; this change <reads|writes|reshapes> it
## Boundary
- the change lives behind <layer/module/interface>; callers see <what stays stable>
## Options
- A: <approach> — <one-line tradeoff>
- B: <approach> — <one-line tradeoff>
## Chosen
- <A|B>: <why it wins and why the loser loses> | reuses: <existing module/helper this builds on>
## Failure modes
- <what can go wrong at runtime> | covered-by: C<n>
- <a failure mode consciously not handled> | covered-by: out-of-scope (<reason>)
## Slice order
- 1st: <the slice most able to prove this approach wrong> — <why>
- then: <remaining slices, cheapest information last>
```

Validated at Stage 6: at least two real options, one the cheapest that could work (reuse,
extend, do nothing); a Chosen with `reuses:` (`reuses: none (<what you searched and why
nothing applies>)` is accepted, a thin reason is not); every failure mode tagged
`covered-by:` with a criterion or a substantive out-of-scope reason, not all waived; no
duplicated headings. Echo out-of-scope failure modes in the done-list's `## Out of scope`.
A later design change goes under `## Revisions` as `- R<n>: <what changed> — because <what
reality proved wrong>`, then `ledger.js revise`; the QA judge BLOCKs an unrecorded one.

`node <SKILL_DIR>/scripts/ledger.js gate <runDir> approach --evidence <runDir>/approach.md`

## Stage 6 — DEFINE DONE

1. From the ACs, `design-spec.md` and `approach.md` (its failure modes MUST surface here as
   criteria or out-of-scope entries), write `<runDir>/done.draft.md`:

   ```markdown
   # Done — <TICKET>
   ## Criteria
   - [ ] C1 (test): when <trigger>, the system shall <observable response> | run: {verify.test} <test file to be written>
   - [ ] C2 (analyzer): zero analyzer errors | run: {verify.analyze}
   - [ ] C3 (token): <element> uses <value> | run: {verify.test} <token test file>
   - [ ] C4 (runtime): no overflow/console errors on <route> at 1440px and 768px | run: playwright:<check-id>
   - [ ] C5 (manual): <at most one eyeball check>
   ## Tokens
   - <name>: <value> (source: design-spec.md#<section>)
   - none (<why>)          ← when designSource is none / LOGIC-ONLY
   ## Out of scope
   - <explicit exclusions>
   ```

   Kinds: test | analyzer | runtime | token | manual. Drop token and runtime criteria when
   `designSource == none`, and the analyzer criterion when `verify.analyze` is null. Write
   each behaviour as trigger and response so it names the input that makes it fail. State
   every criterion absolutely ("the suite exits 0, including the N tests already in
   <file>"), never relative to a baseline: the validator refuses "no new", "baseline",
   "branch point", "pre-existing" and "subset of" unless the `run:` command performs the
   comparison.
   The validator enforces: at least one `(test)` or `(runtime)` criterion; unique well-formed
   `C<n>` ids; no pre-ticked box; every `run:` starting with the profile's `verify.test` or
   `verify.analyze` binary.
2. `node <SKILL_DIR>/scripts/validate_done.js <runDir>`. On exit 1 fix the draft and re-run.
3. `node <SKILL_DIR>/scripts/freeze_done.js <runDir>`. It refuses a draft never validated or
   edited since. It records the `freeze` gate; then
   `node <SKILL_DIR>/scripts/ledger.js gate <runDir> validate`.
   From here `done.md` and `done.approved.md` are read-only; new criteria go to
   `<runDir>/done-additions.md` (created header-only by the freeze) through
   `node <SKILL_DIR>/scripts/ledger.js addition <runDir> "- [ ] C<n> (kind): ... | run: ..."`.
4. **`--dry-run` ends here:** print the paths of the brief, design-spec, approach (if any) and
   frozen done-list with a three-line summary of each, and stop. Say that the run stays active
   (the guard keeps protecting the run dir) until a later `/ticket-loop <TICKET>` RESUMEs it
   or `ledger.js archive <runDir>` retires it.

## Stage 7 — IMPLEMENT

One slice per AC, or per criterion when finer, in `approach.md`'s `## Slice order`
(riskiest first; any sensible order without an approach). All work happens in `<wt>`.
**Before each slice**, dispatched or inline, declare the files it is expected to touch (from
`## Boundary` and the map; globs allowed, every layer the slice crosses):
`node <SKILL_DIR>/scripts/ledger.js slice <runDir> <C-id> --files <glob>[,<glob>]`
Stage 9 lists every changed file outside all declared scopes; needing one is allowed and
recorded, not hidden.

**Inline or dispatch.** Do a slice yourself, with the same TDD discipline, the implementer
prompt's ladder, and the same ledger entry, when it is test-only or a one-file change expected
under `dispatchPolicy.minSliceLines` (default 50). Dispatch when the slice is feature-sized,
needs a fresh context, or is the QA judge. **Before EVERY dispatch** (survey, implementer,
fixer, QA): `node <SKILL_DIR>/scripts/ledger.js dispatch <runDir> "<kind>: <slice-or-check> [<model>]"`
Exit 2 means the budget is exhausted: do not dispatch; go to Stage 11 as INCOMPLETE. The
`dispatch_guard` hook counts the tool call either way; this call labels it for the report.
**When a dispatch returns**, seal what it cost, using the total tokens and duration the Agent
tool reports on completion and never an estimate:
`node <SKILL_DIR>/scripts/ledger.js outcome <runDir> <seq> ok "<note>" --tokens <n> --ms <n>`

**Implementer dispatch:** `prompts/implementer.md`, filling `{TICKET}`, `{WORKTREE_PATH}`,
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
any kind when null. Commits happen only in the worktree; never push, never touch main.

## Stage 8 — VERIFY

Record every result as you go, naming how it was established:
`node <SKILL_DIR>/scripts/ledger.js check <runDir> <C-id> PASS|FAIL|SKIPPED --by <method> "<note>"`
Methods: `command` (a command ran and its exit code decided), `observed` (the running system
was exercised and seen), `human` (a person confirmed; the only way a `(manual)` criterion
passes), `asserted` (concluded from source or a summary; can back only SKIPPED). Read the
command's own exit code, never a pipe's: redirect output to a file if it is long. Mirror each
result into `ledger.md`'s check-history table.

1. `{verify.analyze}` → zero errors (skip when null).
2. `{verify.test}` → full suite green. Goldens or snapshots excluded from it are SKIPPED
   (local-only convention) and go under "not verified", never inside COMPLETE.
3. Token criteria (when `designSource != none`): run their named test files.
4. Runtime criteria (SKIPPED when LOGIC-ONLY or Playwright is down): launch the app per the
   repo's run conventions; per criterion navigate to the route, require a clean
   `browser_console_messages` (no errors, no "RenderFlex overflowed"), assert key elements via
   `browser_snapshot`, and `browser_take_screenshot` at 1440px and 768px →
   `screenshots/runtime_<check>_<width>.png`. A launch that fails three times marks every
   runtime criterion SKIPPED (app launch failure); the run continues.
5. All green → `git -C <wt> commit` as `verify green` →
   `node <SKILL_DIR>/scripts/ledger.js gate <runDir> verify` → Stage 9.
   Any FAIL → Stage 10.

## Stage 9 — ADVERSARIAL QA

1. `node <SKILL_DIR>/scripts/ledger.js qascope <runDir> --worktree <wt>` prints `scope`
   (FOCUSED, FULL, or DELTA after a verdict when the fix stayed inside the files that judge
   read), `why`, `outsideScope` and `label`. Use the label verbatim in `ledger.js dispatch`.
2. Dispatch ONE judge with **`subagent_type: ticket-loop-qa`** (no Write or Edit; never
   substitute a general-purpose agent) using `prompts/qa_agent.md`. Fill `{TICKET}`,
   `{RUN_DIR}` (`<runDir>`), `{SCRIPTS_DIR}` (`<SKILL_DIR>/scripts`), `{DIFF}`
   (`git -C <wt> diff <base>..HEAD`, `git -C <wt> status --porcelain`, `git -C <wt> diff HEAD`;
   say when status is non-empty; past `dispatchPolicy.promptBudgetChars`, give the `--stat`
   plus those commands for the judge to run itself), `{CHECK_RESULTS}` (from `ledger.js status`),
   `{CONVENTIONS}` (codebase-map.md plus `stack`, or "the conventions evident in the
   surrounding code"), `{QA_SCOPE}` (FOCUSED: "read the changed files, every file that imports
   or consumes them, and the contract artifacts; skip the wider sweep" / FULL: "sweep as widely
   as the contract and diff warrant" / DELTA: "a judge ruled at verdict seq <n>; the prior
   findings and the change since <since> are below; confirm each finding is resolved and
   nothing regressed", with `{DIFF}` then being those findings verbatim plus
   `git -C <wt> diff <since>`). When `outsideScope` is non-empty, append "Changed outside every
   declared slice scope: <files>" to `{QA_SCOPE}`. Do NOT paste the contract files.
3. The judge seals its own verdict. Then `node <SKILL_DIR>/scripts/ledger.js require <runDir> qa`
   must pass and `ledger.js status` must show the verdict; without a sealed verdict the QA pass
   did not happen. Then `node <SKILL_DIR>/scripts/ledger.js gate <runDir> qa`.
4. BLOCK → Stage 10 as QA_BLOCK with the findings verbatim. APPROVE WITH COMMENTS → findings
   into the report, Stage 11. APPROVE → Stage 11.

## Stage 10 — FAILURE LOOP

| class | trigger | route |
|---|---|---|
| BUILD | analyzer or compile errors | dispatch `prompts/fixer_build.md` on a general-purpose agent, filling `{ERROR_OUTPUT}` with the full output, `{VERIFY_ANALYZE}`/`{VERIFY_TEST}` with the resolved commands, `{FILES}` with the slice's files |
| TEST | assertion failures | dispatch the implementer with the failure output and the ledger |
| TOKEN | token test mismatch | dispatch `prompts/fixer_ui.md` |
| RUNTIME | console errors, overflow, missing element | retry once free; then implementer with the evidence |
| QA_BLOCK | Stage 9 verdict BLOCK | dispatch the implementer with the findings verbatim; a finding that needs a new criterion goes in with `ledger.js addition`; then Stage 9 again, where `qascope` decides whether the re-review is a DELTA |
| GOLDEN_UPDATE_REQUIRED | a golden test failed | no retry, no strike; record in ledger and report with diff evidence; run continues; report it as NOT verified |
| FLAKY_VERIFIER | the same check alternates PASS/FAIL in the sealed check history | flag in report; not a code failure; not an attempt |

FLAKY_VERIFIER needs `ledger.js status` to show the alternation. One failure is a failure.

**Fixer fill:** `{CHECK_ID}` (the failing check), `{EXPECTED}` (the asserted value from
design-spec.md or the criterion), `{ACTUAL}` (the failing evidence verbatim), `{FILES}` (files
implicated by the failing check), plus `{TICKET}`, `{WORKTREE_PATH}`, `{LEDGER_FORBIDDEN}`.

After every attempt, append to `ledger.md` under `## Attempts`:

```markdown
### Attempt <N> — <class> — <check-id>
- hypothesis: <why it failed>
- change: <what was tried>
- result: PASS | FAIL — <one-line reason>
- forbidden-now: <approach that must not be repeated>
```

Rules: inject every `forbidden-now` line into every retry prompt, and reject a retry that
repeats one. Three failed attempts in one class →
`node <SKILL_DIR>/scripts/ledger.js replan <runDir>`; exit 2 → Stage 11 as INCOMPLETE;
otherwise write a materially different approach for that slice (structure, state placement or
data flow, not a parameter), record it under `## Revisions` in `approach.md`, `ledger.js revise`
it, and continue. A dispatch exit 2 → Stage 11 as INCOMPLETE. When you flag FLAKY_VERIFIER, and
when a non-obvious fix finally works: `memory.js add <memoryFile> flaky|fix <TICKET> "<note>"`.

## Stage 11 — REPORT AND CLOSE

1. Fill `<SKILL_DIR>/report-template.md` → `<runDir>/report.md`: every criterion as PASS,
   FAIL or SKIPPED(reason); assumptions verbatim; FLAKY and GOLDEN flags; toolchain line;
   wall-clock; counters from `ledger.js status`; for each visual criterion the Figma PNG and
   runtime capture paths. Paste verbatim, never summarise:
   `node <SKILL_DIR>/scripts/ledger.js cost <runDir> --worktree <wt>` into Cost (proxies only,
   never a token count) and `node <SKILL_DIR>/scripts/ledger.js verify <runDir>` into
   Integrity. Exit 4 → `Integrity: TAMPERED`, problems verbatim, escalate. `Status:` is the
   work and `Integrity:` the history; report them separately. `revisions` in the output are
   recorded edits, listed with their reasons.
2. With `--update-jira`, post the Summary as a comment via the configured source (Atlassian MCP,
   `gh issue comment`, `glab issue note`, Trello MCP); skip for `manual`. Never transition
   ticket status. If `memoryFile` is set, add reusable lessons with `memory.js add` and list
   them in the report.
3. `node <SKILL_DIR>/scripts/ledger.js gate <runDir> report --evidence <runDir>/report.md`
   then `node <SKILL_DIR>/scripts/ledger.js close <runDir>`. Close LAST: every recording
   command refuses afterwards. An abandoned run ends with `ledger.js archive` instead.
4. Final message: status (COMPLETE, or INCOMPLETE and why), report path, branch name, the
   integrity line from `ledger.js verify`, that merge, push and golden regeneration are
   manual, and plainly what was NOT verified: excluded goldens, every SKIPPED criterion, every
   stop_gate "NOT verified" note, and on a LOGIC-ONLY run every visual and contract check.
