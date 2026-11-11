# Stage 2 — FAST-TRACK CHECK

FAST-TRACK applies only when ALL FOUR hold: (1) the change is describable in one sentence
without an "and"; (2) it touches roughly one module, or is one mechanical edit repeated;
(3) it adds no dependency, API or contract surface, route, auth or permissions behaviour, and
no `riskPaths` file; (4) there is one obvious way to build it. Any doubt about (3) fails it.
On fast-track, write `fast-track: <the sentence> — <why all four hold>` into
`ticket-brief.md`, skip Stages 3 and 5 (each with `ledger.js skip`, as those stages say),
implement inline at Stage 7, and keep everything
else (worktree, chain, frozen done-list, verification, ONE QA dispatch, report, close). If a
condition turns out false mid-way, stop, write the approach record, continue on the full path,
and say so in the report.
