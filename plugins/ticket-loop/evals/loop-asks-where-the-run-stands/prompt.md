---
description: Asked to run a ticket with no shell tool, the loop skill fires, names its next-step command, and claims no progress.
tags: [loop]
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: The ticket-loop skill is invoked; the reply names ledger.js next or the preflight stage as what has to happen first, and does not say any stage was done.
---

Take ticket TODO-1 through the ticket loop as a dry run. The ticket: "Flag overdue todos. isOverdue(todo, now) returns true when an open todo's dueDate is before now; a completed todo is never overdue."
