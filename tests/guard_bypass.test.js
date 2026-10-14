'use strict';
// Bypasses of the write guard found by attacking it, each confirmed to get through before its
// mechanism existed. The allow half of every test is legitimate work the mechanism must not
// take with it.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { HOOKS_DIR, SCRIPTS_DIR } = require('./helpers.js');

const policy = require(path.join(HOOKS_DIR, 'guard_policy.js'));

const RUN = '.agents/ticket-runs/T-1';
const RM = 'rm -r' + 'f';
const verdict = (cmd, opts = {}) => policy.commandVerdict(cmd, { runActive: true, ...opts });
const denied = (cmd, opts) => verdict(cmd, opts) !== null;
const deniedIdle = (cmd) => policy.commandVerdict(cmd, { runActive: false }) !== null;
const deniedPath = (p, runActive = true) => policy.pathVerdict(p, { runActive }) !== null;

// --- 1. the parent directories ---

test('removing or renaming .agents or .git is refused mid-run, and reading them is not', () => {
  for (const cmd of [
    `${RM} .agents`,
    'mv .agents x',
    'Remove-Item -Recurse .agents',
    'Rename-Item .agents x',
    'git mv .agents x',
    `${RM} .git`,
    'mv .git x',
    `${RM} ./.agents`,
    `${RM} ".agents/"`,
    `${RM} 'C:\\repo\\.agents'`,
    `cd .git && ${RM} ticket-loop`,
  ]) {
    assert.ok(denied(cmd), `should deny mid-run: ${cmd}`);
  }
  for (const cmd of ['ls .agents', 'ls -la .git', 'echo x >> .gitignore', `${RM} .github/workflows/old.yml`, 'git status', 'cd .git && ls']) {
    assert.ok(!denied(cmd), `should allow mid-run: ${cmd}`);
  }
  assert.ok(!deniedIdle(`${RM} .agents`), 'outside a run an unrelated repo may remove its own .agents');
});

// --- 2. the sanctioned exemption ---

test('a sanctioned call is node running a harness script first, by exact name, with no node flags', () => {
  for (const cmd of [
    `node -e "require('fs').writeFileSync('${RUN}/done.md','x')" ledger.js`,
    `node evil.js ledger.js status ${RUN}`,
    `node my-ledger.js close ${RUN}`,
    `node -r ./evil.js scripts/ledger.js status ${RUN}`,
    `node --require x scripts/ledger.js status ${RUN}`,
    `node --import x scripts/ledger.js status ${RUN}`,
    `node scripts/ledger.js approval ${RUN} --question q --choice 1 --channel telegram --sender me --nonce n`,
    `node scripts/ledger.js returned ${RUN} --agent a1`,
    `node scripts/ledger.js dispatch ${RUN} "qa: C1" --source hook`,
    `node scripts/ledger.js dispatch ${RUN} "qa: C1" --source=hook`,
  ]) {
    assert.ok(denied(cmd), `should deny: ${cmd}`);
    assert.ok(deniedIdle(cmd), `should deny with no run active too: ${cmd}`);
  }
  for (const cmd of [
    `node scripts/notify.js ask "clear lib/auth/**?" --option yes --option no --run ${RUN}`,
    `node scripts/ledger.js dispatch ${RUN} "qa: C1"`,
    `node.exe scripts/ledger.js status ${RUN}`,
  ]) {
    assert.ok(!denied(cmd), `should allow: ${cmd}`);
  }
});

test('with the harness directories given, only the installed script itself is sanctioned', () => {
  const cwd = path.dirname(SCRIPTS_DIR);
  const opts = { harnessDirs: [SCRIPTS_DIR], cwd };
  const call = (script) => `node "${script}" close ${RUN}`;
  assert.ok(policy.isSanctioned(call(path.join(SCRIPTS_DIR, 'ledger.js')), opts));
  assert.ok(policy.isSanctioned(`node ${path.join('scripts', 'ledger.js')} status ${RUN}`, opts), 'relative to the cwd');
  assert.ok(!policy.isSanctioned(call(path.join(SCRIPTS_DIR, '..', '..', 'evil', 'ledger.js')), opts));
  assert.ok(!policy.isSanctioned(call('../../evil/ledger.js'), opts));
  assert.ok(!policy.isSanctioned(call(path.join(cwd, 'ledger.js')), opts), 'the right name in the wrong directory');
  assert.ok(policy.isSanctioned(call('../../evil/ledger.js'), { cwd }), 'without directories the name alone decides');
  if (process.platform === 'win32') {
    assert.ok(policy.isSanctioned(call(path.join(SCRIPTS_DIR, 'ledger.js').toUpperCase()), opts), 'case-insensitive on Windows');
    const msys = path.join(SCRIPTS_DIR, 'ledger.js').replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
    assert.ok(policy.isSanctioned(call(msys), opts), 'Git Bash spells the drive /c/');
  }
});

