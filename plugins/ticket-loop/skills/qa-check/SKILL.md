---
name: qa-check
description: Adversarial review of the working tree's changes against a description you give, using the ticket-loop QA judge. One pass, no receipts, no loop. Use when the user types /qa-check <what the change was meant to do>, or asks for an independent review of uncommitted or branch work without running a full ticket loop.
---

# QA Check

An adversarial second opinion on what has changed, judged against a description you supply.
One pass. It writes nothing, changes nothing, and records nothing.

**Be honest about what this is.** The ticket loop's Stage 5.5 judge is stronger than this, and
the difference is not small. There, the judge reads a done-list that was written before the
code, validated, frozen and sealed, and it sees the sealed record of how each criterion was
established. Its verdict is a receipt the run cannot close without, and a BLOCK routes back
into implementation and re-verification until the work converges.

Here the judge reads a description written after the fact, by the person whose work is under
review, with no way to tell what was actually run. It is a good second opinion. It is not a
certification, and you must not let a reader take it for one.

## Rules

1. **No receipts, ever.** Do not run `ledger.js` in any form other than `qascope` below. A
   standalone review must never reach a run's chain: a review with no contract behind it,
   sealed into a run, would launder an unconstrained opinion into that run's evidence. If a
   ticket-loop run is active in this repo, say so and stop — use the loop's own QA stage.
2. **Read-only.** Nothing in the tree changes. Findings describe what to fix; they do not fix it.
3. **One pass.** No iteration, no re-review after fixes. Convergence is what the loop is for;
   if the user wants that, say so.

## Steps

1. **Take the description.** It is the argument to the command. If none was given, ask for one
   sentence on what the change was meant to do, and stop until you have it. Reviewing against
   "whatever seems right" is how a review becomes a rubber stamp.

2. **Resolve the profile** for stack and risk paths:
   `node <SKILL_DIR>/../ticket-loop/scripts/load_config.js`
   No profile is fine — the review just carries no stack conventions and no risk fence, and the
   output must say that.

3. **Find the change.** Prefer the branch point when there is one, so committed work is
   included: `git merge-base HEAD <default-branch>`. Otherwise review only what is uncommitted.
   Say which you did.

4. **Size the read:**
   `node <SKILL_DIR>/../ticket-loop/scripts/ledger.js qascope --base <merge-base-or-ref>`
   Use its `scope` for `{QA_SCOPE}`. It counts insertions, not deletions, and forces FULL when
   a risk path is touched.

5. **Dispatch ONE judge** with `subagent_type: ticket-loop-qa`, filling
   `<SKILL_DIR>/prompts/qa_check.md`. That agent has no Write or Edit, which is what makes an
   independent verdict mean anything.

6. **Report its findings verbatim**, under the banner it returns. Do not soften them, do not
   fix anything, and do not add a verdict of your own. If the user wants the findings acted on,
   that is a separate request.
