# Stage 3 — SURVEY

Size the footprint from `ticket-brief.md`:
- **Trivial** (1–2 files, obvious area) or FAST-TRACK: skip, sealed:
  `node <SKILL_DIR>/scripts/ledger.js skip <runDir> survey "<why: trivial, or the fast-track sentence>"`
- **Feature or subsystem**: `node <SKILL_DIR>/scripts/survey.js <runDir> --worktree <wt>
  --paths <area dirs>` writes the top of `<runDir>/codebase-map.md`: the outline of those
  paths, stamped with HEAD. Read it. When it already answers what a slice needs (layers,
  conventions, neighbours), skip the explorer and say so in `ledger.md`; otherwise dispatch ONE
  read-only `Explore` agent (Stage 7 dispatch rules apply) for what the map lacks, and append
  its return under `## Explorer findings`. Then
  `node <SKILL_DIR>/scripts/ledger.js gate <runDir> survey --evidence <runDir>/codebase-map.md`
- **Whole-system** (redesign, rewrite, migrate everything): STOP. Tell the human to decompose
  it into sub-tickets and run the loop once per sub-ticket.
The map is context, never a contract: a survey finding becomes a criterion only through
Stage 6 or `done-additions.md`. Reusable findings go to memory with
`memory.js add <memoryFile> convention <TICKET> "<finding>"`.
