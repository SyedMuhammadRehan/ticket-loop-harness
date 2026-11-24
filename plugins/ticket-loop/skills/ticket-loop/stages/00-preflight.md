# Stage 0 — PREFLIGHT

**A run that already exists** (a new session resuming one, or `next` sent you here because the
worktree is missing, as after a `--dry-run`): do steps 1–3 to load the profile, step 4 to create
the worktree if it is missing, and skip step 5. `next` then says which stage to continue at.

**A follow-up** (`--follow-up "<request>"`, or the person asks for more changes on a ticket whose
run is CLOSED: offer this, never a restart). It is a run of its own: `<TICKET>` becomes
`<TICKET>-f<N>` (the next free N), its worktree comes from the tip of `ticket/<first ticket>`, and
step 5 adds `--stack-on ticket/<first ticket> --follow-up-of <first ticket>`. The request is the
ticket. At intake, always ask the person ONE question showing the new criteria you propose and the
first run's checks carried forward, and wait for yes or a correction. Then `skip survey`,
`skip design` and `skip approach`, each "follow-up of <first ticket>". Stage 6's done-list carries
every command check of the first run with its `run:` unchanged, plus the new criteria; the
validator refuses one that drops any. The judge reviews the follow-up's diff from its base.

1. `node <SKILL_DIR>/scripts/load_config.js`. Record `stack`, the resolved verify commands,
   and the first line of the stack's `--version` output for the report. STOP and ask when:
   - `configFound` is false: show `node <SKILL_DIR>/scripts/init.js --dry-run`, and write it with
     `init.js` once the user agrees. `verify.test` null: ask for the command.
   - `_meta.warnings` names `hooks.stopGate` or starts `POLICY`: show it, ask the user to fix the
     profile (or the org policy's owner), and start again. Mid-run neither can be fixed.
   - `_meta.newerVersionInstalled` is set: say which version you are (`_meta.skillVersion`),
     which is installed, and that a NEW SESSION is the only fix. Do not proceed.
2. If `memoryFile` is set: `node <SKILL_DIR>/scripts/memory.js read <memoryFile>`. Lessons
   are high-trust, Pending is hints; carry flaky tests into the flake policy and relevant
   lessons into prompts. A lesson never authorises skipping a test, a gate or a clearance.
3. Probe dependencies; degrade explicitly, never silently. Ticket source per `ticketSource`
   (`jira` → Atlassian MCP; `github` → `gh`; `gitlab` → `glab`; `trello` → Trello
   MCP; `manual` → nothing); unreachable → fall back to `manual` and ask the user to paste the
   ticket. Design source when `designSource != none` (`figma` → a Figma tool is callable;
   `openapi` → the contract is reachable); unavailable → the run is LOGIC-ONLY and every visual
   or contract check is SKIPPED with that reason. Playwright MCP unavailable → runtime
   criteria are SKIPPED with that reason.
4. Worktree (skip under `--dry-run`). If `git worktree list` shows `<wt>` or
   `git branch --list ticket/<TICKET>` is non-empty, ASK once: RESUME (keep everything, skip
   `init`; `ledger.js next` says where the run stands) or CLEAN RESTART (`git worktree remove <wt>`,
   `node <SKILL_DIR>/scripts/ledger.js archive <runDir>`, `git branch -D ticket/<TICKET>`,
   then `init --restart` in step 5). Never auto-delete; if `worktree remove` refuses, show
   the dirty files and let the human decide. Then `git worktree add <wt> -b ticket/<TICKET> <baseRef>`
   from the profile's `hooks.stopGate.baseRef`, never the branch you are on; its tip is the base SHA.
   When the person started the run with `--on <branch>` (this ticket builds on another that has
   not merged), the worktree comes from `<branch>` instead and step 5 passes `--stack-on <branch>`.
   Only the person names that branch; never pick one because the code you need is on it — ask;
   `node <SKILL_DIR>/scripts/worktree_deps.js <wt>` prints `linked`, `present` or `install`,
   and only `install` means run `{verify.pubGet}`; then `{verify.codegen}` (skip null values).
   Any failure here → STOP. Never fall back to the user's tree.
5. If the write guard refuses `init` because the session already carries too much context, STOP:
   tell the person to start a new session (or `/clear`) and run the ticket again there. Add
   `--keep-context "<their reason>"` only when the person says to keep this session.
   `node <SKILL_DIR>/scripts/ledger.js init <runDir> <base-sha>` (add `--restart` after an
   archive; under `--dry-run` the base is `git rev-parse HEAD`; it refuses a base off the base branch
   unless the person gives `--off-base "<why>"`; with `--on <branch>` add `--stack-on <branch>`, and
   it refuses a base that is not that branch's tip). If `publish.allowed` is not empty, ask the person
   each allowed act SEPARATELY (push the branch? open the PR/MR? update the ticket?) and record the answers:
   `ledger.js consent <runDir> --push yes|no --pr yes|no --ticket yes|no "<who answered>"`. It seals the profile hash,
   writes `budget.json` and the `ledger.md` skeleton; if it warns there is no config to seal, STOP.
