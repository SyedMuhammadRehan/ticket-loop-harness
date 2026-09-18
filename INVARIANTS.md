# Invariants

Every guarantee this harness makes, the code that enforces it, and the test that fails when
that code is removed. If a row cannot name all three, the guarantee does not exist — delete
the claim or write the mechanism.

`tests/invariants.test.js` parses this file and fails when a cited symbol or test no longer
exists, so a rename or deletion cannot quietly leave the table describing a harness that is
no longer there. It checks that the references RESOLVE; it cannot check that the test still
proves what the row claims. That part is review, and it is why the "why it exists" column is
not decoration — a reviewer who cannot reconstruct the failure being prevented should treat
the row as suspect.

Read this before changing the enforcement layer. Both defects found in the fourth adversarial
review were interactions between two rows below, which the code alone did not make visible.

## Receipt chain

| # | Invariant | Enforced by | Killed by | Why it exists |
|---|---|---|---|---|
| 1 | An altered record is detected | `chain.js` → `verify` | `chain.test.js` :: `editing a record breaks its seal` | A history that can be rewritten is not a history |
| 2 | A record removed from the middle is detected | `chain.js` → `verify` | `chain.test.js` :: `deleting a record from the middle breaks the prev-link` | Seals alone do not order records |
| 3 | Records dropped off the END are detected | `chain.js` → `writeHead` | `chain.test.js` :: `dropping the LAST records is detected by the head anchor` | Truncation needs no key: every remaining record still verifies |
| 4 | An emptied chain is not read as a fresh run | `chain.js` → `verify` | `chain.test.js` :: `emptying the chain file is detected rather than reading as a fresh run` | Zero records would otherwise zero every counter |
| 5 | The head anchor is itself sealed | `chain.js` → `headSeal` | `chain.test.js` :: `editing the head anchor is itself detected` | An unsealed anchor just moves the forgery one file over |
| 6 | Seals are keyed, not bare hashes | `chain.js` → `sealOf` | `chain.test.js` :: `a history rewritten and re-sealed under the wrong key does not verify` | A bare hash is recomputable by anyone |
| 7 | The chain lives outside the run dir | `chain.js` → `resolveChainDir` | `chain.test.js` :: `the chain lives outside the run dir, under the git dir` | A record inside the namespace the loop writes to is not a record |
| 8 | Concurrent appends do not corrupt it | `chain.js` → `withLock` | `chain.test.js` :: `concurrent appends keep the chain intact` | Parallel dispatches would otherwise both claim one seq |

## Budget

| # | Invariant | Enforced by | Killed by | Why it exists |
|---|---|---|---|---|
| 9 | The cap binds at the tool call, not on request | `dispatch_guard.js` → `main` | `dispatch_guard.test.js` :: `the cap is enforced at the tool call, not by asking nicely` | A script that exits 2 when asked enforces nothing |
| 10 | Editing the mirror cannot raise the cap | `ledger.js` → `caps` | `ledger.test.js` :: `editing budget.json cannot raise the cap or reset the count` | budget.json is a mirror; the chain governs |
| 11 | Archive + re-init cannot reset the count | `ledger.js` → `cmdInit` | `ledger.test.js` :: `archive + re-init cannot silently reset the budget` | Moving the run dir used to be a free budget reset |
| 12 | Writing report.md does not release the budget | `dispatch_guard.js` → `activeRuns` | `dispatch_guard.test.js` :: `writing report.md does NOT release the budget — only a sealed close does` | The loop's own deliverable must not be its off switch |
| 64 | A dispatch with no outcome blocks the "done" claim | `stop_gate.js` → `openDispatchFailures` | `stop_gate.test.js` :: `a dispatch with no outcome blocks the "done" claim until it is recorded` | A stalled worker and a forgotten outcome are both invisible until something refuses to proceed over them |
| 65 | A run cannot close over an open dispatch | `ledger.js` → `openDispatches` | `ledger.test.js` :: `a dispatch with no outcome is listed as open, and close refuses until it is resolved` | Close releases the gates; whatever is unaccounted for then never will be |
| 66 | A subagent's return is recorded without the orchestrator | `subagent_return.js` → `recordReturn` | `subagent_return.test.js` :: `a subagent return is recorded against the oldest dispatch still out, with the agent named` | Only the mark tells a stall from an unrecorded result |
| 67 | An unresolved dispatch is named before the next slot is spent | `dispatch_guard.js` → `unresolvedContext` | `dispatch_guard.test.js` :: `the next dispatch is told about a return with no outcome, and not about a fresh label` | Between dispatches nothing else runs where the orchestrator would see it |

## Stage receipts

