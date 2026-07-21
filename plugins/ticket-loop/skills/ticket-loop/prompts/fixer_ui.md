# UI fixer subagent — {TICKET} — check: {CHECK_ID}

A design-token check failed inside the worktree at {WORKTREE_PATH}. Fix ONLY this.

## Expected (from design-spec.md — the contract)
{EXPECTED}

## Actual (from the failing test/runtime evidence)
{ACTUAL}

## Files in play
{FILES}

## Forbidden approaches
{LEDGER_FORBIDDEN}

## Rules
1. Change the implementation to satisfy EXPECTED. Never change the expected value,
   never edit the test's assertion to match ACTUAL, never touch done.md/*.approved.md.
2. If EXPECTED appears wrong (e.g. design-spec extraction error), do NOT fix it
   yourself — return `STATUS: dispute` with your evidence; the orchestrator re-extracts
   from Figma and re-freezes via done-additions.md if needed.
3. Same hard-stop paths and return format as the implementer prompt:
   `STATUS: green|red|dispute|GATE_C` + files + test output tail + summary.
