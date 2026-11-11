# Install

Three ways, easiest first. All three end the same way: `/ticket-loop <id>` works and a
per-repo `.agents/ticket-loop.config.json` tells it your stack.

## 1. As a plugin (recommended)

One command, then it's available in **every** project you open:

```
/plugin marketplace add SyedMuhammadRehan/ticket-loop-harness
/plugin install ticket-loop@ticket-loop-harness
```

The plugin ships the skill, the scripts, and the hooks (registered automatically via
`hooks/hooks.json`). Nothing to copy.

### Upgrading — `update`, not `install`, then restart

```
claude plugin marketplace update ticket-loop-harness   # refresh the cached source
claude plugin update ticket-loop@ticket-loop-harness   # actually change versions
# then start a NEW session — the running one keeps the version it loaded at start
```

`install` is a no-op when the plugin is already present: it prints *"already installed"*
and changes nothing. Worse, `claude plugin details` reports the version from the
**marketplace**, not the one you have installed — so it can read 0.5.0 while 0.2.0 is
still what runs. Use `claude plugin list`, which reports the installed version.

`update` prints *"Restart to apply changes"*. In practice a new session was enough once the
update had run — but a session started **before** the update keeps the old version, and the
run looks entirely normal while exercising old code. That is the trap: nothing in the output
tells you, so verify rather than assume.

**Maintainers: `update` compares version numbers, so shipping a behaviour change without
bumping one is invisible.** Merge a fix at the same version and the command answers *"already
at the latest version"* while every installed copy keeps running the old code — a success
message over stale bytes, which is the same failure as the two above wearing a third face.
`package.json`, the plugin manifest and the marketplace entry must all move together.

**Confirm which version actually ran** — the run's own artifacts tell you, and this is
worth checking on the first run after any upgrade:

```
sed -n 4p .agents/ticket-runs/<TICKET>/ledger.md   # want: "counters: sealed receipt chain"
```

Run it in your own terminal, not through Claude Code: inside a session the write guard refuses
commands that list the chain directory under `.git/ticket-loop/`, because the chain key lives
there.

## 2. Global, by hand (no plugin system)

Copy the skill and hooks into your user-level Claude dir so they load everywhere:

```
cp -r plugins/ticket-loop/skills/ticket-loop  ~/.claude/skills/ticket-loop
cp -r plugins/ticket-loop/skills/qa-check     ~/.claude/skills/qa-check
cp -r plugins/ticket-loop/hooks/*.js          ~/.claude/hooks/
cp plugins/ticket-loop/agents/ticket-loop-qa.md ~/.claude/agents/
# then merge settings.example.json's "hooks" block into ~/.claude/settings.json
# (point the commands at ~/.claude/hooks/<script>.js, by absolute path)
```

The agent file is not optional: Stage 9 dispatches the judge as `ticket-loop-qa`, and a verdict
binds to no other agent type.

## 3. Per project

Copy `plugins/ticket-loop/skills/ticket-loop` (and `skills/qa-check`) into the repo's
`.claude/skills/`, the hooks into `.claude/hooks/`, and `agents/ticket-loop-qa.md` into
`.claude/agents/`, then merge `settings.example.json`'s hooks block into the repo's
`.claude/settings.json`.

## Security — read this before installing globally

**The per-repo profile is executed, so it is as trusted as source code.** The command strings
in `verify.*`, `hooks.postEdit.format`/`analyze` and `hooks.stopGate.testCommand` are run by
the plugin's hooks, and **hooks do not prompt for permission**. That is what makes the harness
stack-agnostic, and it is also the risk:

- With a global install, opening **any** repo that ships a `.agents/ticket-loop.config.json`
  gives that repo arbitrary command execution on your machine — at every file edit
  (`post_edit`), run or no run, and at every Stop while a ticket run is active (`stop_gate`).
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

**The short way: open a new session in the repo and type `/ticket-loop:setup`.** It does steps
1 to 3 below for you, asks before writing the profile, and then proves the gates block: once by
feeding each one a real violation in a throwaway repo, and once with a tool call the write
guard has to refuse, which shows this session is running the hooks. The steps below are the
same thing by hand, and the reference for what each one means.

`<SKILL_DIR>` below is where the installed skill lives. As a plugin that is
`~/.claude/plugins/cache/ticket-loop-harness/ticket-loop/<version>/skills/ticket-loop`
(`claude plugin list` shows the version; use the newest folder). By hand it is
`~/.claude/skills/ticket-loop` or the repo's `.claude/skills/ticket-loop`. Inside a session the
quickest way is to ask Claude to run the step: the skill knows its own directory. Use the
installed copy, not a checkout of this repo: once the plugin is installed, the write guard
accepts harness commands only from the scripts beside its own hooks.

1. **Add a profile.** From the repo, `node <SKILL_DIR>/scripts/init.js --dry-run` shows the
   profile it would write from your manifests, default branch and remote; run it without
   `--dry-run` to write it and gitignore run state, then review the lines it lists. Or copy one
   block from `plugins/ticket-loop/skills/ticket-loop/config.example.json` into
   `.agents/ticket-loop.config.json` and edit it for your stack (test/analyze commands,
   `ticketSource`, `designSource`, `riskPaths`). The `hooks` block arms the format/analyze and
   stop-gate hooks; set `hooks.stopGate.baseRef` to your default branch so **committed** slice
   work is verified (the loop commits every green slice — without a base ref only uncommitted
   changes are seen). `freeze_guard` and `dispatch_guard` work with or without a profile.
   **Commit the profile and the `.gitignore` change to your default branch**: the team shares
   one profile, and the CI merge check reads it from the base branch. A run on your own machine
   reads the main checkout's copy either way; `doctor.js` notes an uncommitted one.
