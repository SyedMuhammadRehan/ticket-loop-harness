# Stage 6 — DEFINE DONE

1. From the ACs, `design-spec.md` and `approach.md` (its failure modes MUST surface here as
   criteria or out-of-scope entries), write `<runDir>/done.draft.md`:

   ```markdown
   # Done — <TICKET>
   ## Criteria
   - [ ] C1 (test): when <trigger>, the system shall <observable response> | run: {verify.test} <test file to be written>
   - [ ] C2 (analyzer): zero analyzer errors | run: {verify.analyze}
   - [ ] C3 (token): <element> uses <value> | run: {verify.test} <token test file>
   - [ ] C4 (runtime): no overflow/console errors on <route> at 1440px and 768px | run: playwright:<check-id>
   - [ ] C5 (manual): <at most one eyeball check>
   ## Tokens
   - <name>: <value> (source: design-spec.md#<section>)
   - none (<why>)          ← when designSource is none / LOGIC-ONLY
   ## Out of scope
   - <explicit exclusions>
   ```

   Kinds: test | analyzer | runtime | token | manual. Drop token and runtime criteria when
   `designSource == none`, and the analyzer criterion when `verify.analyze` is null. Write
   each behaviour as trigger and response so it names the input that makes it fail. State
   every criterion absolutely ("the suite exits 0, including the N tests already in
   <file>"), never relative to a baseline: the validator refuses "no new", "baseline",
   "branch point", "pre-existing" and "subset of" unless the `run:` command performs the
   comparison.
   The validator enforces: at least one `(test)` or `(runtime)` criterion; unique well-formed
   `C<n>` ids; no pre-ticked box; every `run:` starting with the profile's `verify.test` or
   `verify.analyze` binary.
2. `node <SKILL_DIR>/scripts/validate_done.js <runDir>`. On exit 1 fix the draft and re-run.
3. `node <SKILL_DIR>/scripts/freeze_done.js <runDir>`. It refuses a draft never validated or
   edited since. It records the `freeze` gate; then
   `node <SKILL_DIR>/scripts/ledger.js gate <runDir> validate`.
   From here `done.md` and `done.approved.md` are read-only; new criteria go to
   `<runDir>/done-additions.md` (created header-only by the freeze) through
   `node <SKILL_DIR>/scripts/ledger.js addition <runDir> "- [ ] C<n> (kind): ... | run: ..."`.
4. **`--dry-run` ends here:** print the paths of the brief, design-spec, approach (if any) and
   frozen done-list with a three-line summary of each, and stop. Say that the run stays active
   (the guard keeps protecting the run dir) until a later `/ticket-loop <TICKET>` RESUMEs it
   or `ledger.js archive <runDir>` retires it.
