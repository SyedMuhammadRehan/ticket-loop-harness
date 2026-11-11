---
name: ticket-loop
description: Use when the user types /ticket-loop <TICKET-ID or task text>, optionally with --dry-run or --update-jira, or asks to take a Jira, GitHub, GitLab or Trello ticket (or a pasted task) all the way to a reviewed branch with hook-enforced gates, adversarial QA and an evidence report. The target repo must carry .agents/ticket-loop.config.json.
---

# Ticket Loop

You are the ORCHESTRATOR. You dispatch subagents, record receipts, and implement inline only
where a stage says so. Hands-off: never ask "should I continue?"; ask a human only at
GATE A, GATE B, GATE C and the RESUME prompt.

## The loop — do this, and only this, until the run is closed

The procedure is one file per stage. Never work a stage from memory: the sealed chain says
where the run stands, and the stage file says what to do there.

1. `node ${CLAUDE_SKILL_DIR}/scripts/ledger.js next <runDir>` prints the stage the run is at,
   why, the stage file(s) to read, what is gated, and each criterion's result.
2. Read every file it names, in full, with the Read tool, and do exactly what it says.
3. When that stage's gate is recorded, or the stage is skipped with its sealed reason
   (`ledger.js skip`), go back to 1. Stop when `next` says CLOSED.

Run 1 again whenever you are unsure where you are, after any compaction or interruption, and
on RESUME. With no run yet it sends you to Stage 0.

`<SKILL_DIR>` is `${CLAUDE_SKILL_DIR}`; `next` prints it on every call. The write guard refuses
the scripts from anywhere else. `<runDir>` is `<repo>/.agents/ticket-runs/<TICKET>`, absolute.
`<wt>` is `<worktreePrefix><TICKET>`.

## Rules that hold in every stage

**Commands.** Each harness call is one bare command, `node <SKILL_DIR>/scripts/<script> <args>`:
no variable for the path, nothing chained with `&&`, `;` or `|`. **Working directory:** the MAIN
repo root; reach the worktree with `git -C <wt>` or absolute paths, never `cd`. Run every
`{verify.*}` command in the worktree as `node <SKILL_DIR>/scripts/run_in.js <wt> <command>`.
**Config keys:** `{verify.test}`, `{verify.analyze}`, `{verify.pubGet}`, `{verify.codegen}`
mean the profile's resolved values. Substitute them; never infer a stack from the files you see.
**Run dir:** created with its `screenshots/` subdir by `ledger.js init` at Stage 0. The write
guard refuses `mkdir` and shell writes there: edit its files with Edit/Write, and before gating
them. Counters, check results, verdicts and gates live in a sealed chain under
`<gitdir>/ticket-loop/<TICKET>/`, written only by `ledger.js`; `budget.json` is a read-only
mirror and `ledger.md` the human narrative.
**Asking the person.** When `_meta.notify.canReply`, ask in the session AND with
`notify.js ask "<q naming the glob>" --option .. --option .. --run <runDir>` (approval seq →
`ledger.js clear ... --approval <seq>`); no answer means park that slice and do the rest.
**Constants:** STRIKES_PER_CLASS=3, MAX_REPLANS=2, MAX_DISPATCHES=25.
**Failure classes:** BUILD, TEST, TOKEN, RUNTIME, QA_BLOCK, GOLDEN_UPDATE_REQUIRED, FLAKY_VERIFIER.

**What is mechanical, and what is yours.** Hooks and scripts enforce the caps, the freeze, the
risk-path fence, the gates, the sealed record and publishing; README.md lists each and gives
the reason for every rule. Yours, and visible in the report when missed: pasting
`ledger.js verify` verbatim; GATE B; honest failure classes; keeping additions additive;
recording dead dispatches; never recording a clearance, raise, consent or skip a human would
not stand behind.

**Editing a document after a receipt sealed it:** record it first, on every such edit:
`node <SKILL_DIR>/scripts/ledger.js revise <runDir> <file> --reason "<what changed and why>"`
A gate seals the file named as its `--evidence` (`approach.md`, and `ledger.md` when you cite
it). Until then a file is freely editable. `done.md`, `*.approved.md` and the profile are refused
outright. `done-additions.md` is never revised or hand-edited after a verdict: a new criterion
goes in with `ledger.js addition <runDir> "<criterion line>"`, which appends and re-seals it.

## Stages

Each is `<SKILL_DIR>/stages/<file>`. `next` names the one to read; this list is the map.

| Stage | File | Ends when |
|---|---|---|
| 0 Preflight | `00-preflight.md` | `ledger.js init` has created the run |
| 1 Intake | `01-intake.md` | gate `intake` |
| 2 Fast-track check | `02-fast-track-check.md` | decided, inside Stage 1 |
| 3 Survey | `03-survey.md` | gate `survey`, or `skip survey` |
| 4 Design | `04-design.md` | gate `design`, or `skip design` |
| 5 Approach | `05-approach.md` | gate `approach`, or `skip approach` |
| 6 Define done | `06-define-done.md` | gates `freeze` and `validate` (`--dry-run` stops here) |
| 7 Implement | `07-implement.md` | every slice green and committed |
| 8 Verify | `08-verify.md` | gate `verify` |
| 9 Adversarial QA | `09-adversarial-qa.md` | a sealed verdict and gate `qa`; the judge is `ticket-loop-qa` |
| 10 Failure loop | `10-failure-loop.md` | the failing check or BLOCK is resolved |
| 11 Report and close | `11-report-and-close.md` | `ledger.js close` |
