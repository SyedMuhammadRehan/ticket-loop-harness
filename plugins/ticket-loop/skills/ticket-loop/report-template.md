# Ticket Loop Report — {TICKET}

Status: {COMPLETE | INCOMPLETE — <why>}
Branch: {BRANCH} (worktree {WORKTREE}) — merge/push are manual
Duration: {WALL_CLOCK} | Dispatches: {N}/{MAX} | Re-plans: {N}/{MAX}
Toolchain: {TOOLCHAIN_LINE from stage 0}
Profile: stack={STACK}, ticketSource={TICKET_SOURCE}, designSource={DESIGN_SOURCE}
Verify commands: analyze=`{VERIFY_ANALYZE}` test=`{VERIFY_TEST}`

## Integrity

Paste the output of `node <SKILL_DIR>/scripts/ledger.js verify <runDir>` verbatim. It is the
machine check that the receipt chain is intact, that the frozen contract still matches what
was sealed at the freeze, that the profile has not drifted mid-run, and that budget.json
agrees with the sealed counters.

```
{LEDGER_VERIFY_OUTPUT}
```

Integrity: {INTACT | TAMPERED — list every problem line above and STOP; do not claim COMPLETE}
Stage receipts: {list of recorded gates, e.g. intake, design, approach, validate, freeze, verify, qa}
Restarts: {none | retired chain.N.jsonl at <seal> — say why the run was restarted}

## Cost

Paste the output of `node <SKILL_DIR>/scripts/ledger.js cost <runDir> --worktree {WORKTREE}`.
These are PROXIES from the sealed chain and git, not token counts — nothing outside the model
can observe tokens, so a figure here would only be this loop's own word.

```
{LEDGER_COST_OUTPUT}
```

`linesPerDispatch` is the number to watch across runs: it falls when implementers reuse what
already exists and rises when they rewrite. A `diffVsBase` far larger than the criteria
warranted is a finding, not a triumph — and the QA judge's avoidable-code check should
already have said so.

## Criteria evidence

Every criterion from done.approved.md plus every entry in done-additions.md. No criterion may
be omitted; SKIPPED requires a reason.

| # | criterion | result | evidence |
|---|---|---|---|
| C1 | {criterion text} | PASS \| FAIL \| SKIPPED | {test file + counts, or command output line, or reason} |

Criteria added after the freeze (from done-additions.md): {none | list with why each was added}

## Check history

From the sealed `check` receipts (`ledger.js status`), oldest→newest per check. This is what
substantiates any FLAKY_VERIFIER claim — an alternating history must be visible here, not
asserted in prose.

| check | results | classification |
|---|---|---|
| C3 | FAIL → PASS | fixed on attempt 2 |

## QA verdict

Verdict: {APPROVE | APPROVE WITH COMMENTS | BLOCK}
Recorded: {seq + timestamp of the sealed verdict receipt}
Judged inputs: {the files sealed in the verdict receipt — this shows WHICH contract was judged,
and that it was the frozen one rather than a summary of it. It does not show which process
recorded the verdict: if `ledger.js verify` reported the judge's independence as unverified,
say so here in those words.}

Findings:
- [{COMMENT|BLOCK}] {file:line or AC#} — {finding, verbatim from the judge}

## Assumptions

Echoed verbatim from assumptions.md (do not paraphrase):

- Q: {question} → default: {choice} (risk: low)

## Design decisions

{From approach.md: the chosen option and why the alternative lost. "n/a — trivial ticket" if
Stage 2.5 was skipped. Include any `## Revisions` entries — a re-plan is a design change and
belongs in the record.}

## Known gaps / follow-ups

- {QA comments left for the human's call}
- {GOLDEN_UPDATE_REQUIRED flags — goldens are NOT run by the loop; regeneration is manual}
- {FLAKY_VERIFIER flags, with the check history above as evidence}
- {anything marked SKIPPED and why: LOGIC-ONLY run, Playwright unavailable, app launch failure}

## Manual actions still required

- Review the branch and merge (the loop never pushes or merges)
- {Regenerate goldens, if flagged}
- {Promote any captured memory Pending items into Lessons: list what was captured}
