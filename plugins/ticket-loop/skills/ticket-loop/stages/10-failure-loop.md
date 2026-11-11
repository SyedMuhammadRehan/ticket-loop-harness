# Stage 10 — FAILURE LOOP

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
