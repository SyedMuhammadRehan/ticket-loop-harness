'use strict';
// The invariant under test: a person can be reached on every channel they set up, one failing
// channel never silences the rest, an answer counts only when it carries the question's code
// and comes from the right chat, an answer the agent could have forged never backs a clearance,
// and a session that stalls mid-run says so on its own. A local server stands in for every
// service, so nothing here leaves the machine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SCRIPTS_DIR, HOOKS_DIR, mkRun, mkTmpDir, rmDir, ledger } = require('./helpers.js');
const notify = require(path.join(SCRIPTS_DIR, 'notify.js'));
const chain = require(path.join(SCRIPTS_DIR, 'chain.js'));

const CHAT = '4242';

// One server playing ntfy, Telegram, WhatsApp, Slack, Discord and a generic webhook.
async function fakeServices(t) {
  const seen = [];
  const state = { updates: [], ntfyReplies: [], replyFor: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (code, value) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url.startsWith('/fail')) return json(500, {});
      if (req.url === '/slackapi/chat.postMessage') {
        state.nonce = (/Reply "(\w+) <number>"/.exec(JSON.parse(body).text) || [])[1];
        return json(200, { ok: true, ts: '100.1' });
      }
      if (req.url.startsWith('/slackapi/conversations.')) {
        return json(200, { ok: true, messages: state.slack ? state.slack(state.nonce) : [] });
      }
      if (req.method === 'POST' && req.url === '/discordapi/channels/C1/messages') {
        state.nonce = (/Reply "(\w+) <number>"/.exec(JSON.parse(body).content) || [])[1];
        return json(200, { id: '500' });
      }
      if (req.method === 'GET' && req.url.startsWith('/discordapi/channels/C1/messages?after=500')) {
        return json(200, state.discord ? state.discord(state.nonce) : []);
      }
      if (/\/sendMessage$/.test(req.url)) {
        const text = JSON.parse(body).text;
        const nonce = (/Reply "(\w+) <number>"/.exec(text) || [])[1];
        if (nonce && state.replyFor) state.updates.push(state.replyFor(nonce));
        return json(200, { ok: true });
      }
      if (/\/getUpdates/.test(req.url)) {
        const offset = Number((/offset=(\d+)/.exec(req.url) || [])[1] || 0);
        return json(200, { ok: true, result: state.updates.filter((u) => u.update_id >= offset) });
      }
      if (req.method === 'GET' && /\/json\?poll=1/.test(req.url)) {
        res.writeHead(200);
        return res.end(state.ntfyReplies.map((m) => JSON.stringify({ message: m })).join('\n'));
      }
      if (req.method === 'POST' && req.url.startsWith('/ntfy/') && req.headers.actions && state.ntfyAnswer) {
        const nonce = (/body=(\w+) 1/.exec(req.headers.actions) || [])[1];
        state.ntfyReplies.push(`${nonce} ${state.ntfyAnswer}`);
      }
      return json(200, { ok: true });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, state };
}

function channelsFor(base) {
  return [
    { type: 'ntfy', server: `${base}/ntfy`, topic: 'secret-topic', email: 'me@example.com' },
    { type: 'telegram', apiBase: base, token: 'TOKEN123', chatId: CHAT },
    { type: 'whatsapp', apiBase: `${base}/wa`, token: 'WATOKEN', phoneNumberId: '99', to: '923001234567' },
    { type: 'slack', webhookUrl: `${base}/slack` },
    { type: 'discord', webhookUrl: `${base}/discord` },
    { type: 'webhook', url: `${base}/hook`, headers: { 'x-team': 'a' } },
  ];
}

function writeConfig(t, channels) {
  const dir = mkTmpDir('tl-notify');
  t.after(() => rmDir(dir));
  const file = path.join(dir, 'notify.json');
  fs.writeFileSync(file, JSON.stringify({ channels }));
  return file;
}

