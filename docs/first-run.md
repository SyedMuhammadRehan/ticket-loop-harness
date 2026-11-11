# Your first run, on a repo that does not matter

Twenty minutes, no ticket system, nothing of yours at risk. You need Claude Code with the
plugin installed, Node 18 or later, and git.

## 1. Make the sample repo

From a checkout of this repository:

```
node examples/new-sample.js ~/todo-sample
```

```
new-sample: a sample repo is ready at /home/you/todo-sample
  next: open a Claude Code session in that folder and type /ticket-loop:setup
  then: /ticket-loop "<paste TICKET.md>" --dry-run
```

It is a four-test Node module with no dependencies and one ticket, `TICKET.md`: add
`isOverdue` and `listOverdue` to a todo module, with four acceptance criteria.

## 2. Set it up

Open a **new** Claude Code session in `~/todo-sample` and type:

```
/ticket-loop:setup
```

It shows the profile it would write, detected from `package.json`, and asks before writing:

```
"verify": { "analyze": null, "test": "npm test", "pubGet": null, "codegen": null },
"riskPaths": [ "package.json" ],
...
review before the first run:
  - verify.analyze could not be found; optional, but set the repo's linter or type checker if it has one
  - no origin remote, so tickets are pasted in (manual)
```

Then it runs the health check with the gates tried for real:

```
ticket-loop doctor: /home/you/todo-sample
  note: tried in a throwaway repo, and every gate held: an edit to a frozen contract, an edit under a risk path and a git push were each refused, and an ordinary edit was let through; a dispatch was counted in the sealed record; a "done" claim over a failing suite was blocked
  note: the profile: node; tests run with "npm test", no analysis command; every role on the session model; a run publishes nothing
  note: no notify channel is set, so a run that gets stuck while you are away cannot tell you
  note: the profile is not committed on main, so teammates and the CI merge check do not have it
  ok: 0 problems, 4 notes
```

The first note is the one that matters: each gate was handed a real violation in a throwaway
repo and refused it. Next the session itself makes one tool call the write guard must refuse.
You should see it blocked with a message starting `BLOCKED:`. If it is not blocked, the hooks
are not running in this session; [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) has the causes.

Last, it asks you two things detection cannot decide: which model each kind of work runs on,
and what a finished run may publish. The defaults are every role on your session's model and
nothing published, which is the right place to start. Whatever you allow, every run still asks
before it pushes or opens a pull request, and it never merges.

Commit the profile when it asks you to: `git add -A && git commit -m "chore: ticket-loop profile"`.

## 3. Plan the ticket without touching code

```
/ticket-loop "Flag overdue todos — see TICKET.md" --dry-run
```

The loop reads the ticket, decides whether it is small enough to fast-track, and writes a
definition of done: one criterion per acceptance criterion, each with the command that proves
it. It validates that list and **freezes** it. Nothing in `src/` changes.

Look at what it produced:

```
.agents/ticket-runs/<TICKET>/ticket-brief.md     the ticket as the loop understood it
.agents/ticket-runs/<TICKET>/done.md             the frozen definition of done
```

This is the moment to disagree. If a criterion is wrong, end the run
(`ledger.js archive <runDir>`) and start again with a clearer ticket. Once frozen, the contract
cannot be edited, only added to.

At any point, this tells you and the model where the run stands and what comes next:

```
node <SKILL_DIR>/scripts/ledger.js next <runDir>
```

## 4. Do the run

```
/ticket-loop <TICKET>
```

It continues from the frozen contract: creates a worktree beside the repo, writes each test
first and seals that it fails, implements, has the ledger run every criterion's command,
dispatches the QA judge, and writes `report.md`. On a ticket this size expect a few minutes
and one or two subagents.

What to check when it finishes:

- **The report** at `.agents/ticket-runs/<TICKET>/report.md`. `Status:` is the work;
  `Integrity:` is whether the record was altered. They are separate on purpose.
- **The branch** `ticket/<TICKET>` in the worktree. Nothing was pushed or merged.
- **`ledger.js verify <runDir>`** yourself. `passed: true` means a passing verdict and every
  criterion passed by its own command.

## 5. Try to break it

The quickest way to trust a guard is to push on it. With a run open, ask the model to:

- edit `done.md` to drop a criterion;
- run `git push`;
- say it is done while a test is failing.

Each is refused, and the refusal names the rule. That is the difference between this and a
prompt that asks nicely.

## Clean up

```
node <SKILL_DIR>/scripts/ledger.js archive <runDir>     # only if a run is still open
git worktree remove ../todo-sample-ticket-<TICKET>
```

Then delete the folder.
