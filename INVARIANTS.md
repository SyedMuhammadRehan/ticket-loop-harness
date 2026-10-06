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
| 64 | A dispatch gone quiet past the threshold blocks the turn; one still working does not | `stop_gate.js` → `openDispatchFailures` | `stop_gate.test.js` :: `a turn may end while agents work, but a dispatch gone quiet past the threshold blocks it` | A stalled worker is invisible until something refuses to proceed over it; a background agent at work must not be |
| 65 | A run cannot close over an open dispatch | `ledger.js` → `openDispatches` | `ledger.test.js` :: `a dispatch with no outcome is listed as open, and close refuses until it is resolved` | Close releases the gates; whatever is unaccounted for then never will be |
| 66 | A subagent's return is recorded without the orchestrator | `subagent_return.js` → `recordReturn` | `subagent_return.test.js` :: `a subagent return is recorded against the oldest dispatch still out, with the agent named` | Only the mark tells a stall from an unrecorded result |
| 67 | Only a stalled dispatch is named at the next dispatch | `dispatch_guard.js` → `unresolvedContext` | `dispatch_guard.test.js` :: `the next dispatch says nothing about agents still working, even ones already seen` | Telling the orchestrator to record an outcome for working agents pushes it to invent one |
| 106 | A prompt with an unfilled template placeholder is refused | `dispatch_guard.js` → `unfilledPlaceholders` | `dispatch_guard.test.js` :: `a prompt with an unfilled template placeholder is refused and not counted` | A literal {RUN_DIR} reached a judge in a field run and nothing noticed |
| 107 | A sign of life is never read as a finish | `ledger.js` → `openDispatches` | `ledger.test.js` :: `a sign of life is not a finish: a marked dispatch still working is never reported as stalled` | SubagentStop fires for a background agent soon after launch, long before its result |
| 108 | A run at its token ceiling is refused its next dispatch, and only a sealed raise lifts it | `dispatch_guard.js` → `budgetRefusal` | `dispatch_guard.test.js` :: `a run at its token ceiling is refused its next dispatch, warned at 80 percent, and freed by a raise` | Cost counted only after the fact lets one run overshoot without bound |
| 109 | A fourth QA judge after three BLOCKs is refused | `dispatch_guard.js` → `MAX_QA_BLOCKS` | `dispatch_guard.test.js` :: `after three BLOCK verdicts a fourth judge is refused, while other work still dispatches` | A review loop nobody steers spends the budget proving the same disagreement |
| 110 | A phone approval backs one act, and only while it is fresh | `ledger.js` → `usableApproval` | `ledger.test.js` :: `a phone approval backs one act, and only while it is fresh` | An answer given for one thing must not be spent again later on another |
| 111 | The org policy caps the token ceiling | `policy.js` → `applyPolicy` | `policy.test.js` :: `the org policy caps the token ceiling and a profile may only set a lower one` | A ceiling each repo can lift is no ceiling |
| 70 | One judge, one verdict | `ledger.js` → `cmdVerdict` | `ledger.test.js` :: `a judge dispatch seals one verdict; a second seal on the same dispatch is refused` | The last of several seals would govern silently |
| 71 | An outcome settles a dispatch, not one of its two records | `ledger.js` → `cmdOutcome` | `ledger.test.js` :: `an outcome settles both records of one dispatch, and died counts dispatches, not records` | A pair recorded twice doubles the waste the report shows |
| 72 | A session dispatching into a run it did not start is told so | `dispatch_guard.js` → `dispatchContext` | `dispatch_guard.test.js` :: `a dispatch into a run this session did not start is told so, and a run of its own is not` | An abandoned run arms every gate in the repo with nothing saying why |
| 73 | A stop under someone else's open run names it and how to end it | `hook_lib.js` → `foreignRunNote` | `stop_gate.test.js` :: `a stop in a repo whose open run belongs to another session says whose it is and how to end it` | The gate still enforces; the operator learns whose run it is instead of routing around it |
| 74 | A denial names the open run that arms it when that run is another session's | `freeze_guard.js` → `armingRuns` | `freeze_guard.test.js` :: `a denial names the open run that arms it when another session started that run` | A refused edit with no stated cause is how an abandoned run goes unnoticed for a week |
| 75 | A targeted run names its test files in commands under the platform's line limit | `stop_gate.js` → `batchTargets` | `stop_gate.test.js` :: `a change mapping to many test files runs them in batches, every file once` | One command naming every mapped file stops working at exactly the size of change the gate exists to verify |
| 76 | A dispatch on a tier the profile did not name for its role is reported | `ledger.js` → `modelProblems` | `ledger.test.js` :: `a dispatch on a tier the profile did not name for its role is reported by verify` | The tiering was prose: the orchestrator was told to pass the model and nothing checked that it had |
| 77 | A focused QA read is handed the files that import what changed | `importers.js` → `importersOf` | `importers.test.js` :: `importers are found per stack: js and ts, dart package and relative, python, go` | "Read the consumers" was an instruction the judge had to carry out itself |
| 78 | The importers of a deleted file are found | `importers.js` → `importersOf` | `importers.test.js` :: `the importers of a deleted file are still found, since they are the ones that break` | Resolving against the filesystem would miss exactly the files a deletion breaks |
| 79 | init writes a profile the preflight accepts and never overwrites one | `init.js` → `buildProfile` | `setup_tools.test.js` :: `init never overwrites a profile and never runs while a run is open` | The profile is the control plane a run is sealed against |
| 80 | doctor finds stale hook copies, abandoned runs and leftover worktrees without changing anything | `doctor.js` → `diagnose` | `setup_tools.test.js` :: `doctor passes a freshly initialised repo, then finds stale copies, an abandoned run and a leftover worktree` | Each of these went unnoticed for weeks in a field repo |
| 81 | A session opening on an open run or a stale hook copy is told so | `session_start.js` → `notice` | `session_start.test.js` :: `an open run started by another session is named at session start with how to end it` | Otherwise the first sign is a refusal, in work that has nothing to do with the run |
| 82 | Every hook the plugin ships is on the stale-copy list | `hook_lib.js` → `HARNESS_HOOK_FILES` | `session_start.test.js` :: `the stale-copy list names every hook file the plugin ships` | A copy of a hook added later would otherwise go unseen |
| 83 | A closed run's bundle verifies with no secret and no harness | `verify_bundle.js` → `verifyBundle` | `attest.test.js` :: `a closed run exports a bundle that verifies with no secret, trusted by its key id` | The HMAC seals prove the record only to the machine holding the chain key |
| 84 | A changed, dropped or inserted record, or an edited attestation, fails verification | `verify_bundle.js` → `digestOf` | `attest.test.js` :: `each tampering an auditor must catch is caught` | A bundle is only evidence if every way of editing it shows |
| 85 | A bundle re-signed by another key is not trusted | `verify_bundle.js` → `verifyBundle` | `attest.test.js` :: `a bundle re-signed with another key verifies only as untrusted` | A valid signature from anyone is not evidence; one from a named key is |
| 86 | Nothing unfinished or unverifiable is signed | `ledger.js` → `cmdExport` | `attest.test.js` :: `export refuses an open run, a run without a key, and a chain that does not verify` | A signature over a broken or open record would launder it |
| 87 | A signing key is never replaced | `attest.js` → `keygen` | `attest.test.js` :: `keygen never replaces an existing key` | Replacing it silently orphans every bundle the old key signed |
| 88 | A pull request merges only with a trusted bundle attesting its exact head | `ci_check.js` → `check` | `ci_check.test.js` :: `a commit after the attested head that changes code is refused` | A bundle for some earlier commit says nothing about the code being merged |
| 89 | Trust and the test command come from the base branch | `ci_check.js` → `check` | `ci_check.test.js` :: `a key the base branch does not trust is refused, even when the pull request trusts it` | A pull request that can trust its own key or pick its own test command checks nothing |
| 90 | CI reruns the tests itself | `ci_check.js` → `runCommand` | `ci_check.test.js` :: `CI reruns the base branch test command, so a red suite or a swapped command does not pass` | The bundle is the developer machine's word; the rerun is CI's own |
| 91 | A failed or tampered run does not merge | `ci_check.js` → `PASSING_VERDICTS` | `ci_check.test.js` :: `a run whose verdict was BLOCK, or whose integrity was not intact, is refused` | A signature over a BLOCK is still a BLOCK |
| 92 | CI countersigns what it ran with its own key | `ci_check.js` → `countersign` | `ci_check.test.js` :: `with a CI key the check countersigns exactly what it ran` | The one claim in the trail the developer's machine could not have made |
| 93 | The trust list is frozen mid-run | `guard_policy.js` → `CONTROL_PLANE_PATTERNS` | `guard_policy.test.js` :: `the control plane is protected mid-run and writable when idle` | An agent that can trust its own key mid-run signs for itself |
| 94 | A closed run is handed off as a ready pull request and nothing is pushed | `handoff.js` → `handoff` | `handoff.test.js` :: `a closed run becomes a pull request description from its report and attestation, and nothing is pushed` | Publishing is the human's decision; the handoff removes the typing, not the decision |
| 95 | The handoff speaks the platform the remote is on | `handoff.js` → `commands` | `handoff.test.js` :: `the commands match the platform the remote is on` | A team on Bitbucket was handed GitHub's commands |
| 96 | An org policy is a floor no profile can lower | `policy.js` → `applyPolicy` | `policy.test.js` :: `the org floor is applied to the profile and a disallowed model stops preflight` | A policy each repo can opt out of is a suggestion |
| 97 | A risk path only the org names is fenced by the hooks | `hook_lib.js` → `loadConfig` | `policy.test.js` :: `a risk path only the org policy names is fenced by the hooks during a run` | Preflight applying the floor while the guard reads the bare profile would fence nothing |
| 98 | A dispatch on a model the org does not allow is reported | `ledger.js` → `modelProblems` | `policy.test.js` :: `a dispatch on a model the org policy does not allow is reported by verify` | The integrity check is what the merge check reads, so the violation reaches CI |
| 99 | The policy is sealed at init and an unreadable one starts no run | `ledger.js` → `cmdInit` | `policy.test.js` :: `the policy is sealed when a run starts, so relaxing it mid-run is TAMPERED` | A floor relaxed mid-run governed nothing |
| 100 | A message reaches every configured channel and one failure silences none | `notify.js` → `send` | `notify.test.js` :: `a message reaches every channel, each in its own shape, and one failure silences none` | Where one service is blocked, the person must still be reachable on another |
| 101 | An answer counts only with the question's code, from the configured chat, before the deadline | `notify.js` → `parseAnswer` | `notify.test.js` :: `an answer counts only with the code of its question and from the configured chat` | A stale or unrelated message is not consent |
| 102 | Silence is never a yes | `notify.js` → `ask` | `notify.test.js` :: `no answer before the deadline is no answer, never a yes` | A run that proceeds on a timeout acts on an answer nobody gave |
| 103 | Only an answer the agent could not have forged backs a clearance, and only for the glob it named | `ledger.js` → `cmdApproval` | `notify.test.js` :: `an answer is sealed into the run, and only an unforgeable one naming the glob backs a clearance` | An ntfy topic accepts posts from anyone who knows it, the agent included |
| 104 | A session that stalls mid-run tells the person on its own | `notify_hook.js` → `messageFor` | `notify.test.js` :: `a session that stalls on a permission prompt mid-run messages the person, once, and never outside a run` | The person away from the laptop otherwise assumes the work is finishing |
| 105 | A Slack or Discord answer counts only from a person, never a bot, and seals only from the configured user | `notify.js` → `pollSlack` | `notify.test.js` :: `without a configured Slack user a bot message is still never an answer` | Where Telegram is blocked, a bot channel must carry the same guarantee: the agent holds the bot token, and a bot cannot post as the person |

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
| 68 | An operator inside a quoted argument is text, not a statement boundary | `guard_policy.js` → `splitOutsideQuotes` | `guard_policy.test.js` :: `operators inside a quoted argument are text, not a pipeline or a redirection` | A grep alternation refused as a pipeline is a read the operator learns to route around |
| 69 | A sanctioned call is recognised however its script path is quoted | `guard_policy.js` → `HARNESS_SCRIPT` | `guard_policy.test.js` :: `a sanctioned call may name its script by a quoted absolute path` | The installed plugin lives under a quoted absolute path; the harness's own calls must pass its own guard |

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

- whether a human was really asked before a clearance was recorded, unless the clearance carries
  an `--approval` from an unforgeable notify channel (rows 103 and 105)
- GATE B (a design that contradicts the ticket)
- whether a revision reason is true
- whether a `died` dispatch outcome was reported at all
- whether the work is actually *good* — every row above proves the record is intact, none
  proves the output is right
