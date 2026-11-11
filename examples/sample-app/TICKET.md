# TODO-1: Flag overdue todos

A todo can carry a `dueDate` (an ISO date string such as `2026-03-01`). Nothing tells a user
which open todos are late.

## Acceptance criteria

1. `isOverdue(todo, now)` returns `true` when the todo is open, has a `dueDate`, and that date
   is before `now`.
2. A completed todo is never overdue.
3. A todo with no `dueDate` is never overdue.
4. `listOverdue(todos, now)` returns the overdue todos, earliest due date first.

## Out of scope

- Time zones: dates are compared as given.
- Any change to how todos are created or completed.
