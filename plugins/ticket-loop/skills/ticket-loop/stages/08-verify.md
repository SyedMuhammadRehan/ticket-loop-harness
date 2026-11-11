# Stage 8 — VERIFY

Record every result as you go, naming how it was established:
`node <SKILL_DIR>/scripts/ledger.js check <runDir> <C-id> PASS|FAIL|SKIPPED --by <method> "<note>"`
Methods: `command` (add `--cwd <wt>`: the ledger runs the frozen `run:` command at the worktree
root and prints the exit code that decides; a criterion with a shell `run:` passes no other
way), `observed` (the running system was exercised and seen; `playwright:`/`browser:` criteria),
`human` (a person confirmed; the only way a `(manual)` criterion passes), `asserted` (concluded
from source or a summary; can back only SKIPPED). Mirror each result into `ledger.md`'s
check-history table.

1. `{verify.analyze}` → zero errors (skip when null).
2. `{verify.test}` → full suite green. Goldens or snapshots excluded from it are SKIPPED
   (local-only convention) and go under "not verified", never inside COMPLETE.
3. Token criteria (when `designSource != none`): run their named test files.
4. Runtime criteria (SKIPPED when LOGIC-ONLY or Playwright is down): launch the app per the
   repo's run conventions; per criterion navigate to the route, require a clean
   `browser_console_messages` (no errors, no "RenderFlex overflowed"), assert key elements via
   `browser_snapshot`, and `browser_take_screenshot` at 1440px and 768px →
   `screenshots/runtime_<check>_<width>.png`. A launch that fails three times marks every
   runtime criterion SKIPPED (app launch failure); the run continues.
5. All green → `git -C <wt> commit` as `verify green` →
   `node <SKILL_DIR>/scripts/ledger.js gate <runDir> verify` → Stage 9.
   Any FAIL → Stage 10.
