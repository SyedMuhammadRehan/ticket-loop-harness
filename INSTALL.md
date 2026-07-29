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

## Every install — do these once per repo

1. **Add a profile.** Copy one block from
   `plugins/ticket-loop/skills/ticket-loop/config.example.json` into
   `.agents/ticket-loop.config.json` and edit it for your stack (test/analyze commands,
   `ticketSource`, `designSource`, `riskPaths`). The `hooks` block in the profile is what
   arms the enforcement hooks (format/analyze on edit, tests before a "done" claim) —
   without a config the hooks stay inert.
2. **gitignore run state:** add `.agents/ticket-runs/` and (if hooks write state)
   `.claude/hooks/state/`.
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

## Honest status

The plugin install path is verified end-to-end: `/plugin marketplace add` +
`/plugin install ticket-loop@ticket-loop-harness` from the published repo works (v0.2.0,
validated with `claude plugin validate .`). The loop itself has been exercised mainly on
one Flutter repo — this repo dogfoods it as a Node project (see `.agents/ticket-loop.config.json`),
but expect a rough edge on your first run on a new stack; the `--dry-run` above is how you
catch it cheaply. The hooks and scripts are config-driven (no stack hardcoding) and covered
by a test suite — run `node tests/run.js` from the repo root to verify them on your machine.
