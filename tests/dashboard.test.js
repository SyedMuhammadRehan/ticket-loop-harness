'use strict';
// The dashboard is a read-only view over the sealed chain: everything it shows must come from the
// ledger's own readers, and every string a run recorded must reach the page as text, never markup.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SCRIPTS_DIR, mkRun, rmDir, runScript, ledger, settleDispatches, RUNNABLE_CONFIG, freezeRun, judge } = require('./helpers.js');
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

const DASHBOARD = path.join(SCRIPTS_DIR, 'dashboard.js');
const HOSTILE_LABEL = 'general-purpose: <script>alert(1)</script>';

function ok(root, args) {
  const res = ledger(root, args);
  assert.strictEqual(res.status, 0, `ledger ${args[0]} failed: ${res.stderr}`);
  return res;
}

// A run that went the whole way: frozen, one implementer, both criteria checked by command, judged.
function finishedRun() {
  const { root, runDir } = mkRun(RUNNABLE_CONFIG);
  ok(root, ['init', runDir, 'abc']);
  freezeRun(root, runDir);
  ok(root, ['dispatch', runDir, HOSTILE_LABEL, '--source', 'hook', '--prompt-chars', '4000', '--model', 'sonnet']);
  const open = JSON.parse(ok(root, ['status', runDir]).stdout).open;
  ok(root, ['outcome', runDir, String(open[0].seqs[0]), 'ok', '--tokens', '12345', '--ms', '60000']);
  for (const id of ['C1', 'C2']) ok(root, ['check', runDir, id, 'PASS', '--by', 'command', '--cwd', root]);
  assert.strictEqual(judge(root, runDir, 'APPROVE').status, 0);
  settleDispatches(root, runDir);
  return { root, runDir };
}

function collect(root) {
  const res = runScript(DASHBOARD, [root, '--json'], { cwd: root });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('the dashboard reports a run from its sealed chain: verdict, criteria, tokens and dispatches', () => {
  const { root } = finishedRun();
  try {
    const [run] = collect(root).repos[0].runs;
    assert.strictEqual(run.ticket, 'T-1');
    assert.strictEqual(run.state, 'open');
    assert.strictEqual(run.integrity.intact, true, JSON.stringify(run.integrity.problems));
    assert.strictEqual(run.completeness.verdict, 'APPROVE');
    assert.strictEqual(run.completeness.passed, true);
    assert.deepStrictEqual(run.completeness.criteria.map((c) => `${c.id}:${c.result}:${c.by}`), ['C1:PASS:command', 'C2:PASS:command']);
    assert.ok(run.tokens.counted >= 12345, `tokens counted: ${JSON.stringify(run.tokens)}`);
    const implementer = run.dispatches.find((d) => d.label === HOSTILE_LABEL);
    assert.ok(implementer, 'the implementer dispatch is listed with its label');
    assert.strictEqual(implementer.tokens, 12345);
    assert.strictEqual(implementer.model, 'sonnet');
    assert.strictEqual(implementer.outcome, 'ok');
  } finally {
    rmDir(root);
  }
});

test('a recorded string reaches the page as text, never as markup', () => {
  const { root } = finishedRun();
  const out = path.join(root, 'dash.html');
  try {
    const res = runScript(DASHBOARD, [root, '--out', out], { cwd: root });
    assert.strictEqual(res.status, 0, res.stderr);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the label is shown, escaped');
    assert.ok(!html.includes('<script>alert(1)'), 'the label is never live markup');
    assert.ok(html.includes('T-1') && html.includes('APPROVE'));
  } finally {
    rmDir(root);
  }
});

test('archived, orphaned and chainless runs are each shown for what they are', () => {
  const { root, runDir } = mkRun(RUNNABLE_CONFIG);
  try {
    ok(root, ['init', runDir, 'abc']);
    fs.renameSync(runDir, `${runDir}._old_1`);

    const orphan = path.join(root, '.agents', 'ticket-runs', 'T-2');
    fs.mkdirSync(orphan, { recursive: true });
    chain.create(orphan);
    chain.append(orphan, 'init', { baseSha: 'abc', maxDispatches: 25, maxReplans: 3, evidence: [], closesInChain: true });
    rmDir(orphan);

    const committed = path.join(root, '.agents', 'ticket-runs', 'T-3');
    fs.mkdirSync(committed, { recursive: true });
    fs.writeFileSync(path.join(committed, 'budget.json'), '{}');

    const states = Object.fromEntries(collect(root).repos[0].runs.map((r) => [r.ticket, r.state]));
    assert.deepStrictEqual(states, { 'T-1': 'archived', 'T-2': 'orphaned', 'T-3': 'no chain' });
  } finally {
    rmDir(root);
  }
});

test('a run the collector cannot read is reported, and the rest of the page still renders', () => {
  const { root, runDir } = finishedRun();
  try {
    fs.writeFileSync(chain.chainPath(runDir), 'not json\n');
    const [run] = collect(root).repos[0].runs;
    assert.strictEqual(run.ticket, 'T-1');
    assert.ok(run.error || (run.integrity && run.integrity.intact === false), JSON.stringify(run));
  } finally {
    rmDir(root);
  }
});

test('--serve answers on loopback only and refreshes itself', async () => {
  const { root } = finishedRun();
  const child = spawn(process.execPath, [DASHBOARD, root, '--serve', '0'], { cwd: root });
  try {
    const url = await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (m) resolve(m[0]);
      });
      child.on('exit', (code) => reject(new Error(`dashboard exited ${code}`)));
      setTimeout(() => reject(new Error('no URL printed')), 15000);
    });
    const body = await new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, b }));
      }).on('error', reject);
    });
    assert.strictEqual(body.status, 200);
    assert.ok(body.b.includes('http-equiv="refresh"'), 'the served page refreshes itself');
    assert.ok(body.b.includes('T-1'));
  } finally {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    });
    rmDir(root);
  }
});
