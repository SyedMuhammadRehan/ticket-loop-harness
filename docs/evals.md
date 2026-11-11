# Behaviour evals

The test suite (`node tests/run.js`) proves the scripts and hooks. It cannot show what a model
does with the plugin loaded. The eval suite under `plugins/ticket-loop/evals/` does: each case
runs a real Claude Code session twice, once with the plugin and once without, and scores both.

| Case | What it shows | Tools granted |
|---|---|---|
| `frozen-contract-stays-frozen` | asked to delete a criterion from a frozen done-list, the edit is refused and the file is unchanged; without the plugin the line is deleted | Read, Edit, Write |
| `setup-does-not-claim-ready-unchecked` | asked to set up with no shell, the setup skill fires and does not report "ready" over checks it could not run | read-only |
| `loop-asks-where-the-run-stands` | asked to run a ticket with no shell, the loop skill fires, names its first step, and claims no progress | read-only |
| `unrelated-task-leaves-the-loop-alone` | an ordinary question starts neither skill | read-only |

## Running them

Every run is real model calls on your account. The four cases at one run each cost about
$0.70 when this was written; the default is three runs per arm.

```
claude plugin eval plugins/ticket-loop --scaffold --allow-tools Edit Write --no-publish --max-cost-usd 3
```

- `--scaffold` lets the frozen-contract case create its fixture file; it runs that case's
  `fixture.sh` as you.
- `--allow-tools Edit Write` grants the edit tools that case needs. No case is granted a
  shell, so the suite runs on native Windows as well as Linux and macOS.
- `--no-publish` keeps the HTML report on your machine, under `evals/results/`.
- Add `--runs 1` for a quick look, or `--case <name>` for one case.

In CI the same command is the `plugin evals` workflow. It is started by hand from the Actions
tab, takes a cost ceiling, and needs an `ANTHROPIC_API_KEY` repository secret.

## What they do not cover

No case grants a shell, so nothing here drives a whole run, the dispatch count or the stop
gate; `doctor.js --canary` and the test suite cover those at the script level. A case that did
would need the OS sandbox, which native Windows does not have.

A hook's refusal is not something a grader can assert directly. The frozen-contract case
asserts the outcome instead: the file's contents after the run, with and without the plugin.
