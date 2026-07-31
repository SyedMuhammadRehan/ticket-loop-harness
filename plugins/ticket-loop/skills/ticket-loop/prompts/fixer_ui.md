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
0. Fix at the root, in the smallest place that fixes it for every caller — a shared
   function, not a patch repeated at each call site. Prefer changing existing code to
   adding new code; the shortest correct diff wins.
1. Find the ROOT CAUSE of the mismatch before changing anything, then fix at that
   level. Never change the expected value, never edit the test's assertion to match
   ACTUAL, never touch done.md/*.approved.md. Your return MUST include a line
   `root-cause: <what it actually was>` — if your change is knowingly a symptom fix,
   say so: `root-cause: NOT addressed — real fix is <X>` (an honest patch is
   acceptable; a disguised one is not).
2. If EXPECTED appears wrong (e.g. design-spec extraction error), do NOT fix it
   yourself — return `STATUS: dispute` with your evidence; the orchestrator re-extracts
   from Figma and re-freezes via done-additions.md if needed.
3. Same hard-stop paths and return format as the implementer prompt:
   `STATUS: green|red|dispute|GATE_C` + files + test output tail + summary.