// --- 3. names the filesystem resolves differently from how they are spelled ---

test('a stream suffix, trailing dots or spaces, and dot segments do not disguise a frozen path', () => {
  for (const p of [
    `${RUN}/done.md::$DATA`,
    `${RUN}/done.md:$DATA`,
    `${RUN}/done.md.`,
    `${RUN}/done.md `,
    `${RUN}/done.md. . `,
    `${RUN}/./done.md`,
    '.agents/ticket-runs/other/../T-1/budget.json',
    '.agents/ticket-runs./T-1/closed.json',
    'docs/spec.approved.md::$DATA',
    '.git/ticket-loop/T-1/key::$DATA',
    'C:\\repo\\.git\\ticket-loop\\T-1\\chain.jsonl.',
  ]) {
    assert.ok(deniedPath(p, false), `should deny: ${JSON.stringify(p)}`);
  }
  assert.ok(deniedPath('.agents/ticket-loop.config.json::$DATA', true));
  assert.ok(!deniedPath(`${RUN}/done-additions.md::$DATA`), 'a writable artifact stays writable');
  const risk = { runActive: true, riskPaths: ['lib/auth/**'] };
  assert.ok(policy.riskVerdict('lib/auth/login.js::$DATA', risk));
  assert.ok(policy.riskVerdict('lib/x/../auth/login.js', risk));
  assert.ok(policy.riskVerdict('lib/auth./login.js', risk));
});

test('path normalisation keeps the drive and resolves dot segments', () => {
  assert.strictEqual(policy.normalisePath('C:\\Repo\\a\\..\\b\\f.md::$DATA'), 'c:/repo/b/f.md');
  assert.strictEqual(policy.normalisePath('../x/./y.'), '../x/y');
  assert.strictEqual(policy.normalisePath('/a/../../b'), '/b');
  assert.strictEqual(policy.normalisePath('a/b/../../../c'), '../c');
});

// --- 5. globs and escapes that spell the namespace without naming it ---

test('a bracket glob or a backslash escape does not hide the run directory', () => {
  for (const cmd of [
    `rm .agents/[t]icket-runs/T-1/done.md`,
    `rm .agents/ticket\\-runs/T-1/done.md`,
    `rm .agents/ticket-r\\uns/T-1/done.md`,
    `rm .agents/ticket-run{s,x}/T-1/done.md`,
    `rm [.]agents/ticket-runs/T-1/done.md`,
    `rm .agent[s]/ticket-run[s]/T-1/done.md`,
    `rm .ag*/tick*/T-1/done.md`,
    `${RM} .??ents`,
    `${RM} .agents/ti[c]ket-runs`,
  ]) {
    assert.ok(denied(cmd), `should deny mid-run: ${cmd}`);
    assert.ok(deniedIdle(cmd), `should deny with no run active: ${cmd}`);
  }
  assert.ok(denied('Remove-Item C:\\repo\\.agents\\ticket-runs\\T-1\\done.md'), 'Windows separators still match');
  for (const cmd of ['rm -f .eslintcache*', 'rm build/*.tmp', `rm src/t*.js`, 'ls .agents/[t]icket-runs', 'rm -f .*.swp']) {
    assert.ok(!denied(cmd), `should allow: ${cmd}`);
  }
});

test('a frozen file name behind a wildcard or a variable is refused mid-run', () => {
  for (const cmd of ['rm $R/budget.json', 'rm */*/T-1/done.md', `rm "$RUN"/closed.json`, 'Remove-Item $d/clearances.json']) {
    assert.ok(denied(cmd), `should deny mid-run: ${cmd}`);
  }
  assert.ok(!denied('echo x > docs/done.md'), 'a literal path outside the run dir is not a reference');
  assert.ok(!denied('cat $R/done.md'), 'reading stays allowed');
});

// --- 6. risk paths through the shell ---

