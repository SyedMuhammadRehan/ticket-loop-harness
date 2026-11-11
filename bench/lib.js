'use strict';
// Shared by the bench's generator, scorer and tests.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BENCH = __dirname;
const APP = path.join(BENCH, 'app');
const TICKETS = path.join(BENCH, 'tickets');
const ORACLE = path.join(BENCH, 'oracle');

const PROFILE = {
  stack: 'node',
  ticketSource: 'manual',
  designSource: 'none',
  verify: { analyze: 'npm run lint', test: 'npm test', pubGet: null, codegen: null },
  riskPaths: ['src/auth/**', 'package.json'],
  worktreePrefix: '../depot-ticket-',
  memoryFile: null,
  deps: { dir: 'node_modules', lockfile: null },
  attribution: { commitTrailer: null },
  hooks: { stopGate: { extensions: ['.js'], mode: 'full', worktrees: 'all', baseRef: 'main', timeoutMs: 300000 } },
};
const GITIGNORE = '.agents/ticket-runs/\n.claude/hooks/state/\nnode_modules/\n';

const ticketIds = () => fs.readdirSync(TICKETS).filter((f) => /^T\d+\.md$/.test(f)).map((f) => f.replace('.md', '')).sort();
const oracleIds = () => fs.readdirSync(ORACLE).filter((f) => /^T\d+\.test\.js$/.test(f)).map((f) => f.replace('.test.js', '')).sort();
const expected = () => JSON.parse(fs.readFileSync(path.join(BENCH, 'expected.json'), 'utf8'));

function git(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, '-c', 'user.name=depot bench', '-c', 'user.email=bench@localhost', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (res.error) throw new Error(`git is not available (${res.error.message})`);
  if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${(res.stderr || '').trim()}`);
  return res.stdout.trim();
}

// The repo the agent under test works in: the app, its tickets and a profile. The oracle, the
// solutions and the expected behaviour stay behind in this directory.
function makeRepo(dest) {
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) throw new Error(`${dest} already exists and is not empty`);
  fs.cpSync(APP, dest, { recursive: true });
  fs.cpSync(TICKETS, path.join(dest, 'tickets'), { recursive: true });
  fs.mkdirSync(path.join(dest, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.agents', 'ticket-loop.config.json'), JSON.stringify(PROFILE, null, 2) + '\n');
  fs.writeFileSync(path.join(dest, '.gitignore'), GITIGNORE);
  git(dest, ['init', '-q', '-b', 'main']);
  git(dest, ['add', '-A']);
  git(dest, ['commit', '-q', '-m', 'chore: depot, as the bench found it']);
  return dest;
}

function applySolution(dir, ticket) {
  const edits = require('./solutions.js')[ticket];
  if (!edits) throw new Error(`no reference solution for ${ticket}`);
  for (const { file, find, replace } of edits) {
    const full = path.join(dir, file);
    const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    if (!text.includes(find)) throw new Error(`${ticket}: the text to replace is not in ${file}`);
    fs.writeFileSync(full, text.replace(find, () => replace));
  }
}

// Node's test runner marks its children through this variable, and a `node --test` started
// under it runs nothing and exits 0.
function freshEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function run(args, cwd, env = {}) {
  const res = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: freshEnv(env), timeout: 300000 });
  const count = (label) => Number((new RegExp(`^[ℹ#] ${label} (\\d+)`, 'm').exec(res.stdout || '') || [])[1] ?? NaN);
  return { ok: res.status === 0, pass: count('pass'), fail: count('fail'), out: `${res.stdout || ''}${res.stderr || ''}` };
}

// The hidden tests for one ticket, run against a checkout. They load the checkout's modules by
// path, so nothing has to be copied into it.
const runOracle = (ticket, checkout) => run(['--test', path.join(ORACLE, `${ticket}.test.js`)], BENCH, { DEPOT_ROOT: path.resolve(checkout) });
const runSuite = (checkout) => run(['--test'], checkout);
const runLint = (checkout) => run([path.join('scripts', 'lint.js')], checkout);

module.exports = { BENCH, makeRepo, applySolution, runOracle, runSuite, runLint, ticketIds, oracleIds, expected, git };
