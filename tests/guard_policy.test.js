'use strict';
// The write-policy corpus. Every DENY case here is a bypass that was found by attacking the
// old verb-blocklist guard and confirmed to get through; every ALLOW case is legitimate work
// that must not break. Both halves matter: a guard that only ever denies is a guard nobody
// keeps installed.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { HOOKS_DIR } = require('./helpers.js');

const policy = require(path.join(HOOKS_DIR, 'guard_policy.js'));

const RUN = '.agents/ticket-runs/PROJ-1';
const denied = (cmd, runActive = true) => policy.commandVerdict(cmd, { runActive }) !== null;
const deniedPath = (p, runActive = true) => policy.pathVerdict(p, { runActive }) !== null;

// --- interpreter writes: the class with no shell write-verb at all ---

test('inline interpreter writes to frozen artifacts are denied', () => {
  for (const cmd of [
    `python -c "open('${RUN}/done.md','w').write('- [x] C1 done')"`,
    `python3 -c "import os; os.remove('${RUN}/budget.json')"`,
    `node -e "require('fs').writeFileSync('${RUN}/budget.json','{}')"`,
    `perl -e "open(F,'+<','${RUN}/done.md'); print F 'x'"`,
    `ruby -e "File.write('${RUN}/done.md','x')"`,
    `[System.IO.File]::WriteAllText('${RUN}\\done.md','pwned')`,
    `[System.IO.Directory]::Move('${RUN}','${RUN}._bak')`,
    `install -m 644 /dev/null ${RUN}/done.md`,
    `awk 'BEGIN{print "x" > "${RUN}/done.md"}'`,
    `echo x | tee ${RUN}/done.md`,
    `echo ${RUN}/done.md | xargs rm`,
  ]) {
    assert.ok(denied(cmd), `should deny: ${cmd}`);
  }
});

// --- command substitution inside an otherwise-sanctioned invocation ---

test('$(...) and backticks cannot ride the sanctioned-writer exemption', () => {
  for (const cmd of [
    `node scripts/ledger.js status ${RUN} $(rm -rf ${RUN})`,
    'node scripts/ledger.js status ' + RUN + ' `rm -rf ' + RUN + '`',
    `node scripts/ledger.js status ${RUN} $(python -c "open('${RUN}/done.md','w')")`,
  ]) {
    assert.ok(denied(cmd), `should deny: ${cmd}`);
  }
});

test('the sanctioned exemption still rejects chaining and newlines', () => {
  for (const cmd of [
    `node scripts/ledger.js status ${RUN} && echo p > ${RUN}/done.md`,
    `node scripts/ledger.js status ${RUN}\nrm ${RUN}/budget.json`,
    `echo pwned > ${RUN}/done.md # via ledger.js`,
  ]) {
    assert.ok(denied(cmd), `should deny: ${cmd}`);
  }
});

// --- cd first, so no path-anchored pattern matches the write itself ---

test('changing directory first does not launder a write', () => {
  for (const cmd of [
    `cd ${RUN}; echo "- [x] all done" > done.md`,
    `cd ${RUN} && sed -i "s/C3.*//" done.md`,
    `cd ${RUN} && rm budget.json`,
    `pushd ${RUN}; Set-Content done.md '{}'`,
  ]) {
    assert.ok(denied(cmd), `should deny: ${cmd}`);
  }
});

// --- opaque execution and repo-wide destruction ---

test('opaque command execution is refused while a run is active', () => {
  assert.ok(denied('powershell -EncodedCommand UwBlAHQALQBDAG8AbgB0AGUAbgB0AA=='));
  assert.ok(denied('echo cm0gLXJm | base64 -d | sh'));
  assert.ok(denied('[Convert]::FromBase64String($x) | iex'));
});

test('repo-wide destruction that never names the run dir is refused mid-run', () => {
  for (const cmd of ['git clean -fdx', 'git clean -fd', 'git stash push --include-untracked', 'git reset --hard origin/main']) {
    assert.ok(denied(cmd), `should deny: ${cmd}`);
  }
});

test('the same commands are allowed again once no run is active', () => {
  for (const cmd of ['git clean -fdx', 'git stash push -u', 'powershell -EncodedCommand AAA=']) {
    assert.ok(!denied(cmd, false), `should allow when idle: ${cmd}`);
  }
});

// --- path-shape evasion ---

test('quoted paths, spaces and absolute Windows paths do not evade the reference match', () => {
  assert.ok(denied(`sed -i "s/x//" ".agents/ticket-runs/PROJ 1/done.md"`));
  assert.ok(denied(`Set-Content C:\\repo\\.agents\\ticket-runs\\PROJ-1\\done.md 'x'`));
  assert.ok(denied(`echo pwned > .agents/Ticket-Runs/PROJ-1/DONE.MD`));
  assert.ok(denied(`Rm .agents/TICKET-RUNS/PROJ-1/done.APPROVED.md`));
});

test('git is only read-only for read-only subcommands', () => {
  assert.ok(!denied(`git diff --no-index ${RUN}/done.approved.md ${RUN}/done.md`));
  assert.ok(!denied(`git log --oneline -- ${RUN}`));
  assert.ok(denied(`git checkout HEAD -- ${RUN}/done.md`));
  assert.ok(denied(`git restore ${RUN}/done.md`));
  assert.ok(denied(`git rm ${RUN}/done.md`));
});

