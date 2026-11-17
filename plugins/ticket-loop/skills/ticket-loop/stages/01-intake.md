# Stage 1 — INTAKE

1. Fetch the ticket per `ticketSource`: `jira` → Atlassian MCP `getJiraIssue`; `github` → `gh issue view <ID>
   --comments`; `gitlab` → `glab issue view <ID> --comments`; `trello` → Trello MCP;
   `manual` → the user's text is the ticket and `<TICKET>` is a short slug you choose.
   Extract summary, description, acceptance criteria verbatim, design links (only when
   `designSource != none`) from description and comments, and attachment names.
2. Write `<runDir>/ticket-brief.md`: numbered verbatim ACs, design links, screens and routes,
   and a RISK SCAN naming every `riskPaths` area the ticket implies, plus the always-on risk
   of deleting or weakening an existing test.
3. **STOP, do not scope, when the ticket is several tickets:** it bundles pieces of work that
   would each ship on their own (a rewrite, a migration, a new framework, a service split, a
   new UI in one ticket). Write the pieces into the brief as proposed sub-tickets, each with a
   one-line goal, show the human that list, and end here: no intake gate, no code. Do not offer
   to build one piece under this ticket's id; a piece is a run of its own under its own id,
   started by the human, so this ticket is never reported COMPLETE for a part of itself.
4. **GATE A (ask the human) if any of:** no acceptance criteria and no design link; only
   subjective goals with no measurable anchor; the RISK SCAN found a risk-tier area (name it,
   ask for clearance). Ask everything foreseeable in ONE batch, before work starts. When the
   criteria are missing, ask what was observed or complained about and what would show it is
   fixed; do not offer improvements you thought of as choices, because picking one turns your
   guess into the contract. With no answer that can be measured, park the run: no intake gate,
   no code. Otherwise proceed. Low-risk ambiguities get a default, appended to
   `<runDir>/assumptions.md` as `- Q: <question> → default: <choice> (risk: low)`.
   When a human clears a risk area, and only then:
   `node <SKILL_DIR>/scripts/ledger.js clear <runDir> "<the glob>" "<what they approved and why>"`
5. Decide FAST-TRACK (Stage 2) before recording the gate, then:
   `node <SKILL_DIR>/scripts/ledger.js gate <runDir> intake --evidence <runDir>/ticket-brief.md`