function runAsync(script, args, { cwd, env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('a message reaches every channel, each in its own shape, and one failure silences none', async (t) => {
  const { base, seen } = await fakeServices(t);
  const channels = [...channelsFor(base), { type: 'slack', webhookUrl: `${base}/fail` }];
  const r = await notify.send('run T-1 is stuck on GATE C', { config: { channels } });
  assert.strictEqual(r.sent, 6, JSON.stringify(r));
  assert.deepStrictEqual(r.results.filter((x) => !x.ok).map((x) => x.type), ['slack']);
  const by = (u) => seen.find((s) => s.url.startsWith(u));
  assert.strictEqual(by('/ntfy/secret-topic').body, 'run T-1 is stuck on GATE C');
  assert.strictEqual(by('/ntfy/secret-topic').headers.email, 'me@example.com');
  assert.deepStrictEqual(JSON.parse(by('/botTOKEN123/sendMessage').body), { chat_id: CHAT, text: 'run T-1 is stuck on GATE C' });
  const wa = by('/wa/99/messages');
  assert.strictEqual(wa.headers.authorization, 'Bearer WATOKEN');
  assert.strictEqual(JSON.parse(wa.body).text.body, 'run T-1 is stuck on GATE C');
  assert.strictEqual(JSON.parse(by('/slack').body).text, 'run T-1 is stuck on GATE C');
  assert.strictEqual(JSON.parse(by('/discord').body).content, 'run T-1 is stuck on GATE C');
  assert.strictEqual(by('/hook').headers['x-team'], 'a');
});

test('an answer counts only with the code of its question and from the configured chat', async (t) => {
  const { base, state } = await fakeServices(t);
  state.updates.push({ update_id: 5, message: { chat: { id: CHAT }, from: { id: 1 }, text: 'old message 1' } });
  state.replyFor = (nonce) => {
    // Someone else in another chat answers first, with the right code; only the configured chat counts.
    state.updates.push({ update_id: 7, message: { chat: { id: '999' }, from: { id: 2 }, text: `${nonce} 1` } });
    return { update_id: 8, message: { chat: { id: CHAT }, from: { id: 77 }, text: `${nonce} 2` } };
  };
  const channels = [{ type: 'telegram', apiBase: base, token: 'TOKEN123', chatId: CHAT }];
  const r = await notify.ask('Clear pubspec.yaml?', ['yes, clear it', 'no, park the run'], { config: { channels }, timeoutMin: 0.05, pollMs: 50 });
  assert.strictEqual(r.answered, true, JSON.stringify(r));
  assert.strictEqual(r.choice, 2);
  assert.strictEqual(r.choiceText, 'no, park the run');
  assert.strictEqual(r.channel, 'telegram');
  assert.strictEqual(r.sender, '77');
  assert.strictEqual(r.sealable, true);
  assert.strictEqual(notify.parseAnswer('ABC123 2', 'ABC123', 2), 2);
  assert.strictEqual(notify.parseAnswer('2', 'ABC123', 2), null, 'a bare number is not an answer');
  assert.strictEqual(notify.parseAnswer('ABC123 9', 'ABC123', 2), null, 'out of range is not an answer');
});

test('an ntfy button answers, but as a reply the agent could have forged', async (t) => {
  const { base, state } = await fakeServices(t);
  state.ntfyAnswer = '1';
  const r = await notify.ask('Continue?', ['yes', 'no'], { config: { channels: [{ type: 'ntfy', server: `${base}/ntfy`, topic: 't1' }] }, timeoutMin: 0.05, pollMs: 50 });
  assert.strictEqual(r.answered, true, JSON.stringify(r));
  assert.strictEqual(r.channel, 'ntfy');
  assert.strictEqual(r.sealable, false);
});

test('no answer before the deadline is no answer, never a yes', async (t) => {
  const { base } = await fakeServices(t);
  const r = await notify.ask('Continue?', ['yes', 'no'], { config: { channels: [{ type: 'telegram', apiBase: base, token: 'T', chatId: CHAT }] }, timeoutMin: 0.01, pollMs: 50 });
  assert.strictEqual(r.answered, false);
});

test('an answer is sealed into the run, and only an unforgeable one naming the glob backs a clearance', async (t) => {
  const { base, state } = await fakeServices(t);
  state.replyFor = (nonce) => ({ update_id: 1, message: { chat: { id: CHAT }, from: { id: 77 }, text: `${nonce} 1` } });
  const file = writeConfig(t, [{ type: 'telegram', apiBase: base, token: 'TOKEN123', chatId: CHAT }]);
  const { root, runDir } = mkRun({ verify: { test: 'x' }, riskPaths: ['pubspec.yaml', 'lib/auth/**'] });
  t.after(() => rmDir(root));
  assert.strictEqual(ledger(root, ['init', runDir, 'abc']).status, 0);
  const asked = await runAsync(path.join(SCRIPTS_DIR, 'notify.js'), ['ask', 'Clear pubspec.yaml for the dependency bump?', '--option', 'yes', '--option', 'no', '--timeout-min', '0.1', '--run', runDir], { cwd: root, env: { TICKET_LOOP_NOTIFY: file } });
  assert.strictEqual(asked.status, 0, asked.stderr + asked.stdout);
  assert.strictEqual(JSON.parse(asked.stdout).sealed, true);
  const approval = chain.last(runDir, 'approval');
  assert.strictEqual(approval.payload.channel, 'telegram');
  assert.strictEqual(approval.payload.forgeable, false);

  const wrongGlob = ledger(root, ['clear', runDir, 'lib/auth/**', 'from the phone', '--approval', String(approval.seq)]);
  assert.strictEqual(wrongGlob.status, 1, 'the approval asked about pubspec.yaml, not lib/auth');
  const ok = ledger(root, ['clear', runDir, 'pubspec.yaml', 'approved from the phone', '--approval', String(approval.seq)]);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(chain.last(runDir, 'clearance').payload.approvedVia, 'telegram');

  assert.strictEqual(ledger(root, ['approval', runDir, '--question', 'Clear lib/auth/**?', '--choice', '1', '--channel', 'ntfy', '--sender', 't', '--nonce', 'X1', '--forgeable']).status, 0);
  const forged = chain.last(runDir, 'approval');
  const refused = ledger(root, ['clear', runDir, 'lib/auth/**', 'from ntfy', '--approval', String(forged.seq)]);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /could have posted on/);
});

test('a session that stalls on a permission prompt mid-run messages the person, once, and never outside a run', async (t) => {
  const { base, seen } = await fakeServices(t);
  const file = writeConfig(t, [{ type: 'webhook', url: `${base}/hook` }]);
  const { root, runDir } = mkRun({ verify: { test: 'x' } });
  t.after(() => rmDir(root));
  const hook = path.join(HOOKS_DIR, 'notify_hook.js');
  const fire = (event) => runAsync(hook, [], { cwd: root, env: { TICKET_LOOP_NOTIFY: file }, input: JSON.stringify({ cwd: root, ...event }) });
  const prompt = { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs permission to run flutter test' };

  assert.strictEqual((await fire(prompt)).status, 0);
  assert.strictEqual(seen.length, 0, 'outside a run nothing is sent');

  fs.writeFileSync(path.join(runDir, 'budget.json'), '{}');
  assert.strictEqual((await fire(prompt)).status, 0);
  assert.strictEqual(seen.length, 1);
  assert.match(JSON.parse(seen[0].body).text, /T-1 .* is waiting for a permission: Claude needs permission to run flutter test/);
  await fire(prompt);
  assert.strictEqual(seen.length, 1, 'the same prompt is not repeated within minutes');

  await fire({ hook_event_name: 'Stop' });
  await fire({ hook_event_name: 'Stop' });
  assert.strictEqual(seen.length, 2, 'a run whose turns keep ending is reported once per quiet spell');
  assert.match(JSON.parse(seen[1].body).text, /the session stopped and the run is still open/);
});

test('a broken config is an error, a missing one sends nothing, and preflight names channels but never tokens', async (t) => {
  const bad = writeConfig(t, [{ type: 'telegram', token: 'SECRET-TOKEN' }, { type: 'pigeon' }]);
  process.env.TICKET_LOOP_NOTIFY = bad;
  t.after(() => delete process.env.TICKET_LOOP_NOTIFY);
  const cfg = notify.readConfig();
  assert.match(cfg.error, /chatId is missing/);
  assert.match(cfg.error, /unknown type "pigeon"/);
  assert.strictEqual((await notify.send('x')).sent, 0);
  process.env.TICKET_LOOP_NOTIFY = path.join(mkTmpDir('tl-none'), 'none.json');
  assert.match((await notify.send('x')).note, /nothing was sent/);

  const { root } = mkRun({ verify: { test: 'x' } });
  t.after(() => rmDir(root));
  const out = await runAsync(path.join(SCRIPTS_DIR, 'load_config.js'), [], { cwd: root, env: { TICKET_LOOP_NOTIFY: bad, TICKET_LOOP_POLICY: path.join(root, 'none.json') } });
  assert.ok(!out.stdout.includes('SECRET-TOKEN'), 'a token never reaches the preflight output');
  assert.deepStrictEqual(JSON.parse(out.stdout)._meta.notify.channels, ['telegram', 'pigeon']);
});

// Where Telegram is blocked, a Slack or Discord bot carries the answer instead, with the same
// guarantee: a bot cannot post as the person, so only their own message counts and can be sealed.
test('a Slack bot answer counts only from the configured person, never from a bot, and can be sealed', async (t) => {
  const { base, state } = await fakeServices(t);
  state.slack = (nonce) => [
    { ts: '100.1', bot_id: 'B1', text: `Reply "${nonce} <number>"` },
    { ts: '100.2', bot_id: 'B1', text: `${nonce} 1` },
    { ts: '100.3', user: 'U999', text: `${nonce} 1` },
    { ts: '100.4', user: 'U0456', text: `${nonce} 2` },
  ];
  const channels = [{ type: 'slack', apiBase: `${base}/slackapi`, botToken: 'xoxb-1', channel: 'C0123', userId: 'U0456' }];
  const r = await notify.ask('Clear pubspec.yaml?', ['yes', 'no'], { config: { channels }, timeoutMin: 0.05, pollMs: 50 });
  assert.strictEqual(r.answered, true, JSON.stringify(r));
  assert.strictEqual(r.choice, 2);
  assert.strictEqual(r.sender, 'U0456');
  assert.strictEqual(r.sealable, true);
});

test('a Discord bot answer counts only from the configured person, and without a userId it cannot be sealed', async (t) => {
  const { base, state } = await fakeServices(t);
  state.discord = (nonce) => [
    { id: '501', author: { id: '9', bot: true }, content: `${nonce} 1` },
    { id: '502', author: { id: '777' }, content: `${nonce} 2` },
  ];
  const pinned = [{ type: 'discord', apiBase: `${base}/discordapi`, botToken: 'D', channelId: 'C1', userId: '777' }];
  const r = await notify.ask('Continue?', ['yes', 'no'], { config: { channels: pinned }, timeoutMin: 0.05, pollMs: 50 });
  assert.strictEqual(r.answered, true, JSON.stringify(r));
  assert.strictEqual(r.sender, '777');
  assert.strictEqual(r.sealable, true);

  const open = [{ type: 'discord', apiBase: `${base}/discordapi`, botToken: 'D', channelId: 'C1' }];
  const anyone = await notify.ask('Continue?', ['yes', 'no'], { config: { channels: open }, timeoutMin: 0.05, pollMs: 50 });
  assert.strictEqual(anyone.answered, true);
  assert.strictEqual(anyone.choice, 2, 'the bot that posted first is never the one answering');
  assert.strictEqual(anyone.sealable, false, 'an answer from whoever is in the channel is not the person who started the run');
});

test('without a configured Slack user a bot message is still never an answer', async (t) => {
  const { base, state } = await fakeServices(t);
  state.slack = (nonce) => [
    { ts: '100.2', bot_id: 'B1', text: `${nonce} 1` },
    { ts: '100.3', subtype: 'bot_message', text: `${nonce} 1` },
    { ts: '100.4', user: 'U999', text: `${nonce} 2` },
  ];
  const channels = [{ type: 'slack', apiBase: `${base}/slackapi`, botToken: 'xoxb-1', channel: 'C0123' }];
  const r = await notify.ask('Continue?', ['yes', 'no'], { config: { channels }, timeoutMin: 0.05, pollMs: 50 });
  assert.strictEqual(r.answered, true, JSON.stringify(r));
  assert.strictEqual(r.choice, 2);
  assert.strictEqual(r.sealable, false);
});