| # | Invariant | Enforced by | Killed by | Why it exists |
|---|---|---|---|---|
| 13 | A receipt costs the artifact it claims | `ledger.js` → `STAGE_PROOF` | `ledger.test.js` :: `gate refuses to seal evidence that does not exist` | Ten gates would otherwise be ten free commands |
| 14 | Sealed evidence that changes is TAMPERED | `ledger.js` → `cmdVerify` | `ledger.test.js` :: `evidence sealed by a gate is reported as TAMPERED when it changes afterwards` | A receipt over a file that then changed attests to nothing |
| 15 | An UNRECORDED edit to a sealed file is still TAMPERED | `ledger.js` → `cmdRevise` | `ledger.test.js` :: `an unrecorded edit to a sealed file is still TAMPERED` | Revisions must not become a general amnesty (see 16) |
| 16 | The frozen contract can never be revised | `ledger.js` → `UNREVISABLE` | `ledger.test.js` :: `revise refuses frozen artifacts and the enforcement profile` | A contract restatable after the freeze is not a contract |
| 44 | A result must name how it was established | `ledger.js` → `CHECK_METHODS` | `ledger.test.js` :: `check refuses a result with no method named` | PASS|FAIL|SKIPPED cannot distinguish a suite that ran from source that was read |
| 45 | Concluding something works is not a pass | `ledger.js` → `cmdCheck` | `ledger.test.js` :: `an asserted PASS is refused; an asserted SKIPPED is accepted` | SKIPPED already says "not established" without claiming it holds |
| 46 | A manual criterion needs a person | `ledger.js` → `frozenKindOf` | `ledger.test.js` :: `a manual criterion cannot be passed by a command` | Keyed off the FROZEN contract's own kind, not a second list |
| 47 | The chosen design must name what it reuses | `validate_done.js` → `chosen` | `validate_done.test.js` :: `the chosen option must say what it reuses` | Rung 2 answered while it is a sentence, not a diff |
| 17 | A verdict must seal the contract it judged | `ledger.js` → `cmdVerdict` | `ledger.test.js` :: `a verdict that seals no contract is refused` | "APPROVE" over nothing cannot show what was judged |

## End of run

| # | Invariant | Enforced by | Killed by | Why it exists |
|---|---|---|---|---|
| 18 | A closed run refuses further records | `ledger.js` → `requireOpen` | `ledger.test.js` :: `mutating a closed run is refused` | The gates were lifted against the receipts as they stood |
| 19 | Records appended after close are reported | `ledger.js` → `cmdVerify` | `ledger.test.js` :: `verify reports records appended after close` | Post-close appends seal and link perfectly; only the marker catches them |

## The freeze

| # | Invariant | Enforced by | Killed by | Why it exists |
|---|---|---|---|---|
| 20 | An unvalidated draft cannot be frozen | `freeze_done.js` → `refusing to freeze` | `freeze_done.test.js` :: `refuses to freeze a draft that was never validated` | Validation was advisory before this |
| 21 | A draft edited after validation cannot be frozen | `freeze_done.js` → `refusing to freeze` | `freeze_done.test.js` :: `refuses to freeze a draft that changed after validation` | Otherwise validate-then-weaken is free |
| 22 | Frozen artifacts refuse every write surface | `guard_policy.js` → `pathVerdict` | `freeze_guard.test.js` :: `blocks Edit/Write to frozen done.md, *.approved.md and budget.json` | Editing the contract is how a run passes itself |

## Control plane

| # | Invariant | Enforced by | Killed by | Why it exists |
|---|---|---|---|---|
| 23 | The profile and hooks are frozen mid-run | `guard_policy.js` → `CONTROL_PLANE_PATTERNS` | `freeze_guard.test.js` :: `blocks writes to the enforcement control plane while a run is active` | Changing what the gates check while they gate |
| 24 | Writing report.md does not release the freeze | `freeze_guard.js` → `activeRuns` | `freeze_guard.test.js` :: `writing report.md does NOT release the control plane` | Same off-switch failure as 12 |
| 25 | Malformed hook input never wedges a session | `freeze_guard.js` → `readStdinJson` | `freeze_guard.test.js` :: `malformed stdin exits 0 (never wedges the whole session)` | A broken install must not break unrelated projects |
| 26 | Publishing is refused while a run is active | `guard_policy.js` → `PUBLISHING` | `guard_policy.test.js` :: `publishing is refused while a run is active` | Merge and push are the human's decision |
| 63 | A write reaching the run dir through a variable, a loop body, `xargs` or a `find` flag is refused; the same shapes that only read are not | `guard_policy.js` → `isReadOnly` | `guard_policy.test.js` :: `the same shapes carrying a write are still denied` | A guard that refuses reading is one operators learn to route around |

