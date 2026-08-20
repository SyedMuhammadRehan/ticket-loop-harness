# Ticket-loop memory

Lessons the loop carries between runs. The loop READS everything here at the start of a run
and APPENDS to "Pending" at the end. Periodically promote good Pending items into "Lessons"
and delete stale ones — curation keeps this trustworthy.

## Lessons (curated — human-maintained, high trust)
<!-- flaky: <test> — <why> -->
<!-- fix: <error signature> → <approach that worked> -->
<!-- convention: <thing the loop should always do in this repo> -->
- [convention] (verify-can-fail · 2026-08-19) done-additions.md is sealed by EVERY QA verdict receipt, not just by the freeze. Adding a criterion after a judge has run is legitimate, but the edit must then be recorded with the harness revise command over that file. Otherwise the Stage 7 integrity check reports TAMPERED and the run cannot claim an intact chain.
- [gotcha] (verify-can-fail · 2026-08-18) Invoking a harness script with a QUOTED path (node "C:/.../ledger.js" init ...) is denied by freeze_guard: guard_policy masks quoted text before testing SANCTIONED_COMMAND, so ledger.js is invisible to it. Use an unquoted path; also avoid a leading 'cd X &&', which splits into a non-sanctioned statement.

## Pending (auto-captured — review, then promote or delete)
- [gotcha] (verify-can-fail · 2026-08-19) Deciding by source inspection whether a shell command can exit non-zero is not soundly achievable. Six adversarial rounds each found one more spelling past whichever blocklist was in place, and inverting to whitelists narrowed but did not close the surface. If a future ticket asks for this class of check, settle first with the human whether preflight may EXECUTE the command; without execution the honest deliverable is a small set of syntactically decidable shapes.
- [convention] (verify-can-fail · 2026-08-18) An INVARIANTS.md row cannot cite a test whose name contains a pipe: the table escapes it as \| and invariants.test.js then looks for the escaped literal in the test file and fails. Cite a pipe-free test name.
- [gotcha] (verify-can-fail · 2026-08-18) grep with a backslash-pipe alternation ('a\|b') against a protected path is denied: the guard splits statements on the pipe regardless of quoting, and the fragment after it is not a read-only verb. Use repeated -e patterns instead.
- [gotcha] (guard-props · 2026-08-12) Verifying a file is unmodified: the write-guard denies 'git -C <worktree> diff -- <protected-path>' because -C <path> displaces the subcommand token so the read-only detector misclassifies it. Use 'git -C <wt> diff --stat <base>' (empty = no tracked change) plus 'git status --porcelain', which name no protected path.
