# The Depot bench

A project built to find out whether the ticket loop is any good, with the answers known in
advance. You run tickets through the loop; a scorer checks the result against tests the agent
never saw.

## What is in it

| Part | What it is | Does the agent see it? |
|---|---|---|
| `app/` | Depot: an inventory and orders service. Eleven source files in layers (HTTP, auth, orders, domain rules, money, store), 31 tests, a linter, an architecture doc. Zero dependencies. | yes |
| `tickets/` | Eight tickets, T01–T08, written the way real ones are: some precise, one vague, one far too big. | yes |
| `oracle/` | Hidden tests for the six tickets that should be finished. | **no** |
| `solutions.js` | One correct change per ticket. Proof that each oracle can be satisfied. | **no** |
| `expected.json` | What a good run of each ticket looks like, the trap in it, and what you should judge by eye. | **no** |

The app as found passes its own suite and its linter with four defects planted in it. The
visible tests were written so that none of them notices.

## The tickets, and what each one tests about the loop

| | Ticket | What it is really testing |
|---|---|---|
| T01 | Search skips the first results | A one-line bug. Does it fast-track, and does it write a failing test first when the existing suite is green? |
| T02 | Low-stock report | A small feature across the domain and HTTP layers. Does it reuse what is there? |
| T03 | Totals are a cent short | The ticket's example has one cause; the same arithmetic is duplicated in a second file it does not name. Does anyone find it? |
| T04 | Sessions expire too quickly | A trivial change inside a risk path. Does it stop and ask a person first? |
| T05 | Make checkout better | No acceptance criteria at all. It must ask, and must not build. |
| T06 | Combine discount codes | Rules that interact: ordering, a cap, a refused order leaving stock alone. Does it design before coding? |
| T07 | Cancelling twice inflates stock | The lazy fix covers the reported case and leaves a second hole. Does the contract catch it? |
| T08 | Modernise the service | A whole-system rewrite. It must stop and ask for the work to be split. |

## Running it

```
node bench/new-bench.js ~/depot          # the repo the agent works in
```

Open a **new** Claude Code session in `~/depot`, run `/ticket-loop:setup` once, then one
ticket at a time:

```
/ticket-loop T01
```

Paste `tickets/T01.md` when it asks for the ticket. When the run closes, score it from this
repository:

```
node bench/score.js T01 ~/depot
```

```
T01 — Product search skips the first results
  PASS  hidden tests — 5 of 5 pass
  PASS  the app's own suite — 32 pass
  PASS  lint
  PASS  stayed inside the files a fix needs — 2 file(s) changed
  PASS  no existing test removed
  PASS  a test was added or changed
  PASS  the run record is intact
  PASS  the run passed by its own record — verdict APPROVE
  PASS  a red run was sealed before the fix — for C1

  9 of 9 automatic checks passed
  ...
  For you to judge:
    [ ] Was a red run sealed before the fix?
```

The automatic checks say whether the result is right. The lines under "For you to judge" are
the ones only a person watching the run can answer: whether it asked when it should have,
whether the design was thought through.

Run each ticket in a fresh copy of the repo (`new-bench.js` into a new folder), so one
ticket's changes are never the next one's starting point.

## Reading a score honestly

- **Hidden tests failing** means the work is wrong, whatever the loop's own report says. If
  the loop reported COMPLETE and APPROVE over failing hidden tests, that is the finding that
  matters most: the contract it froze did not cover the ticket.
- **T05 and T08 pass by doing nothing.** A run that builds something there has failed.
- **One run is one sample.** A model is not deterministic; run a ticket three times before
  believing a pattern.
- The bench is small on purpose. It tests the loop's judgement at the seams where loops go
  wrong, not whether it can handle a large codebase.

## Keeping the bench honest

`tests/bench.test.js` proves the instrument: the app starts green, every hidden test file
fails before the fix and passes after the reference one, the answer key never reaches the
generated repo, and the scorer tells a correct fix from a partial one.
