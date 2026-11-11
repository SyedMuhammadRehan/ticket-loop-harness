# Troubleshooting

Find the message you were shown; each heading is the exact wording the plugin prints. Every
refusal here is the harness doing its job, so the fix is almost never "get around it".

Start with these two whenever something looks wrong:

```
/ticket-loop:setup                                   # the profile, the health check, and both canaries
node <SKILL_DIR>/scripts/doctor.js --canary          # the same checks by hand
```

`<SKILL_DIR>` is the installed skill,
`~/.claude/plugins/cache/ticket-loop-harness/ticket-loop/<version>/skills/ticket-loop`.

## Install and setup

### `echo canary > .agents/ticket-runs/.setup-canary/done.md`

**You see:** `/ticket-loop:setup` ran this command and it was NOT refused (it failed with "No
such file or directory", or succeeded).
**Means:** Claude Code is not calling the plugin's hooks in this session, so nothing is enforced.
**Do:** open a new session, since a session keeps the plugin version it started with; check
`claude plugin list` shows ticket-loop enabled; ask whether your organisation allows managed
hooks only, which silently disables plugin hooks.

### `STALE SKILL`

**Means:** the session loaded an older version of the playbook than the one now installed.
**Do:** start a new session. Nothing else fixes it.

### `is not gitignored`

**Means:** run state would show up as a change in every worktree.
**Do:** add `.agents/ticket-runs/` and `.claude/hooks/state/` to `.gitignore`.
`/ticket-loop:setup` and `init.js` do this for you.

### `which is not on PATH`

**Means:** a `verify.*` command in the profile names a program this machine does not have.
**Do:** install it, or change the command in `.agents/ticket-loop.config.json` before the first
run. The profile is frozen once a run starts.

### `npm ci, but the repo has no package-lock.json`

**Do:** commit a lockfile (`npm install` writes one), or set `verify.pubGet` to `npm install`.

### `the gates could not be tried`

**Means:** `doctor.js --canary` could not stand up its throwaway repo, usually because `git`
is missing or the hooks are not installed beside the scripts.
**Do:** read the reason after the colon; reinstall the plugin if it names a missing hook.

## The write guard refused a command or an edit

### `default-deny on the protected namespace`

**Means:** the command names the run directory or the receipt chain and is neither a plain
read nor a bare harness call. This rule holds with or without a run.
**Do:** run harness scripts as one bare command, `node <SKILL_DIR>/scripts/<script> <args>`:
no variable for the path, nothing chained with `;`, `&&` or `|`, and the installed copy rather
than a checkout. To put text that mentions those paths in a file or a commit message, use the
editor or `git commit -F <file>`.

### `frozen run artifact`

**Means:** the file is the frozen contract, a counter mirror or the receipt chain.
**Do:** nothing edits these. A new criterion goes in with
`ledger.js addition <runDir> "- [ ] C<n> (kind): … | run: …"`.

### `enforcement control plane`

**Means:** a run is open, and the file is the profile, a hook, a script or Claude Code
settings. Changing what the gates check while they are gating is refused.
**Do:** finish the run, or end it with `ledger.js archive <runDir>`. `doctor.js` lists every
open run, including one another session left behind.

### `no recorded clearance for it`

**Means:** the file is under one of the profile's `riskPaths` and no person has cleared that
area for this run.
**Do:** ask the person. Only when they agree:
`ledger.js clear <runDir> "<the glob as the profile spells it>" "<what they approved>"`.

### `git push — the loop hands you a branch`

**Means:** a run is open. Pushing, merging, rebasing and opening a PR are refused until it
closes.
**Do:** close the run first. With `publish.allowed` set and consent given at the start,
`publish.js` pushes the ticket branch after close.

### `was started by another session and this one has not touched it`

**Means:** an open run you did not start is arming every gate in this repo.
**Do:** continue it with `/ticket-loop <TICKET>`, or end it with `ledger.js archive <runDir>`.

## The stop gate would not let the turn end

### `tests FAILED in`

**Means:** a run is open and the suite is red in that tree.
**Do:** fix the code. The output above the message is the suite's own.

### `letting this one through so the session is not wedged`

**Means:** the gate blocked three stops in a row and released the fourth. The run is NOT
verified.
**Do:** treat the run as failing. The report must say so.

### `refusing to confirm a "done" claim it cannot verify`

**Means:** a run is open but the profile has no usable `hooks.stopGate` block.
**Do:** if the profile changed mid-run, restore it. If the block was never there, end the run
with `ledger.js archive <runDir>`, add the block, and start again.

### `has a budget.json but no receipt chain on this machine`

**Means:** the run directory was copied or committed from elsewhere; it was not started here.
**Do:** `ledger.js archive <runDir>`, and keep `.agents/ticket-runs/` gitignored.

### `have no outcome and no sign of life`

**Means:** a dispatched agent went quiet past `dispatchPolicy.stallMinutes`.
**Do:** if it finished, record what it produced; if it is dead,
`ledger.js outcome <runDir> <seq> died "<what killed it>"`.

## A dispatch was refused

### `the dispatch prompt still holds template placeholder(s)`

**Do:** fill every `{PLACEHOLDER}` the stage file lists before dispatching.

### `is gone, so its budget cannot be enforced`

**Means:** the run's receipt chain is open but its run directory was deleted.
**Do:** restore the directory, or end the run with `ledger.js archive <runDir>`.

### `judge is refused`

**Means:** three QA verdicts in this run were BLOCK.
**Do:** stop and ask the person whether the contract or the work is wrong.

### `no further dispatch`

**Means:** the run reached its token ceiling.
**Do:** go to the report as INCOMPLETE, or, on the person's word,
`ledger.js raise <runDir> --tokens <n> "<reason>"`. The org policy's cap cannot be raised.

## The ledger refused a command

### `a receipt chain already exists for`

**Means:** this ticket already has a run.
**Do:** `ledger.js next <runDir>` says where it stands; continue it. For a clean restart,
`ledger.js archive <runDir>` and then `ledger.js init <runDir> <baseSha> --restart`.

### `is not a commit of the repo at`

**Means:** the base commit belongs to another repo: the run directory resolved somewhere you
did not mean.
**Do:** pass `<runDir>` as an absolute path inside the repo the ticket is for.

### `where the hooks look for a run`

**Do:** the run directory is always `<repo>/.agents/ticket-runs/<TICKET>`.

### `the machine's policy governs`

**Means:** this machine has an org policy and `TICKET_LOOP_POLICY` points somewhere else.
**Do:** unset the variable.

### `passes --by command --cwd <wt>`

**Means:** the criterion has a command in the frozen contract, so only running it decides a pass.
**Do:** `ledger.js check <runDir> <C-id> PASS --by command --cwd <wt>`. If the command cannot
run on this machine, record SKIPPED and say so in the report.

### `is not a checkout of the run's repo`

**Do:** `--cwd` is the ticket worktree's root, never another directory or a subfolder.

### `cannot be skipped`

**Means:** only `survey`, `design` and `approach` may be passed over, each with a reason.
**Do:** do the stage `ledger.js next` names.

### `no ticket-loop-qa judge was dispatched through the hook`

**Means:** a verdict can only be sealed by the QA judge, dispatched after the freeze.
**Do:** dispatch the judge as `ticket-loop-qa` (Stage 9); it seals its own verdict.

### `refusing to close`

**Means:** the report is not gated yet, or a dispatch has no outcome.
**Do:** the message says which; `ledger.js next <runDir>` names the stage.

## The integrity check reports a problem

### `RECEIPT CHAIN BROKEN`

**Means:** a record in the chain was altered, removed or added around the ledger.
**Do:** stop and tell a person. Do not repair it and do not report the run COMPLETE.

### `changed after it was sealed by the`

**Means:** a file a gate sealed was edited without `ledger.js revise`.
**Do:** it cannot be undone. Report `Integrity: TAMPERED` with the problem verbatim. Next time,
record the edit first: `ledger.js revise <runDir> <file> --reason "<what and why>"`.

### `records were appended after the run was closed`

**Do:** report it as it stands. A new pass over the ticket is `ledger.js archive`, then a fresh
`init --restart`.