// --- the allow half: legitimate work must survive ---

test('read-only inspection of frozen artifacts stays allowed', () => {
  for (const cmd of [
    `cat ${RUN}/done.md`,
    `cat ${RUN}/done.md | grep C1`,
    `cd ${RUN} && cat done.md`,
    `head -20 ${RUN}/done.approved.md`,
    `rg C3 ${RUN}/done.md`,
    `Get-Content ${RUN}/done.md`,
    `git diff --no-index ${RUN}/done.approved.md ${RUN}/done.md`,
  ]) {
    assert.ok(!denied(cmd), `should allow: ${cmd}`);
  }
});

test('sanctioned harness invocations stay allowed', () => {
  for (const cmd of [
    `node scripts/freeze_done.js ${RUN}`,
    `node scripts/validate_done.js ${RUN}`,
    `node scripts/ledger.js dispatch ${RUN} "qa"`,
    `node scripts/ledger.js gate ${RUN} freeze --evidence ${RUN}/done.md`,
    `node scripts/ledger.js archive ${RUN}`,
    `"C:\\Program Files\\nodejs\\node.exe" scripts/ledger.js status ${RUN}`,
  ]) {
    assert.ok(!denied(cmd), `should allow: ${cmd}`);
  }
});

test('unrelated work is never evaluated', () => {
  for (const cmd of [
    'flutter test test/ui/profile_test.dart',
    'echo x > docs/done.md',
    'node -e "console.log(1+1)"',
    'git worktree list --porcelain',
    'git worktree remove ../ticket-PROJ-1',
    'git branch -D ticket/PROJ-1',
    'git -C ../ticket-PROJ-1 commit -m "wip(PROJ-1): C1 green"',
    'npm test -- ledger.test.js',
    'rg TODO lib/',
  ]) {
    assert.ok(!denied(cmd), `should allow: ${cmd}`);
  }
});

// --- path surface + the two protection tiers ---

test('frozen artifacts are protected whether or not a run is active', () => {
  for (const p of [
    '.agents/ticket-runs/PROJ-1/done.md',
    '.agents\\ticket-runs\\PROJ-1\\done.md',
    '.agents/ticket-runs/PROJ-1/budget.json',
    'docs/spec.approved.md',
    '.git/ticket-loop/PROJ-1/chain.jsonl',
    '.git/ticket-loop/PROJ-1/chain.2.jsonl',
    '.git/ticket-loop/PROJ-1/key',
  ]) {
    assert.ok(deniedPath(p, true), `should deny while active: ${p}`);
    assert.ok(deniedPath(p, false), `should deny while idle too: ${p}`);
  }
});

test('the control plane is protected mid-run and writable when idle', () => {
  for (const p of [
    '.agents/ticket-loop.config.json',
    '.claude/hooks/state/stop-state.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    'plugins/ticket-loop/hooks/freeze_guard.js',
    'plugins/ticket-loop/hooks/stop_gate.js',
    'plugins/ticket-loop/hooks/hooks.json',
    'plugins/ticket-loop/skills/ticket-loop/scripts/ledger.js',
    'plugins/ticket-loop/skills/ticket-loop/scripts/chain.js',
  ]) {
    assert.ok(deniedPath(p, true), `should deny mid-run: ${p}`);
    assert.ok(!deniedPath(p, false), `must stay writable when idle (the harness has to be developable): ${p}`);
  }
});

test('the loop\'s own writable artifacts stay writable', () => {
  for (const p of [
    '.agents/ticket-runs/PROJ-1/done-additions.md',
    '.agents/ticket-runs/PROJ-1/done.draft.md',
    '.agents/ticket-runs/PROJ-1/ledger.md',
    '.agents/ticket-runs/PROJ-1/report.md',
    '.agents/ticket-runs/PROJ-1/approach.md',
    '.agents/ticket-runs/PROJ-1/assumptions.md',
    'lib/src/done_button.dart',
  ]) {
    assert.ok(!deniedPath(p, true), `should allow: ${p}`);
  }
});

test('an unrelated write in another statement does not condemn a read of the run dir', () => {
  const RM = 'rm -r' + 'f';
  assert.ok(!denied(`node scripts/ledger.js status ${RUN} ; ${RM} /tmp/scratch`));
  assert.ok(!denied(`node scripts/ledger.js verify ${RUN} && ${RM} /tmp/tdir`));
  assert.ok(!denied(`cat ${RUN}/done.md; ${RM} /tmp/x`));
  assert.ok(!denied(`git diff --no-index ${RUN}/done.md ${RUN}/ledger.md && echo compared`));
});

test('per-statement judging does not reopen the cross-statement bypasses', () => {
  const RM = 'rm -r' + 'f';
  assert.ok(denied(`cd ${RUN} && ${RM} .`));
  assert.ok(denied(`cd ${RUN}; echo x > done.md`));
  assert.ok(denied(`pushd ${RUN}; Set-Content done.md '{}'`));
  assert.ok(denied(`node scripts/ledger.js status ${RUN} $(${RM} ${RUN})`));
  assert.ok(denied('node scripts/ledger.js status ' + RUN + ' `' + RM + ' ' + RUN + '`'));
  assert.ok(denied(`cat ${RUN}/done.md | sh`));
  assert.ok(denied(`echo ok ; ${RM} ${RUN}`));
  assert.ok(denied(`npm test && echo pwned > ${RUN}/done.md`));
});
