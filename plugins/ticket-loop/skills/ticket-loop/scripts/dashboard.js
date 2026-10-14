#!/usr/bin/env node
// A read-only view of every ticket run in one or more repos, built from the sealed chains through
// ledger.js's own readers. It writes nothing but the page, and records nothing.
//
// usage: dashboard.js [repo...] [--out <file.html>] [--json] [--serve [port]] [--refresh <seconds>]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const RUNS_REL = path.join('.agents', 'ticket-runs');
const ARCHIVE = /^(.+)\._old_(\d+)$/;
const COLLECT_TIMEOUT_MS = 30000;
const DEFAULT_REFRESH_S = 5;
const TIMELINE_LIMIT = 300;

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

// --- discovery ------------------------------------------------------------------------------

function chainLib() {
  return require(path.join(__dirname, 'chain.js'));
}

// Runs as the repo holds them: live dirs, archives, and chains whose run dir is gone. A dir with
// no chain on this machine is listed, never read through the ledger: a repo can commit one.
function discover(root) {
  const chain = chainLib();
  const runsDir = path.join(root, RUNS_REL);
  let names = [];
  try {
    names = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    names = [];
  }
  const runs = [];
  const seen = new Set();
  for (const name of names) {
    const m = name.match(ARCHIVE);
    const ticket = m ? m[1] : name;
    const runDir = path.join(runsDir, ticket);
    if (m) {
      if (names.includes(ticket)) continue;
      seen.add(ticket);
      runs.push({ ticket, runDir, dirOnDisk: path.join(runsDir, name), state: chain.exists(runDir) ? 'archived' : 'no chain' });
      continue;
    }
    seen.add(ticket);
    runs.push({ ticket, runDir, dirOnDisk: runDir, state: chain.exists(runDir) ? 'live' : 'no chain' });
  }
  const probe = chain.resolveChainDir(path.join(runsDir, 'probe'));
  if (probe.inGit) {
    let tickets = [];
    try {
      tickets = fs.readdirSync(path.dirname(probe.dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      tickets = [];
    }
    for (const ticket of tickets) {
      if (seen.has(ticket)) continue;
      runs.push({ ticket, runDir: path.join(runsDir, ticket), dirOnDisk: null, state: 'run dir gone' });
    }
  }
  return runs;
}

// --- collection (child process per run: a ledger reader may exit on a refused policy) ---------

function summarize(r) {
  const p = r.payload || {};
  switch (r.kind) {
    case 'dispatch': return `${p.label || ''}${p.model ? ` [${p.model}]` : ''}${p.source ? ` (${p.source})` : ''}`;
    case 'outcome': return `seq ${p.dispatchSeq}: ${p.outcome || ''}${Number.isInteger(p.tokens) ? `, ${p.tokens} tokens` : ''}`;
    case 'check': return `${p.id} ${p.result} by ${p.by}${Number.isInteger(p.exitCode) ? ` (exit ${p.exitCode})` : ''}`;
    case 'verdict': return `${p.verdict}${p.dispatchSeq ? ` (judge seq ${p.dispatchSeq})` : ''}`;
    case 'gate': return p.stage || '';
    case 'clear': return `${p.glob || ''}: ${p.reason || ''}`;
    case 'approval': return `choice ${p.choice} via ${p.channel}${p.forgeable ? ' (forgeable)' : ''}`;
    case 'raise': return `+${p.tokens} tokens: ${p.reason || ''}`;
    case 'consent': return ['push', 'pr', 'ticket'].map((k) => `${k} ${p[k]}`).join(', ');
    case 'close': return `verdict ${p.verdict || 'none'}`;
    case 'init': return `base ${String(p.baseSha || '').slice(0, 12)}`;
    default: return '';
  }
}

function collectOne(runDir, state) {
  const ledger = require(path.join(__dirname, 'ledger.js'));
  const chain = chainLib();
  const v = chain.verify(runDir);
  const records = v.records || [];
  const outcomes = new Map(records.filter((r) => r.kind === 'outcome').map((r) => [r.payload.dispatchSeq, r.payload]));
  const dispatches = ledger.dispatchPairs(runDir).map((d) => {
    const o = d.seqs.map((s) => outcomes.get(s)).find(Boolean) || null;
    return {
      seq: d.seqs[0],
      label: d.label,
      model: d.model || null,
      promptChars: d.promptChars,
      outcome: o ? o.outcome : null,
      tokens: o && Number.isInteger(o.tokens) ? o.tokens : null,
      ms: o && Number.isInteger(o.ms) ? o.ms : null,
    };
  });
  const live = state === 'live';
  const integrity = live ? ledger.integrityReport(runDir) : null;
  return {
    state: live ? (ledger.isClosed(runDir) ? 'closed' : 'open') : state,
    chainIntact: v.ok,
    integrity: integrity ? { intact: integrity.intact, problems: integrity.problems, revisions: integrity.revisions.length } : null,
    counters: v.ok ? ledger.counters(runDir) : null,
    completeness: v.ok ? ledger.completeness(runDir) : null,
    tokens: v.ok ? ledger.tokenStats(runDir) : null,
    dispatches,
    firstAt: records.length ? records[0].at : null,
    lastAt: records.length ? records[records.length - 1].at : null,
    timeline: records.slice(-TIMELINE_LIMIT).map((r) => ({ seq: r.seq, at: r.at, kind: r.kind, what: summarize(r) })),
  };
}

function collectRun(root, run) {
  const base = { ticket: run.ticket, runDir: run.runDir, state: run.state };
  if (run.state === 'no chain') return base;
  const res = spawnSync(process.execPath, [__filename, '--collect', run.runDir, run.state], {
    cwd: root,
    encoding: 'utf8',
    timeout: COLLECT_TIMEOUT_MS,
  });
  if (res.status !== 0) {
    const why = (res.stderr || '').trim().split('\n')[0] || (res.error && res.error.message) || `exit ${res.status}`;
    return { ...base, error: why };
  }
  try {
    const data = JSON.parse(res.stdout);
    if (data.state === 'archived' || data.state === 'run dir gone') data.state = orphanState(data, run.state);
    return { ...base, ...data };
  } catch (e) {
    return { ...base, error: `unreadable collector output (${e.message})` };
  }
}

// A chain whose run dir is gone is orphaned when it promised a close record and has none.
function orphanState(data, state) {
  if (state === 'archived') return 'archived';
  const kinds = data.timeline.map((t) => t.kind);
  if (kinds.includes('close')) return 'closed';
  const init = data.timeline.find((t) => t.kind === 'init');
  return init ? 'orphaned' : 'run dir gone';
}

function collect(repos) {
  return {
    generatedAt: new Date().toISOString(),
    host: os.hostname(),
    repos: repos.map((repo) => {
      const root = findRoot(repo);
      return { root, name: path.basename(root), runs: discover(root).map((run) => collectRun(root, run)) };
    }),
  };
}

// --- rendering ------------------------------------------------------------------------------

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const num = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const when = (iso) => (iso ? esc(iso.replace('T', ' ').slice(0, 16)) : '—');

function minutes(ms) {
  if (!Number.isFinite(ms)) return '—';
  const m = Math.round(ms / 60000);
  return m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`;
}

function stateBadge(run) {
  const tone = { open: 'info', closed: 'muted', orphaned: 'bad', archived: 'muted', 'no chain': 'warn', 'run dir gone': 'warn' }[run.state] || 'muted';
  return `<span class="badge ${tone}">${esc(run.state)}</span>`;
}

function integrityBadge(run) {
  if (run.error) return '<span class="badge bad">unreadable</span>';
  if (run.integrity) return run.integrity.intact ? '<span class="badge good">intact</span>' : '<span class="badge bad">TAMPERED</span>';
  if (run.chainIntact === false) return '<span class="badge bad">chain broken</span>';
  return '<span class="badge muted">—</span>';
}

function passBadge(run) {
  const c = run.completeness;
  if (!c) return '<span class="badge muted">—</span>';
  return c.passed ? '<span class="badge good">passed</span>' : '<span class="badge warn">not passed</span>';
}

function criteriaCell(c) {
  if (!c || !c.criteria.length) return '—';
  const counts = {};
  for (const x of c.criteria) counts[x.result] = (counts[x.result] || 0) + 1;
  return ['PASS', 'FAIL', 'SKIPPED', 'unchecked']
    .filter((k) => counts[k])
    .map((k) => `<span class="pill ${k.toLowerCase()}">${counts[k]} ${esc(k.toLowerCase())}</span>`)
    .join(' ');
}

function meter(used, max) {
  if (!Number.isFinite(used)) return '—';
  if (!Number.isFinite(max) || max <= 0) return num(used);
  const pct = Math.min(100, Math.round((used / max) * 100));
  const tone = pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'good';
  return `<div class="meter" title="${pct}%"><span class="${tone}" style="width:${pct}%"></span></div><small>${num(used)} / ${num(max)}</small>`;
}

function runRow(run, i) {
  const c = run.counters || {};
  return `<tr>
<td><a href="#run-${i}">${esc(run.ticket)}</a></td>
<td>${stateBadge(run)}</td>
<td>${integrityBadge(run)}</td>
<td>${passBadge(run)}</td>
<td>${esc((run.completeness && run.completeness.verdict) || '—')}${c.blockVerdicts ? ` <small>(${c.blockVerdicts} BLOCK)</small>` : ''}</td>
<td>${criteriaCell(run.completeness)}</td>
<td>${meter(c.dispatches, c.maxDispatches)}${c.stalled ? ` <span class="badge bad">${c.stalled} stalled</span>` : ''}</td>
<td>${meter(c.tokensUsed, c.maxRunTokens)}</td>
<td>${when(run.lastAt)}</td>
</tr>`;
}

function roleBars(tokens) {
  const roles = Object.entries((tokens && tokens.byRole) || {});
  if (!roles.length) return '<p class="muted">No dispatches.</p>';
  const max = Math.max(1, ...roles.map(([, r]) => r.tokens));
  return `<div class="bars">${roles
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([role, r]) => `<div class="bar"><span class="label">${esc(role)}</span><span class="track"><span style="width:${Math.round((r.tokens / max) * 100)}%"></span></span><span class="value">${num(r.tokens)} <small>(${r.measured}/${r.dispatches} measured)</small></span></div>`)
    .join('')}</div>`;
}

function runDetail(run, i) {
  const problems = run.error ? [run.error] : (run.integrity && run.integrity.problems) || [];
  const crit = run.completeness ? run.completeness.criteria : [];
  const open = (run.counters && run.counters.open) || [];
  return `<section class="card" id="run-${i}">
<h2>${esc(run.ticket)} ${stateBadge(run)} ${integrityBadge(run)} ${passBadge(run)}</h2>
<p class="muted">${esc(run.runDir)} · started ${when(run.firstAt)} · last activity ${when(run.lastAt)}</p>
${problems.length ? `<div class="problems"><strong>Problems</strong><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
${open.length ? `<div class="problems warnbox"><strong>Dispatches still out</strong><ul>${open.map((o) => `<li>seq ${esc(o.seqs[0])} ${esc(o.label || '')} — ${o.stalled ? `STALLED, quiet ${esc(o.minutesQuiet)} min` : `${esc(o.minutesOpen)} min`}</li>`).join('')}</ul></div>` : ''}
<div class="grid2">
<div><h3>Criteria</h3>${crit.length ? `<table><tr><th>ID</th><th>Result</th><th>How</th></tr>${crit.map((c) => `<tr><td>${esc(c.id)}</td><td><span class="pill ${esc(String(c.result).toLowerCase())}">${esc(c.result)}</span></td><td>${esc(c.by || '—')}</td></tr>`).join('')}</table>` : '<p class="muted">No frozen contract.</p>'}</div>
<div><h3>Tokens by role</h3>${roleBars(run.tokens)}${run.tokens ? `<p class="muted">counted ${num(run.tokens.counted)} · reported ${num(run.tokens.total)} · prompt floor ${num(run.tokens.floor)}</p>` : ''}</div>
</div>
<h3>Dispatches</h3>
${run.dispatches && run.dispatches.length ? `<table><tr><th>Seq</th><th>Agent</th><th>Model</th><th>Prompt</th><th>Outcome</th><th>Tokens</th><th>Time</th></tr>${run.dispatches.map((d) => `<tr><td>${esc(d.seq)}</td><td>${esc(d.label)}</td><td>${esc(d.model || 'session')}</td><td>${num(d.promptChars)}</td><td>${esc(d.outcome || 'open')}</td><td>${num(d.tokens)}</td><td>${minutes(d.ms)}</td></tr>`).join('')}</table>` : '<p class="muted">None.</p>'}
<details><summary>Receipt timeline (${(run.timeline || []).length} records)</summary>
<table class="timeline"><tr><th>Seq</th><th>At</th><th>Kind</th><th>What</th></tr>${(run.timeline || []).map((t) => `<tr><td>${esc(t.seq)}</td><td>${when(t.at)}</td><td>${esc(t.kind)}</td><td>${esc(t.what)}</td></tr>`).join('')}</table>
</details>
</section>`;
}

function tiles(runs) {
  const count = (f) => runs.filter(f).length;
  const tokens = runs.reduce((n, r) => n + ((r.tokens && r.tokens.counted) || 0), 0);
  const dispatches = runs.reduce((n, r) => n + ((r.counters && r.counters.dispatches) || 0), 0);
  const items = [
    ['Runs', runs.length, ''],
    ['Open', count((r) => r.state === 'open'), 'info'],
    ['Passed', count((r) => r.completeness && r.completeness.passed), 'good'],
    ['Tampered or unreadable', count((r) => r.error || (r.integrity && !r.integrity.intact)), 'bad'],
    ['Orphaned', count((r) => r.state === 'orphaned'), 'bad'],
    ['Stalled agents', runs.reduce((n, r) => n + ((r.counters && r.counters.stalled) || 0), 0), 'warn'],
    ['Dispatches', dispatches, ''],
    ['Tokens counted', tokens, ''],
  ];
  return `<div class="tiles">${items.map(([k, v, tone]) => `<div class="tile ${tone}"><div class="v">${num(v)}</div><div class="k">${esc(k)}</div></div>`).join('')}</div>`;
}

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--good:#2f7d4f;--warn:#a86a0b;--bad:#b3261e;--info:#2b5fb3}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ecebe6;--muted:#9b9a93;--line:#33322e;--good:#5fbf86;--warn:#e0a640;--bad:#ef6b62;--info:#78a6f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 6px}h3{font-size:14px;margin:16px 0 6px}
.muted{color:var(--muted)}small{color:var(--muted)}a{color:var(--info)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.tile .v{font-size:24px;font-weight:600}.tile .k{color:var(--muted);font-size:12px}
.tile.good .v{color:var(--good)}.tile.warn .v{color:var(--warn)}.tile.bad .v{color:var(--bad)}.tile.info .v{color:var(--info)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px}
.badge,.pill{display:inline-block;white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:12px;border:1px solid currentColor}
.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.info{color:var(--info)}.badge.muted{color:var(--muted)}
.pill.pass{color:var(--good)}.pill.fail{color:var(--bad)}.pill.skipped{color:var(--warn)}.pill.unchecked{color:var(--muted)}
.meter{width:110px;height:6px;background:var(--line);border-radius:3px;overflow:hidden}.meter span{display:block;height:100%}
.meter .good{background:var(--good)}.meter .warn{background:var(--warn)}.meter .bad{background:var(--bad)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media (max-width:760px){.grid2{grid-template-columns:1fr}}
.bars .bar{display:grid;grid-template-columns:120px 1fr auto;gap:8px;align-items:center;margin:4px 0}.bars .track{height:8px;background:var(--line);border-radius:4px;overflow:hidden}.bars .track span{display:block;height:100%;background:var(--info)}
.problems{border-left:3px solid var(--bad);padding:4px 12px;margin:10px 0}.problems.warnbox{border-color:var(--warn)}
details summary{cursor:pointer;margin-top:12px;color:var(--muted)}.timeline td{font-size:12px}`;

function render(data, refreshS) {
  const sections = data.repos
    .map((repo) => {
      const rows = repo.runs.map((r, i) => runRow(r, `${repo.name}-${i}`)).join('');
      const details = repo.runs.map((r, i) => runDetail(r, `${repo.name}-${i}`)).join('');
      return `<h2 style="margin-top:28px">${esc(repo.name)} <small>${esc(repo.root)}</small></h2>
${tiles(repo.runs)}
<div class="card"><table><tr><th>Ticket</th><th>State</th><th>Integrity</th><th>Outcome</th><th>Verdict</th><th>Criteria</th><th>Dispatches</th><th>Tokens</th><th>Last activity</th></tr>${rows || '<tr><td colspan="9" class="muted">No runs.</td></tr>'}</table></div>
${details}`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refreshS ? `<meta http-equiv="refresh" content="${Number(refreshS)}">` : ''}<title>Ticket Loop Runs</title><style>${STYLE}</style></head>
<body><main><h1>Ticket loop runs</h1><p class="muted">Read from the sealed receipt chains on ${esc(data.host)} at ${when(data.generatedAt)}${refreshS ? ` · refreshes every ${Number(refreshS)} s` : ''}. Integrity says the record was not altered; outcome says whether the run passed.</p>
${sections}</main></body></html>`;
}

// --- cli ------------------------------------------------------------------------------------

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return { present: false };
  const next = argv[i + 1];
  const value = next && !next.startsWith('--') ? next : null;
  argv.splice(i, value === null ? 1 : 2);
  return { present: true, value };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--collect') {
    process.stdout.write(JSON.stringify(collectOne(argv[1], argv[2])));
    return;
  }
  const out = flag(argv, '--out');
  const json = flag(argv, '--json');
  const serve = flag(argv, '--serve');
  const refresh = flag(argv, '--refresh');
  const repos = argv.length ? argv : [process.cwd()];
  const refreshS = Number(refresh.value) > 0 ? Number(refresh.value) : DEFAULT_REFRESH_S;

  if (json.present) {
    process.stdout.write(JSON.stringify(collect(repos), null, 2) + '\n');
    return;
  }
  if (serve.present) {
    const server = http.createServer((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      if (req.url !== '/' && !req.url.startsWith('/?')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(render(collect(repos), refreshS));
    });
    server.listen(Number(serve.value) || 0, '127.0.0.1', () => {
      console.log(`ticket-loop dashboard: http://127.0.0.1:${server.address().port}/`);
    });
    return;
  }
  const file = out.value || path.join(os.tmpdir(), `ticket-loop-dashboard-${path.basename(findRoot(repos[0]))}.html`);
  fs.writeFileSync(file, render(collect(repos), 0));
  console.log(`ticket-loop dashboard written: ${file}`);
}

if (require.main === module) main();
module.exports = { collect, render, esc, discover };