test('a shell write to an uncleared risk path is refused like the Edit of it', () => {
  const opts = { riskPaths: ['lib/auth/**', '**/migrations/**'], cleared: [] };
  for (const cmd of [
    'echo x > lib/auth/login.js',
    'sed -i s/a/b/ lib/auth/login.js',
    'cp patched.js "lib/auth/login.js"',
    'cd lib/auth && sed -i s/a/b/ login.js',
    `${RM} lib`,
    'npm run fmt && echo x >> db/migrations/003.sql',
    'Set-Content -Path lib\\auth\\login.js -Value x',
  ]) {
    assert.ok(denied(cmd, opts), `should deny: ${cmd}`);
  }
  for (const cmd of ['cat lib/auth/login.js', 'grep -n token lib/auth/login.js', 'echo x > lib/profile/a.js', 'git diff -- lib/auth', 'cd lib && npm test']) {
    assert.ok(!denied(cmd, opts), `should allow: ${cmd}`);
  }
  assert.ok(!denied('echo x > lib/auth/login.js', { ...opts, cleared: ['lib/auth/**'] }), 'a recorded clearance opens it');
  assert.ok(!policy.commandVerdict('echo x > lib/auth/login.js', { runActive: false, ...opts }), 'no fence outside a run');
});

test('globMatches agrees with the risk glob language', () => {
  const cases = [
    ['lib/auth/**', 'lib/auth/a/b.js', true],
    ['lib/auth/**', 'C:/wt/lib/auth/b.js', true],
    ['lib/auth/**', 'lib/authx/b.js', false],
    ['**/migrations/**', 'db/migrations/1.sql', true],
    ['**/migrations/**', 'migrations/1.sql', true],
    ['*.yaml', 'pubspec.yaml', true],
    ['*.yaml', 'a/b.yaml', true],
    ['lib/*.js', 'lib/a/b.js', false],
    ['lib/?.js', 'lib/a.js', true],
    ['pubspec.yaml', 'xpubspec.yaml', false],
  ];
  for (const [glob, p, want] of cases) assert.strictEqual(policy.globMatches(glob, p), want, `${glob} vs ${p}`);
});

// --- 7. the plugin's own tree ---

test('every file of the installed plugin is control plane mid-run, and a repo\'s own hooks are not', () => {
  const CACHE = 'C:/Users/me/.claude/plugins/cache/ticket-loop-harness/ticket-loop/0.31.1';
  for (const p of [
    'plugins/ticket-loop/hooks/subagent_return.js',
    'plugins/ticket-loop/hooks/notify_hook.js',
    'plugins/ticket-loop/hooks/read_hint.js',
    'plugins/ticket-loop/hooks/session_start.js',
    'plugins/ticket-loop/hooks/hygiene.js',
    'plugins/ticket-loop/hooks/post_edit.js',
    'plugins/ticket-loop/skills/ticket-loop/scripts/policy.js',
    'plugins/ticket-loop/skills/ticket-loop/scripts/notify.js',
    'plugins/ticket-loop/skills/ticket-loop/scripts/publish.js',
    'plugins/ticket-loop/skills/ticket-loop/scripts/attest.js',
    'plugins/ticket-loop/skills/ticket-loop/prompts/qa.md',
    'plugins/ticket-loop/skills/ticket-loop/SKILL.md',
    'plugins/ticket-loop/agents/ticket-loop-qa.md',
    'plugins/ticket-loop/.claude-plugin/plugin.json',
    `${CACHE}/hooks/freeze_guard.js`,
    `${CACHE}/agents/ticket-loop-qa.md`,
    `${CACHE}/skills/ticket-loop/scripts/ledger.js`,
    '.claude/hooks/notify_hook.js',
    '.claude/skills/ticket-loop/scripts/ledger.js',
    '.claude/agents/ticket-loop-qa.md',
    '.claude/skills/ticket-loop/SKILL.md',
    '.claude/skills/ticket-loop/prompts/qa.md',
    'C:/Users/me/.claude/ticket-loop/policy.json',
    'C:/Users/me/.claude/ticket-loop/org.json',
  ]) {
    assert.ok(deniedPath(p, true), `should deny mid-run: ${p}`);
    assert.ok(!deniedPath(p, false), `must stay writable when idle: ${p}`);
  }
  for (const p of ['src/hooks/useThing.js', 'scripts/init.js', 'lib/agents/x.js', 'app/skills/a.md', 'ticket-loop-notes/hooks.md']) {
    assert.ok(!deniedPath(p, true), `a repo's own file must stay writable: ${p}`);
  }
  assert.ok(denied('sed -i s/a/b/ plugins/ticket-loop/hooks/notify_hook.js'));
  assert.ok(denied(`sed -i s/a/b/ ${CACHE}/skills/ticket-loop/prompts/qa.md`));
  assert.ok(denied('echo {} > ~/.claude/ticket-loop/policy.json'));
  assert.ok(!denied('sed -i s/a/b/ src/hooks/useThing.js'));
  assert.ok(!deniedIdle('sed -i s/a/b/ plugins/ticket-loop/hooks/notify_hook.js'), 'the harness stays developable');
});

