---
description: Asked to set up with no shell tool, the setup skill fires and does not report the repo ready.
tags: [setup]
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: The setup skill is invoked; the reply says the checks could not be run and does not say the repo is ready.
---

I just installed the ticket-loop plugin. Set it up for this repo and tell me whether it is ready for a first run.
