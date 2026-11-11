# Stage 5 — APPROACH

Skip when the survey was skipped, sealed:
`node <SKILL_DIR>/scripts/ledger.js skip <runDir> approach "<why: trivial change, survey skipped>"`. When
`codebase-map.md` exists, `validate_done.js` refuses the freeze until `approach.md` exists.
YOU write `<runDir>/approach.md`; it costs no dispatch. Exactly these sections:

```markdown
# Approach — <TICKET>
## Data
- <entity touched>: owner/source of truth is <where>; this change <reads|writes|reshapes> it
## Boundary
- the change lives behind <layer/module/interface>; callers see <what stays stable>
## Options
- A: <approach> — <one-line tradeoff>
- B: <approach> — <one-line tradeoff>
## Chosen
- <A|B>: <why it wins and why the loser loses> | reuses: <existing module/helper this builds on>
## Failure modes
- <what can go wrong at runtime> | covered-by: C<n>
- <a failure mode consciously not handled> | covered-by: out-of-scope (<reason>)
## Slice order
- 1st: <the slice most able to prove this approach wrong> — <why>
- then: <remaining slices, cheapest information last>
```

Validated at Stage 6: at least two real options, one the cheapest that could work (reuse,
extend, do nothing); a Chosen with `reuses:` (`reuses: none (<what you searched and why
nothing applies>)` is accepted, a thin reason is not); every failure mode tagged
`covered-by:` with a criterion or a substantive out-of-scope reason, not all waived; no
duplicated headings. Echo out-of-scope failure modes in the done-list's `## Out of scope`.
A later design change goes under `## Revisions` as `- R<n>: <what changed> — because <what
reality proved wrong>`, then `ledger.js revise`; the QA judge BLOCKs an unrecorded one.

`node <SKILL_DIR>/scripts/ledger.js gate <runDir> approach --evidence <runDir>/approach.md`