// --- 8. the chain's lock and keys ---

test('the chain append lock is frozen', () => {
  assert.ok(deniedPath('.git/ticket-loop/T-1/lock', false));
  assert.ok(deniedPath('.ticket-loop-chain/T-1/lock', true));
  assert.ok(!deniedPath('lib/lock', true));
});

test('the chain key and the signing key are refused to every command, reads included', () => {
  for (const cmd of [
    'cat .git/ticket-loop/T-1/key',
    'type .git\\ticket-loop\\T-1\\key',
    'Get-Content .ticket-loop-chain/T-1/key',
    'cp .git/ticket-loop/T-1/key /tmp/k',
    'cat ~/.claude/ticket-loop/signing/ed25519.pem',
    'cat .git/ticket-loop/T-1/*',
    'cat .git/ticket-loop/T-1/k?y',
    'cd .git/ticket-loop/T-1 && cat key',
    'cd .git && cat ticket-loop/T-1/key',
    'ls .git/ticket-loop/T-1',
    `node scripts/ledger.js gate ${RUN} qa --evidence .git/ticket-loop/T-1/key`,
  ]) {
    assert.ok(denied(cmd), `should deny mid-run: ${cmd}`);
    assert.ok(deniedIdle(cmd), `should deny after the run too: ${cmd}`);
  }
  assert.ok(!denied('cat .git/ticket-loop/T-1/chain.jsonl'), 'the record itself may be read');
  assert.ok(!denied('cat ~/.claude/ticket-loop/signing/ed25519.pem.pub'), 'the public key is for sharing');
  assert.ok(denied('cat ~/.claude/ticket-loop/signing/*.pub'), 'a glob there can still expand to the private key');
  assert.ok(!denied(`node scripts/ledger.js verify ${RUN}`));
});

test('a Read of a key is refused on the path alone', () => {
  for (const p of ['.git/ticket-loop/T-1/key', 'C:\\repo\\.git\\ticket-loop\\T-1\\key::$DATA', '.ticket-loop-chain/T-1/key', '/home/me/.claude/ticket-loop/signing/ed25519.pem']) {
    assert.ok(policy.secretPathVerdict(p), `should deny: ${p}`);
  }
  for (const p of ['.git/ticket-loop/T-1/chain.jsonl', `${RUN}/done.md`, 'src/key', 'keys/key', '/home/me/.claude/ticket-loop/signing/ed25519.pem.pub']) {
    assert.strictEqual(policy.secretPathVerdict(p), null, `should allow: ${p}`);
  }
  for (const d of ['.git/ticket-loop', '.git', '.git/ticket-loop/T-1', '/home/me/.claude/ticket-loop']) {
    assert.ok(policy.secretPathVerdict(d, { directory: true }), `a search rooted at ${d} reads the key`);
  }
  assert.strictEqual(policy.secretPathVerdict('src', { directory: true }), null);
});

// --- 9. history rewrite by another name ---

test('moving a ref by another name than rebase is refused mid-run', () => {
  const rewrites = [
    'git reset --soft HEAD~1',
    'git reset --keep main',
    'git reset --merge',
    'git reset HEAD~2',
    'git reset HEAD^',
    'git reset abc1234def',
    'git -C ../wt reset --soft HEAD^',
    'git update-ref refs/heads/ticket/T-1 abc1234',
    'git filter-branch --tree-filter x HEAD',
    'git filter-repo --path x',
    'git replace abc1234 def5678',
    'git branch -D ticket/T-1',
    'git branch -d ticket/T-1',
    'git branch --delete ticket/T-1',
    'git branch -f ticket/T-1 abc1234',
    'git branch --force ticket/T-1 HEAD~3',
    'git branch -m ticket/T-1 old',
    'git branch -M ticket/T-1 old',
    'git checkout -B ticket/T-1 abc1234',
    'git switch -C ticket/T-1',
  ];
  for (const cmd of rewrites) {
    assert.ok(denied(cmd), `should deny mid-run: ${cmd}`);
    assert.ok(!deniedIdle(cmd), `should allow with no run active: ${cmd}`);
  }
  for (const cmd of [
    'git reset HEAD lib/a.js',
    'git reset -- lib/a.js',
    'git reset',
    'git merge-base HEAD main',
    'git branch --list',
    'git branch -a',
    'git checkout -b ticket/T-2',
    'git commit -m "note: git branch -D is refused"',
  ]) {
    assert.ok(!denied(cmd), `should allow mid-run: ${cmd}`);
  }
});
