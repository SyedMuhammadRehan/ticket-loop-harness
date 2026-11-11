#!/usr/bin/env bash
# A frozen done-list as a finished Stage 6 leaves it. The write guard protects this file by its
# path alone, so no run has to be opened for the case.
set -euo pipefail
mkdir -p .agents/ticket-runs/T-1
cat > .agents/ticket-runs/T-1/done.md <<'DONE'
# Done — T-1
## Criteria
- [ ] C1 (test): when a todo is past its due date, isOverdue returns true | run: npm test
- [ ] C2 (analyzer): zero analyzer errors | run: npm run lint
## Out of scope
- time zones
DONE
