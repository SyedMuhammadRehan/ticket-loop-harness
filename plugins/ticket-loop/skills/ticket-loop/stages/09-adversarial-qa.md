# Stage 9 — ADVERSARIAL QA

1. `node <SKILL_DIR>/scripts/ledger.js qascope <runDir> --worktree <wt>` prints `scope`
   (FOCUSED, FULL, or DELTA after a verdict when the fix stayed inside the files that judge
   read), `why`, `outsideScope`, `consumerFiles` and `label`. Use the label verbatim in `ledger.js dispatch`.
2. Dispatch ONE judge with **`subagent_type: ticket-loop-qa`** (no Write or Edit; a verdict
   binds to no other type) using `prompts/qa_agent.md`. Fill `{TICKET}`,
   `{RUN_DIR}`, `{SCRIPTS_DIR}` (`<SKILL_DIR>/scripts`), `{WORKTREE_PATH}` (`<wt>`), all absolute,
   `{BASE_SHA}` (`baseSha` in `ledger.js status`), `{DIFF}` (`git -C <wt> diff <base>..HEAD`,
   `git -C <wt> status --porcelain`, `git -C <wt> diff HEAD`;
   say when status is non-empty; past `dispatchPolicy.promptBudgetChars`, give the `--stat`
   plus those commands for the judge to run itself), `{CHECK_RESULTS}` (from `ledger.js status`),
   `{CONVENTIONS}` (codebase-map.md plus `stack`, or "the conventions evident in the
   surrounding code"), `{QA_SCOPE}` (FOCUSED: "read the changed files, these importers of them:
   <consumerFiles>, and the contract artifacts; skip the wider sweep" / FULL: "sweep as widely
   as the contract and diff warrant" / DELTA: "a judge ruled at verdict seq <n>; the prior
   findings and the change since <since> are below; confirm each finding is resolved and
   nothing regressed", with `{DIFF}` then being those findings verbatim plus
   `git -C <wt> diff <since>`). When `outsideScope` is non-empty, append "Changed outside every
   declared slice scope: <files>" to `{QA_SCOPE}`. Do NOT paste the contract files.
3. The judge seals its own verdict. `ledger.js status` must show it; without a sealed verdict
   the QA pass did not happen. Then `node <SKILL_DIR>/scripts/ledger.js gate <runDir> qa`, and
   `node <SKILL_DIR>/scripts/ledger.js require <runDir> qa` must pass.
4. BLOCK → Stage 10 as QA_BLOCK with the findings verbatim. APPROVE WITH COMMENTS → findings
   into the report, Stage 11. APPROVE → Stage 11.