## Risk paths

| # | Invariant | Enforced by | Killed by | Why it exists |
|---|---|---|---|---|
| 27 | Risk-tier paths are fenced until cleared | `guard_policy.js` → `riskVerdict` | `freeze_guard.test.js` :: `an edit under a riskPaths glob is denied while a run is active` | GATE A/C was prose before this |
| 28 | A clearance opens only the glob it names | `guard_policy.js` → `riskVerdict` | `freeze_guard.test.js` :: `a recorded clearance unlocks only the area it names` | One clearance must not open every risk area |
| 29 | A damaged clearance mirror denies | `freeze_guard.js` → `clearedGlobs` | `freeze_guard.test.js` :: `a malformed clearance mirror denies rather than opening everything` | Fail closed, not open |

## The contract

| # | Invariant | Enforced by | Killed by | Why it exists |
|---|---|---|---|---|
| 37 | A done-list must test behaviour, not only lint | `validate_done.js` → `behavioural` | `validate_done.test.js` :: `an analyzer-only done-list proves nothing about behaviour — fails` | Analyzer-only contracts were the cheapest way to be trivially green |
| 38 | Criteria cannot be pre-ticked before the freeze | `validate_done.js` → `preTicked` | `validate_done.test.js` :: `criteria pre-ticked before the freeze fail` | A frozen contract describes work that has not happened |
| 39 | A criterion must run the repo's real verify command | `validate_done.js` → `expectedFor` | `validate_done.test.js` :: `a command that performs the comparison is accepted; a stand-in is not` | `run: true` would let a criterion certify itself |
| 40 | Every failure mode carries a covered-by tag | `validate_done.js` → `failureModes` | `validate_done.test.js` :: `failure mode without a covered-by tag fails` | An untagged failure mode is a risk nobody owns |
| 41 | An out-of-scope waiver needs a real reason | `validate_done.js` → `MIN_OUT_OF_SCOPE_REASON` | `validate_done.test.js` :: `an out-of-scope "reason" too thin to be a decision fails` | "(later)" is the absence of a decision wearing its syntax |
| 42 | A design with no alternative considered is a guess | `validate_done.js` → `options` | `validate_done.test.js` :: `a single option is a guess, not a decision — fails` | The approach is a decision record, and one option records nothing |

## The "done" claim

