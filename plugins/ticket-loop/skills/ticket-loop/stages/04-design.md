# Stage 4 — DESIGN

Skip when LOGIC-ONLY (mark SKIPPED in the report), sealed:
`node <SKILL_DIR>/scripts/ledger.js skip <runDir> design "<why: no design source, or the tool is unavailable>"`
Otherwise, for each Figma link in the brief:
`get_metadata`, then `get_screenshot` → `<runDir>/screenshots/figma_<node>.png`, then
`get_design_context` (plus `get_variable_defs` when tokens are referenced). Write
`<runDir>/design-spec.md` with `#colors`, `#typography`, `#spacing`, `#assets`: exact values
only, each with its Figma node source, nothing guessed.
**GATE B (ask the human) if** the design contradicts the ticket text (different component,
conflicting behaviour, mismatched counts or labels); name the contradiction.
`node <SKILL_DIR>/scripts/ledger.js gate <runDir> design --evidence <runDir>/design-spec.md`