2. **gitignore run state:** add `.agents/ticket-runs/` and `.claude/hooks/state/`. You do not
   need to ignore the receipt chain — it lives inside `.git/ticket-loop/`, which git never
   tracks. Do not delete it while a run is in flight: it holds the run's counters and receipts,
   and `ledger.js init` will refuse to carry on if it finds a run dir whose chain has gone
   missing (`--restart` is the sanctioned way out, and it records that the history was lost).
   One rule holds in every repo, run or no run: inside Claude Code, a shell command that names
   `.agents/ticket-runs/` and is not read-only or a harness script is refused, even when the
   path is only text in an `echo`, a heredoc or a commit message. Write such text with an
   editor, or `git commit -F <file>`.
3. **Check it:** `node <SKILL_DIR>/scripts/doctor.js` reports anything wrong with the setup,
   each with its fix, and changes nothing. It looks up every program the `verify.*` commands
   name on PATH (it runs none of them), and ends with `ok: 0 problems, N notes` when you are
   done. It cannot tell whether your test command can *fail*: break one test, run the command,
   see a non-zero exit, then restore it. Run it again whenever hooks or runs behave oddly; it
   finds pre-plugin copies of these hooks, abandoned runs and leftover ticket worktrees.
4. **Optional: sign finished runs.** `node <SKILL_DIR>/scripts/ledger.js keygen` once per
   machine creates an Ed25519 key under `~/.claude/ticket-loop/signing/` and prints its key id.
   The loop then exports each closed run as a signed bundle; anyone can check one with
   `node verify_bundle.js <bundle> --trust <keyId>`, a single file that needs nothing else.
   In CI, give the merge check its own key as the `TICKET_LOOP_CI_KEY` secret instead.
   To gate merges on it, list the trusted key ids in `.agents/ticket-loop.trust` on your default
   branch and add the merge check from [docs/ci.md](docs/ci.md) as a required status check.
5. **Optional: an org policy.** Put a policy JSON at `~/.claude/ticket-loop/policy.json` (or set
   `TICKET_LOOP_POLICY`) to set a floor every repo's profile must meet: extra `riskPaths`,
   `allowedModels` per role, `qaScope.maxSmallDiffLines`, `requireMatchingTest`,
   `attribution.commitTrailer`. `doctor.js` reports a profile that breaks it.
6. **Optional, and recommended if you walk away from runs: notifications.** Put your channels in
   `~/.claude/ticket-loop/notify.json` (the format is at the top of `scripts/notify.js`): any of
   ntfy, Telegram, WhatsApp, Slack, Discord or a webhook, as many as you like, so one blocked
   where you are still leaves the others. To answer from your phone, add ntfy, or a Telegram,
   Slack or Discord bot with your own `userId` (only that user's answers can clear a risk path;
   where Telegram is blocked, Slack or Discord does the same job). Then
   `node <SKILL_DIR>/scripts/notify.js test`. Claude Code's own Remote Control works alongside.
7. **Requirements:** Claude Code, Node ≥ 18, your stack's toolchain on PATH. Ticket/design/
   browser tools (Jira/Figma/Playwright) are optional and degrade gracefully.
8. **Optional: the deny list.** `settings.example.json` also carries a `permissions.deny`
   block. It is not part of the harness and nothing here depends on it. It exists because the
   guard hooks refuse destructive and publishing commands **only while a ticket run is
   active** — outside one this is just your repo, and the harness deliberately gets out of the
   way. If you want the same floor in ordinary sessions, merge the block; it denies reads and
   writes of `.env*` and `secrets/**`, plus `rm -rf`, `git push --force` and `git reset
   --hard`. Drop any entry that fights how you work: a rule you disable in irritation protects
   nothing, and a deny list you have stopped reading is worse than none.

## Test it first (do not skip)

Same discipline the harness itself enforces — prove it before trusting it:

```
/ticket-loop <a-small-ticket> --dry-run
```

This reads the ticket, resolves your profile, and writes a frozen done-list **without
touching code**. If that produces a sensible `.agents/ticket-runs/<id>/done.md`, do one
full supervised run on a small, low-risk ticket and watch it.

The dry run is a real run that stops early: it **stays open**, and while it is open the stop
gate runs your tests at every Stop and the profile is frozen. Continue it with
`/ticket-loop <id>`, or end it as below. `doctor.js` lists every open run.

## Cleaning up a run you want to discard

Inside Claude Code, deleting or moving a run directory is **denied** by `freeze_guard` —
that is how a budget gets silently reset, so the guard blocks it whether you mean well or not.
The sanctioned step records the restart in the run's sealed chain:

```
node <SKILL_DIR>/scripts/ledger.js archive .agents/ticket-runs/<TICKET>
```

`archive` needs a chain to move, so it refuses a run created by a pre-0.4.0 version. For
those, rename the directory from your own terminal, outside Claude Code, where the hooks do
not run; `._old_` names are ignored when the hooks look for active runs:

```
mv .agents/ticket-runs/<TICKET> .agents/ticket-runs/<TICKET>._old_1
```

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
**tamper-evident, not tamper-proof**. `node tests/run.js` runs the suite covering the scripts,
the hooks, and the full corpus of bypasses found during that review as regression cases.

A second hostile review then found that the fix pass had left the enforcement window itself
under the orchestrator's control — writing `report.md` released the dispatch budget and the
control-plane freeze; stage receipts and the QA verdict took no evidence, so all ten gates plus
an `APPROVE` were free commands; the chain could be truncated from the tail or deleted outright
without `verify` noticing; and the stop gate still passed silently when a session committed to
the default branch. Those are fixed, and the README's "How the loop stays honest" now carries a
**named limits** list — read that before trusting the Integrity section of any report.