| # | Invariant | Enforced by | Killed by | Why it exists |
|---|---|---|---|---|
| 31 | Committed slice work is verified, not just the dirty tree | `stop_gate.js` → `changedSourceFiles` | `stop_gate.test.js` :: `COMMITTED slice work is detected — a clean-but-ahead worktree is still verified` | Stage 4 commits after every green slice, so mid-run every tree is clean |
| 32 | The ticket worktree is checked, not only the cwd | `stop_gate.js` → `treesToCheck` | `stop_gate.test.js` :: `verifies the ticket worktree, not just the cwd tree` | All implementation happens in the worktree |
| 33 | A tiny timeoutMs cannot disable the gate | `stop_gate.js` → `MIN_TEST_TIMEOUT_MS` | `stop_gate.test.js` :: `a tiny timeoutMs cannot disable the gate (it is floored)` | A 50ms timeout would turn every run into "could not verify" |
| 34 | An unusable stopGate config blocks mid-run | `stop_gate.js` → `activeRuns` | `stop_gate.test.js` :: `an active run with an unusable stopGate config BLOCKS instead of passing silently` | A deleted block is what disarming this gate looks like |
| 35 | Filters that match nothing say so | `stop_gate.js` → `applyFilters` | `stop_gate.test.js` :: `a profile whose filters match nothing says so instead of passing quietly` | Silently verifying zero files reads identically to a green run |
| 36 | Outside a run the gate runs nothing at all | `stop_gate.js` → `verifyTree` | `stop_gate.test.js` :: `outside a run the gate runs nothing, even when changed files match` | A repo keeps its profile permanently; verifying every turn-end would tax unrelated sessions |
| 43 | Mid-run the same tree still blocks on red | `stop_gate.js` → `verifyTree` | `stop_gate.test.js` :: `the identical situation mid-run still blocks on a red suite` | Row 36 must not turn the gate off altogether |
| 49 | A debug artefact the change added blocks a "done" claim | `hygiene.js` → `DEBUG_ARTEFACTS` | `stop_gate.test.js` :: `a green suite still blocks when the change adds a debug artefact` | A stray console.log passes every test that exists |
| 50 | An apparent secret blocks, and its value is never echoed back | `hygiene.js` → `SECRET_ASSIGNMENT` | `hygiene.test.js` :: `a credential-shaped assignment is reported, without echoing the value` | The gate's output is fed to the session, so printing the value would spread it |
| 51 | Only lines the change ADDED are judged | `hygiene.js` → `addedLines` | `hygiene.test.js` :: `pre-existing logging on an untouched line is not reported` | A gate that fires on code the change did not touch is one people learn to route around |
| 52 | QA reading scope is computed, not eyeballed, and sized by insertions | `ledger.js` → `cmdQaScope` | `qascope.test.js` :: `a large deletion is FOCUSED — nothing was added to review` | Summing insertions and deletions bought a full-codebase sweep for changes that added nothing |
| 53 | A risk-path touch is FULL scope at any size | `ledger.js` → `cmdQaScope` | `qascope.test.js` :: `a one-line change in a risk path is FULL regardless of size` | Where the blast radius is the point, "how much" is the wrong question |
| 54 | Dependencies are reused only when the lockfile is identical | `worktree_deps.js` → `sameFile` | `worktree_deps.test.js` :: `a different lockfile installs instead of reusing` | Verifying against a dependency tree the branch does not resolve to makes every downstream check a lie |
| 55 | A dispatch's token figure is the one the tool reported, sealed on its outcome, or nothing | `ledger.js` → `wholeNumberFlag` | `ledger.test.js` :: `outcome refuses a token count or duration that is not a whole number` | A typo stored as null would read as "not measured"; an estimate would read as a measurement |
| 56 | A re-review reads only the delta when the fix stayed inside the files the prior judge read | `ledger.js` → `deltaSinceVerdict` | `qascope.test.js` :: `a fix that touches a file the judge never read escalates back to a size-based scope` | Six full re-reads per run was the largest repeated cost in the field; the escalation is what makes the saving safe |
| 57 | A change outside every declared slice scope is listed for the judge, never left to be noticed | `ledger.js` → `cmdSlice` | `qascope.test.js` :: `a changed file outside every declared slice scope is listed for the judge` | Drift found only if the judge happens to look is drift that ships |
| 58 | An outline names the commit its line numbers were read from | `outline.js` → `headSha` | `outline.test.js` :: `the outline is stamped with the HEAD it was read from` | Line numbers from a tree that has since moved are worse than none |
| 59 | A criterion added after a verdict is appended by the harness and re-sealed; any other change to the additions file stays TAMPERED | `ledger.js` → `cmdAddition` | `additions.test.js` :: `a criterion appended through the harness after a verdict is re-sealed, a hand edit is still TAMPERED` | The QA-BLOCK path adds a criterion by design, and a verdict seals the file; without an additive-only writer the designed path ended every such run TAMPERED |
| 60 | "No tokens" is refused only when a design spec exists to bind them to | `validate_done.js` → `hasDesignSpec` | `validate_done.test.js` :: `"none" is accepted under a design-source profile when no design spec exists (LOGIC-ONLY)` | A figma profile is the repo's default, not a promise that every ticket carries a design link |
| 61 | A whole-file read of a long source file during a run is offered the file's outline first | `read_hint.js` → `forRead` | `read_hint.test.js` :: `a whole-file Read of a long source file gets its outline as context` | "Read narrowly" in a prompt is advice the model may skip; a hint at the moment of the read is not |
| 62 | The codebase map names the paths and the commit it was built from, and is built by this plugin alone | `survey.js` → `writeMap` | `survey.test.js` :: `the map is stamped with the source command and the HEAD it was read from` | A map with no provenance cannot be judged stale; a map produced by someone else's tool is a stage nobody here can read or test |

## Preflight

| # | Invariant | Enforced by | Killed by | Why it exists |
|---|---|---|---|---|
| 30 | A missing stopGate block is reported at Stage 0 | `load_config.js` → `stopGateWarnings` | `load_config.test.js` :: `missing hooks.stopGate is a preflight warning naming the wedge` | Mid-run it is unfixable: the gate blocks and the profile is frozen |
| 48 | A verify.test whose exit code is discarded, or replaced by an inline one-liner, is reported at Stage 0 | `verify_falsifiable.js` → `verifyTestWarnings` | `verify_falsifiable.test.js` :: `a trailing ; exit 0 is reported as unfalsifiable` | The stop gate's verdict IS this command's exit code, so one that cannot go red certifies every turn-end while proving nothing |

## Not invariants — judgement, and named as such

These have no row above because no code enforces them. They live in README's "Yours to
uphold" and must stay there rather than migrating into this table:

- whether a human was really asked before a clearance was recorded
- GATE B (a design that contradicts the ticket)
- whether a revision reason is true
- whether a `died` dispatch outcome was reported at all
- whether the work is actually *good* — every row above proves the record is intact, none
  proves the output is right
