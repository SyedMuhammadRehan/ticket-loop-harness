---
name: setup
description: Use when the user types /ticket-loop:setup, has just installed the ticket-loop plugin, or asks to set up, configure or check ticket-loop in a repo. Writes the repo's profile, proves the gates block on this machine, and says exactly what is left before the first /ticket-loop run.
---

# Ticket Loop Setup

Take this repo from "plugin installed" to "ready for a first run", and prove it rather than
assume it. Do the steps in order and stop at the first one that fails: a setup that reports
ready over a failed step is worse than none.

`<SCRIPTS>` is `${CLAUDE_PLUGIN_ROOT}/skills/ticket-loop/scripts`. If that still reads as a
`${…}` placeholder, it is `../ticket-loop/scripts` from this skill's own directory. Run each
command on its own, from the repo root.

## 1. The profile

`node <SCRIPTS>/load_config.js` and read `_meta.configFound`.

- **false**: `node <SCRIPTS>/init.js --dry-run` prints the profile it would write from the repo's
  manifests, default branch and remote, and a list headed "review before the first run". Show the
  user that list and the `verify` block, ask whether the test command is right, then write it with
  `node <SCRIPTS>/init.js`. Never edit the profile to make a later step pass.
- **true**: leave it alone.

## 2. The health check, with the gates tried

`node <SCRIPTS>/doctor.js --canary`

It reads the setup and then tries each gate against a real violation in a throwaway repo under
the temp directory: an edit to a frozen contract, an edit under a risk path, a `git push`, an
uncounted dispatch, and a "done" claim over a red suite. Show the user every line it prints.
Any `problem` line means NOT ready: give the user its `fix` line and stop.

## 3. The live check — that Claude Code is calling the hooks

The canary above runs the hook scripts directly. This step shows this session runs them.
Run exactly this one Bash command, and nothing else with it:

`echo canary > .agents/ticket-runs/.setup-canary/done.md`

- **Refused with a message starting `BLOCKED:`** naming the ticket-loop plugin: the write guard
  is live. This is the result you want.
- **Anything else** (a "No such file or directory" error, or success): the hooks are NOT
  running in this session. Tell the user so plainly, and the usual causes: the plugin was
  installed or updated after this session started (open a new session); the plugin is
  disabled; or an organisation setting allows managed hooks only. Do not report ready.

The command cannot do damage either way: the directory does not exist, so with no guard it
fails on its own.

## 4. Tell the user where they stand

In a few lines: the stack and test command the profile holds; what doctor and both canaries
showed; anything from the review list still unanswered; and that the profile and the
`.gitignore` change should be committed to the default branch so teammates and the CI merge
check have them. Then the next command: `/ticket-loop <ticket> --dry-run` on a small ticket,
which plans without touching code.

Say only what the steps showed. If step 2 or 3 failed, the answer is "not ready, because …".
