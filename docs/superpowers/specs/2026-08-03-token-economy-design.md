# Token economy for ticket-loop — design

Opt-in cost controls for a run's subagent dispatches. Nothing changes for a repo that does
not configure them: every dispatch inherits the session model, and QA reads at full breadth.

## Why

A healthy run spends most of its tokens on dispatches (survey, implementers, QA judge — the
cart-first-paint field run: ~270k across four dispatches) and all of them run on the session
model because nothing says otherwise. Two of those roles have a real backstop when they err
(survey mistakes are caught by the contract's checks; implementer mistakes by verification
and QA), so a cheaper model there trades nothing that is not already re-verified. The QA
judge has no backstop — it IS the backstop — so its model is never downgraded by default;
its cost scales by reading scope instead, and only when the change is provably small and
touches nothing risk-fenced.

## 1. `models` config block

```json
"models": { "survey": "haiku", "implementer": "sonnet", "fixer": "sonnet", "qa": "inherit" }
```

- All keys optional; every default is `"inherit"` (= session model). Full power is the
  out-of-the-box behavior; savings are a per-repo decision.
- `load_config.js` owns validation, in its existing style (warn loudly, force safe):
  unknown keys under `models` are dropped with a warning; a non-string or empty value is
  forced to `"inherit"` with a warning.
- SKILL.md instructs the orchestrator: at each dispatch, pass the role's configured value
  as the Agent tool's `model` parameter — omit the parameter when the value is `inherit`.

## 2. Diff-scaled QA scope

```json
"qaScope": { "smallDiffLines": 60 }
```

- Before dispatching QA, the orchestrator measures the committed diff against the branch
  point. If total changed lines ≤ `smallDiffLines` AND no changed file matches `riskPaths`,
  the judge's prompt gets a FOCUSED scope: the changed files, their direct consumers, and
  the frozen contract — no whole-codebase sweep. Otherwise scope is FULL, unchanged.
- `smallDiffLines` must be an integer ≥ 0 (0 = never focused); invalid values are forced to
  the default 60 with a warning.
- Same model, same verdict authority, same sealed verdict either way. The scope used is
  stated in the QA prompt and recorded with the dispatch, so a focused review can never
  pass itself off as a full one.

## 3. Reporting and honesty

- Each dispatch's ledger label and the report's Cost section record the model used and, for
  QA, the scope (full|focused). Evidence of what was cheapened, sealed like everything else.
- Model tiering and QA scoping are playbook-followed, not hook-enforced — no hook verifies
  which model a subagent ran on. README's "Yours to uphold" section says so explicitly.

## Out of scope

Orchestrator model, verify commands, receipt chain, guard hooks, freeze mechanism, and any
automatic "this ticket is too small for ticket-loop" triage (the human decides that).

## Tests

- `load_config.test.js`: defaults are all-inherit + 60; valid overrides merge; unknown
  models key warns and is dropped; invalid model value warns and forces inherit; invalid
  smallDiffLines warns and forces 60.
- Prompt/playbook changes are prose for the orchestrator and are not hook-enforced;
  the README line is the honest statement of that boundary.
