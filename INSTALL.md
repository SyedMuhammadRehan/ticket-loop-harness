# Install

Three ways, easiest first. All three end the same way: `/ticket-loop <id>` works and a
per-repo `.agents/ticket-loop.config.json` tells it your stack.

## 1. As a plugin (recommended)

One command, then it's available in **every** project you open:

```
/plugin marketplace add SyedMuhammadRehan/ticket-loop-harness
/plugin install ticket-loop
```

The plugin ships the skill, the scripts, and the hooks (registered automatically via
`hooks/hooks.json`). Nothing to copy.

### Upgrading — `update`, not `install`, then restart

```
claude plugin marketplace update ticket-loop-harness   # refresh the cached source
claude plugin update ticket-loop@ticket-loop-harness   # actually change versions
# then QUIT Claude Code and reopen — a new session is not enough
```

`install` is a no-op when the plugin is already present: it prints *"already installed"*
and changes nothing. Worse, `claude plugin details` reports the version from the
**marketplace**, not the one you have installed — so it can read 0.5.0 while 0.2.0 is
still what runs. Use `claude plugin list`, which reports the installed version.

The restart matters because the plugin loader resolves the version at process start.
Opening a fresh session in a still-running Claude Code keeps the old copy, and the run
will look normal while exercising old code.

**Confirm which version actually ran** — the run's own artifacts tell you, and this is
worth checking on the first run after any upgrade:

```
sed -n 4p .agents/ticket-runs/<TICKET>/ledger.md   # want: "counters: sealed receipt chain"
ls .git/ticket-loop/                               # the sealed chain; absent before 0.4.0
```

## 2. Global, by hand (no plugin system)

Copy the skill and hooks into your user-level Claude dir so they load everywhere:

```
cp -r plugins/ticket-loop/skills/ticket-loop  ~/.claude/skills/ticket-loop
cp -r plugins/ticket-loop/hooks/*.js          ~/.claude/hooks/
# then merge settings.example.json's "hooks" block into ~/.claude/settings.json
# (point the commands at ~/.claude/hooks/<script>.js)
```

## 3. Per project

Copy `plugins/ticket-loop/skills/ticket-loop` into the repo's `.claude/skills/` and the
hooks into `.claude/hooks/`, then merge `settings.example.json`'s hooks block into the
repo's `.claude/settings.json`.

## Security — read this before installing globally

**The per-repo profile is executed, so it is as trusted as source code.** The command strings
in `verify.*`, `hooks.postEdit.format`/`analyze` and `hooks.stopGate.testCommand` are run by
the plugin's hooks, and **hooks do not prompt for permission**. That is what makes the harness
stack-agnostic, and it is also the risk:

- With a global install, opening **any** repo that ships a `.agents/ticket-loop.config.json`
  gives that repo arbitrary command execution on your machine — at every file edit
  (`post_edit`) and at every Stop (`stop_gate`).
- So: **review that file before opening an untrusted repo**, exactly as you would review a
  `Makefile`, a `package.json` `postinstall`, or a `.vscode/tasks.json`.
- If you work in repos you don't control, prefer the **per-project install** (option 3) so the
  hooks only exist where you put them, or keep the global install and audit new profiles.

The scripts and hooks are zero-dependency Node and readable in a sitting; `guard_policy.js` and
`chain.js` are the two worth reading first if you want to know what the enforcement actually is.

## Keep the hooks and scripts on the same version

The hooks call `ledger.js`, preferring the copy under `CLAUDE_PLUGIN_ROOT` so both come from
the same installed plugin. If a stale plugin cache leaves them out of step, `dispatch_guard`
prints **"THE DISPATCH BUDGET IS NOT BEING ENFORCED"** and declines to call the old script
rather than letting it write pre-chain state and report a budget that isn't real. If you see
that, update the plugin. If you are *developing* the harness while it is also installed, note
that the installed copy shadows your checkout inside hooks — which is exactly how a green test
suite once hid a regression here, and why `tests/helpers.js` scrubs that variable.

