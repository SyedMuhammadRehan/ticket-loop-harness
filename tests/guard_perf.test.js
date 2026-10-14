'use strict';
// The hook has a timeout, and a timed-out hook lets the call through, so a pattern that is
// quadratic on some input is a bypass with that input. These run every verdict on long
// adversarial commands; a superlinear pattern takes tens of seconds on them.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { HOOKS_DIR } = require('./helpers.js');

const policy = require(path.join(HOOKS_DIR, 'guard_policy.js'));

const SIZE = 200 * 1024;
const LIMIT_MS = 1000;
const UNITS = [
  'x', '/', '.', '-', ' ', '"', "'", '\\', '1', '*', '[', '{', '$', '>', '|',
  'ticket-loop/', '.git/', '.agents/', 'ticket-runs/', 'a.approved.md', '*/', '.a*/',
  'node ', 'git ', 'cd ', 'sh ', 'sort ', 'find ', 'base64 ', 'powershell ', 'gh pr ',
  'git clean ', 'git reset ', 'git branch ', 'done.md ', 'lib/auth/x.js ', 'x\\-',
];

// The fastest of a few tries: a loaded machine slows one try, never all of them tenfold.
const TRIES = 3;
function fastestMs(fn) {
  let best = Infinity;
  for (let i = 0; i < TRIES && best >= LIMIT_MS; i++) {
    const start = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
  }
  return best;
}

test('every verdict on a 200 KB adversarial string completes in under a second', () => {
  const opts = { riskPaths: ['lib/auth/**', '**/migrations/**'], cleared: [] };
  for (const unit of UNITS) {
    const s = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
    for (const runActive of [false, true]) {
      const ms = fastestMs(() => policy.commandVerdict(s, { runActive, ...opts }));
      assert.ok(ms < LIMIT_MS, `commandVerdict took ${ms.toFixed(0)} ms on ${JSON.stringify(unit)} x ${SIZE} (runActive=${runActive})`);
    }
    const ms = fastestMs(() => {
      policy.pathVerdict(s, { runActive: true });
      policy.riskVerdict(s, { runActive: true, ...opts });
      policy.secretPathVerdict(s, { directory: true });
    });
    assert.ok(ms < LIMIT_MS, `path verdicts took ${ms.toFixed(0)} ms on ${JSON.stringify(unit)} x ${SIZE}`);
  }
});
