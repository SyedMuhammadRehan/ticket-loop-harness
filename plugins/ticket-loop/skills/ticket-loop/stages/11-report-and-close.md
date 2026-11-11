# Stage 11 — REPORT AND CLOSE

1. Fill `<SKILL_DIR>/report-template.md` → `<runDir>/report.md`: every criterion as PASS,
   FAIL or SKIPPED(reason); assumptions verbatim; FLAKY and GOLDEN flags; toolchain line;
   wall-clock; counters from `ledger.js status`; for each visual criterion the Figma PNG and
   runtime capture paths. Paste verbatim, never summarise:
   `node <SKILL_DIR>/scripts/ledger.js cost <runDir> --worktree <wt>` into Cost and `node <SKILL_DIR>/scripts/ledger.js verify <runDir>` into
   Integrity. Exit 4 → `Integrity: TAMPERED`, problems verbatim, escalate. `Status:` is the
   work and `Integrity:` the history; report them separately. `revisions` in the output are
   recorded edits, listed with their reasons.
2. With `--update-jira`, post the Summary as a comment via the configured source (Atlassian MCP,
   `gh issue comment`, `glab issue note`, Trello MCP); skip for `manual`. Transition ticket
   status only through step 3's `--act ticket`. If `memoryFile` is set, add reusable lessons with
   `memory.js add` and list them in the report.
3. `node <SKILL_DIR>/scripts/ledger.js gate <runDir> report --evidence <runDir>/report.md`
   then `ledger.js close <runDir>`, LAST (abandoned: `ledger.js archive`). With a key, `ledger.js export
   <runDir> --out <wt>/.agents/attestations/<TICKET>.bundle.json`; commit it alone: `chore(<TICKET>): attest`. Then,
   for each act consented to, in order push, pr, ticket: `node <SKILL_DIR>/scripts/publish.js <runDir> --worktree <wt> --act <act>`.
4. Final message, also sent with `notify.js send "<status, branch, what waits on you>"`: status (COMPLETE, or INCOMPLETE and why), report path, branch name, the
   integrity line from `ledger.js verify`, what `publish.js` did or refused (else `handoff.js` prints the PR
   commands), that merge and golden regeneration are manual, and plainly what was NOT verified: excluded goldens, every SKIPPED criterion, every
   stop_gate "NOT verified" note, and on a LOGIC-ONLY run every visual and contract check.