## Every install — do these once per repo

1. **Add a profile.** Copy one block from
   `plugins/ticket-loop/skills/ticket-loop/config.example.json` into
   `.agents/ticket-loop.config.json` and edit it for your stack (test/analyze commands,
   `ticketSource`, `designSource`, `riskPaths`). The `hooks` block arms the format/analyze and
   stop-gate hooks; set `hooks.stopGate.baseRef` to your default branch so **committed** slice
   work is verified (the loop commits every green slice — without a base ref only uncommitted
   changes are seen). `freeze_guard` and `dispatch_guard` work with or without a profile.
2. **gitignore run state:** add `.agents/ticket-runs/` and `.claude/hooks/state/`. You do not
   need to ignore the receipt chain — it lives inside `.git/ticket-loop/`, which git never
   tracks. Do not delete it while a run is in flight: it holds the run's counters and receipts,
   and `ledger.js init` will refuse to carry on if it finds a run dir whose chain has gone
   missing (`--restart` is the sanctioned way out, and it records that the history was lost).
3. **Requirements:** Claude Code, Node ≥ 18, your stack's toolchain on PATH. Ticket/design/
   browser tools (Jira/Figma/Playwright) are optional and degrade gracefully.

## Test it first (do not skip)

Same discipline the harness itself enforces — prove it before trusting it:

```
/ticket-loop <a-small-ticket> --dry-run
```

This reads the ticket, resolves your profile, and writes a frozen done-list **without
touching code**. If that produces a sensible `.agents/ticket-runs/<id>/done.md`, do one
full supervised run on a small, low-risk ticket and watch it.

## Cleaning up a run you want to discard

`rm -rf .agents/ticket-runs/<TICKET>` is **denied** by `freeze_guard` — deleting a run
directory is how a budget gets silently reset, so the guard blocks it whether you mean well
or not. Move it instead; `._old_` names are ignored when the hooks look for active runs:

```
mv .agents/ticket-runs/<TICKET> .agents/ticket-runs/<TICKET>._old_1
```

For a run that has a sealed chain, prefer the sanctioned step, which records the restart:

```
node <SKILL_DIR>/scripts/ledger.js archive .agents/ticket-runs/<TICKET>
```

`archive` needs a chain to move, so it will refuse on a run created by a pre-0.4.0 version —
use the `mv` above for those.

## Honest status

The plugin install path is verified end-to-end: `/plugin marketplace add` +
`/plugin install ticket-loop@ticket-loop-harness` from the published repo works (validated with
`claude plugin validate .`). The loop itself has been exercised mainly on one Flutter repo —
this repo dogfoods it as a Node project (see `.agents/ticket-loop.config.json`), but expect a
rough edge on your first run on a new stack; the `--dry-run` above is how you catch it cheaply.

The enforcement layer was rebuilt after a hostile self-review found that most of it was
advisory: the stop gate could not fire during a real run, the dispatch budget was only enforced
if the orchestrator chose to call the counter, the frozen contract could be reached by any
interpreter, and the profile that armed the hooks was writable mid-run. What is mechanical now
and what is still the orchestrator's discipline is spelled out in the README's
"How the loop stays honest" — including the residual risk, which is that this is
**tamper-evident, not tamper-proof**. `node tests/run.js` runs 150+ tests covering the scripts,
the hooks, and the full corpus of bypasses found during that review as regression cases.

A second hostile review then found that the fix pass had left the enforcement window itself
under the orchestrator's control — writing `report.md` released the dispatch budget and the
control-plane freeze; stage receipts and the QA verdict took no evidence, so all ten gates plus
an `APPROVE` were free commands; the chain could be truncated from the tail or deleted outright
without `verify` noticing; and the stop gate still passed silently when a session committed to
the default branch. Those are fixed, and the README's "How the loop stays honest" now carries a
**named limits** list — read that before trusting the Integrity section of any report.
