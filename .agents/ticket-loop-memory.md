# Ticket-loop memory

Lessons the loop carries between runs. The loop READS everything here at the start of a run
and APPENDS to "Pending" at the end. Periodically promote good Pending items into "Lessons"
and delete stale ones — curation keeps this trustworthy.

## Lessons (curated — human-maintained, high trust)
<!-- flaky: <test> — <why> -->
<!-- fix: <error signature> → <approach that worked> -->
<!-- convention: <thing the loop should always do in this repo> -->

## Pending (auto-captured — review, then promote or delete)
- [gotcha] (guard-props · 2026-08-12) Verifying a file is unmodified: the write-guard denies 'git -C <worktree> diff -- <protected-path>' because -C <path> displaces the subcommand token so the read-only detector misclassifies it. Use 'git -C <wt> diff --stat <base>' (empty = no tracked change) plus 'git status --porcelain', which name no protected path.
