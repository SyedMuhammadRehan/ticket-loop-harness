# Stage 1 — INTAKE

1. Fetch the ticket per `ticketSource`: `jira` → Atlassian MCP `getJiraIssue`; `github` → `gh issue view <ID>
   --comments`; `gitlab` → `glab issue view <ID> --comments`; `trello` → Trello MCP;
   `manual` → the user's text is the ticket and `<TICKET>` is a short slug you choose.
   Extract summary, description, acceptance criteria verbatim, design links (only when
   `designSource != none`) from description and comments, and attachment names.
2. Write `<runDir>/ticket-brief.md`: numbered verbatim ACs, design links, screens and routes,
   and a RISK SCAN naming every `riskPaths` area the ticket implies, plus the always-on risk
   of deleting or weakening an existing test.
3. **GATE A (ask the human) if any of:** no acceptance criteria and no design link; only
   subjective goals with no measurable anchor; the RISK SCAN found a risk-tier area (name it,
   ask for clearance). Ask everything foreseeable in ONE batch, before work starts. Otherwise proceed. Low-risk ambiguities get a default, appended to
   `<runDir>/assumptions.md` as `- Q: <question> → default: <choice> (risk: low)`.
   When a human clears a risk area, and only then:
   `node <SKILL_DIR>/scripts/ledger.js clear <runDir> "<the glob>" "<what they approved and why>"`
4. Decide FAST-TRACK (Stage 2) before recording the gate, then:
   `node <SKILL_DIR>/scripts/ledger.js gate <runDir> intake --evidence <runDir>/ticket-brief.md`
