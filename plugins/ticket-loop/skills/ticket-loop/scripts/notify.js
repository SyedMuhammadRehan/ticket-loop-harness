#!/usr/bin/env node
// Reach the person who started the run, wherever they are, on whatever their country lets
// through. Every message goes to every channel they configured, so one blocked or failing
// channel never leaves them unreachable. Replies come back on the channels our code can poll
// without a server of its own: Telegram, Slack and Discord bots, and ntfy.
//
// Channels live in a user-level file, never in the repo, because they hold tokens:
// ~/.claude/ticket-loop/notify.json, or wherever TICKET_LOOP_NOTIFY points.
//
//   { "channels": [
//       { "type": "ntfy", "topic": "my-secret-topic", "server": "https://ntfy.sh", "email": "me@x.com" },
//       { "type": "telegram", "token": "<bot token>", "chatId": "<your chat id>" },
//       { "type": "whatsapp", "token": "<cloud api token>", "phoneNumberId": "<id>", "to": "<your number>" },
//       { "type": "slack", "webhookUrl": "https://hooks.slack.com/..." },              // send only
//       { "type": "slack", "botToken": "xoxb-...", "channel": "C0123", "userId": "U0456" },
//       { "type": "discord", "webhookUrl": "https://discord.com/api/webhooks/..." },   // send only
//       { "type": "discord", "botToken": "...", "channelId": "123", "userId": "456" },
//       { "type": "webhook", "url": "https://...", "headers": { } }      // Teams, Google Chat, Mattermost
//   ] }
//
// usage: notify.js send "<message>"
//        notify.js ask "<question>" --option "<a>" --option "<b>" [--timeout-min 30] [--run <runDir>]
//        notify.js test
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ENV_NOTIFY = 'TICKET_LOOP_NOTIFY';
const SEND_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 5000;
const DEFAULT_ASK_MINUTES = 30;
const MAX_TEXT = 3500;
// A reply on a bot channel cannot have been written by the agent itself: it holds the bot token,
// but a bot cannot post as the person it talks to, and its own messages are marked as a bot's.
// An ntfy topic accepts posts from anyone who knows it, the agent included, so an ntfy answer is
// a notification reply, never a sealed approval.
const UNFORGEABLE = ['telegram', 'slack', 'discord'];

function canReply(c) {
  return c.type === 'telegram' || c.type === 'ntfy' || ((c.type === 'slack' || c.type === 'discord') && !!c.botToken);
}

function configPath() {
  return process.env[ENV_NOTIFY] || path.join(os.homedir(), '.claude', 'ticket-loop', 'notify.json');
}

// null when there is no file; { error } when it cannot be used.
function readConfig() {
  const file = configPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `${file} is not valid JSON (${err.message})`, path: file };
  }
  const problems = [];
  const channels = Array.isArray(parsed.channels) ? parsed.channels : [];
  if (!channels.length) problems.push('no channels listed');
  channels.forEach((c, i) => {
    const need = {
      ntfy: ['topic'],
      telegram: ['token', 'chatId'],
      whatsapp: ['token', 'phoneNumberId', 'to'],
      slack: c && c.botToken ? ['botToken', 'channel'] : ['webhookUrl'],
      discord: c && c.botToken ? ['botToken', 'channelId'] : ['webhookUrl'],
      webhook: ['url'],
    }[c && c.type];
    if (!need) problems.push(`channel ${i + 1}: unknown type "${c && c.type}"`);
    else for (const k of need) if (!c[k]) problems.push(`channel ${i + 1} (${c.type}): ${k} is missing`);
  });
  return problems.length ? { error: problems.join('; '), path: file, channels } : { channels, path: file };
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const slackBase = (c) => (c.apiBase || 'https://slack.com/api').replace(/\/+$/, '');
const discordBase = (c) => (c.apiBase || 'https://discord.com/api/v10').replace(/\/+$/, '');

function ntfyBase(c) {
  return (c.server || 'https://ntfy.sh').replace(/\/+$/, '');
}

// Buttons answer on a reply topic, so the person taps instead of typing.
async function sendOne(c, text, ask) {
  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
  switch (c.type) {
    case 'ntfy': {
      const headers = { 'content-type': 'text/plain', Title: 'ticket-loop' };
      if (c.email) headers.Email = c.email;
      if (ask) {
        const reply = `${ntfyBase(c)}/${c.replyTopic || `${c.topic}-reply`}`;
        headers.Actions = ask.options
          .slice(0, 3)
          .map((o, i) => `http, ${o.replace(/[,;]/g, ' ')}, ${reply}, method=POST, body=${ask.nonce} ${i + 1}, clear=true`)
          .join('; ');
      }
      return post(`${ntfyBase(c)}/${c.topic}`, clipped, headers);
    }
    case 'telegram':
      return post(`${(c.apiBase || 'https://api.telegram.org').replace(/\/+$/, '')}/bot${c.token}/sendMessage`, { chat_id: c.chatId, text: clipped });
    case 'whatsapp':
      return post(
        `${(c.apiBase || 'https://graph.facebook.com/v20.0').replace(/\/+$/, '')}/${c.phoneNumberId}/messages`,
        c.template
          ? { messaging_product: 'whatsapp', to: c.to, type: 'template', template: { name: c.template, language: { code: c.language || 'en' } } }
          : { messaging_product: 'whatsapp', to: c.to, type: 'text', text: { body: clipped } },
        { authorization: `Bearer ${c.token}` }
      );
    case 'slack': {
      if (!c.botToken) return post(c.webhookUrl, { text: clipped });
      // Slack reports a refused post as HTTP 200 with ok:false.
      const body = await (await post(`${slackBase(c)}/chat.postMessage`, { channel: c.channel, text: clipped }, { authorization: `Bearer ${c.botToken}` })).json();
      if (!body.ok) throw new Error(`slack: ${body.error || 'not ok'}`);
      return { ts: body.ts };
    }
    case 'discord': {
      if (!c.botToken) return post(c.webhookUrl, { content: clipped.slice(0, 1900) });
      const body = await (await post(`${discordBase(c)}/channels/${c.channelId}/messages`, { content: clipped.slice(0, 1900) }, { authorization: `Bot ${c.botToken}` })).json();
      return { id: body.id };
    }
    case 'webhook':
      return post(c.url, { text: clipped }, c.headers || {});
    default:
      throw new Error(`unknown channel type ${c.type}`);
  }
}

// Every channel, in parallel; a failure on one is reported, never thrown.
async function send(text, opts = {}) {
  const cfg = opts.config || readConfig();
  if (!cfg) return { sent: 0, results: [], note: 'no notify config; nothing was sent' };
  if (cfg.error) return { sent: 0, results: [], error: cfg.error };
  const results = await Promise.all(
    cfg.channels.map(async (c) => {
      try {
        const sent = await sendOne(c, text, opts.ask);
        return { type: c.type, ok: true, meta: sent && (sent.ts || sent.id) ? sent : null };
      } catch (err) {
        return { type: c.type, ok: false, error: err.message };
      }
    })
  );
  return { sent: results.filter((r) => r.ok).length, results };
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// The answer must carry the question's code, so a stale or unrelated message never counts.
function parseAnswer(text, nonce, count) {
  const m = new RegExp(`\\b${nonce}\\b\\s*[:#-]?\\s*(\\d+)`, 'i').exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= count ? n : null;
}

async function pollTelegram(c, state, nonce, count) {
  const base = `${(c.apiBase || 'https://api.telegram.org').replace(/\/+$/, '')}/bot${c.token}`;
  const body = JSON.parse(await getJson(`${base}/getUpdates?timeout=0${state.offset ? `&offset=${state.offset}` : ''}`));
  for (const u of body.result || []) {
    state.offset = u.update_id + 1;
    const msg = u.message || {};
    if (String((msg.chat || {}).id) !== String(c.chatId)) continue;
    const choice = parseAnswer(msg.text, nonce, count);
    if (choice) return { choice, channel: 'telegram', sender: String((msg.from || {}).id || msg.chat.id) };
  }
  return null;
}

// A person's message, never a bot's: Slack marks a bot's with bot_id or a subtype. With userId
// set, only that person counts; without it, an answer is accepted but cannot be sealed.
async function pollSlack(c, meta, nonce, count) {
  if (!meta || !meta.ts) return null;
  const headers = { authorization: `Bearer ${c.botToken}` };
  const seen = [];
  for (const url of [
    `${slackBase(c)}/conversations.replies?channel=${encodeURIComponent(c.channel)}&ts=${meta.ts}`,
    `${slackBase(c)}/conversations.history?channel=${encodeURIComponent(c.channel)}&oldest=${meta.ts}`,
  ]) {
    const body = JSON.parse(await getJson(url, headers));
    if (body.ok) seen.push(...(body.messages || []));
  }
  for (const m of seen) {
    if (m.bot_id || m.subtype || !m.user || m.ts === meta.ts) continue;
    if (c.userId && m.user !== c.userId) continue;
    const choice = parseAnswer(m.text, nonce, count);
    if (choice) return { choice, channel: 'slack', sender: m.user, sealable: !!c.userId };
  }
  return null;
}

async function pollDiscord(c, meta, nonce, count) {
  if (!meta || !meta.id) return null;
  const list = JSON.parse(await getJson(`${discordBase(c)}/channels/${c.channelId}/messages?after=${meta.id}&limit=50`, { authorization: `Bot ${c.botToken}` }));
  for (const m of Array.isArray(list) ? list : []) {
    const author = m.author || {};
    if (author.bot) continue;
    if (c.userId && String(author.id) !== String(c.userId)) continue;
    const choice = parseAnswer(m.content, nonce, count);
    if (choice) return { choice, channel: 'discord', sender: String(author.id), sealable: !!c.userId };
  }
  return null;
}

async function pollNtfy(c, since, nonce, count) {
  const topic = c.replyTopic || `${c.topic}-reply`;
  const text = await getJson(`${ntfyBase(c)}/${topic}/json?poll=1&since=${since}`);
  for (const line of text.split('\n').filter(Boolean)) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const choice = parseAnswer(m.message, nonce, count);
    if (choice) return { choice, channel: 'ntfy', sender: topic };
  }
  return null;
}

async function ask(question, options, opts = {}) {
  const cfg = opts.config || readConfig();
  if (!cfg || cfg.error) return { error: cfg ? cfg.error : 'no notify config; nobody can be asked' };
  const listeners = cfg.channels.filter(canReply);
  if (!listeners.length) return { error: 'no channel that can carry a reply is configured (ntfy, or a Telegram, Slack or Discord bot)' };
  const nonce = crypto.randomBytes(3).toString('hex').toUpperCase();
  const lines = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const text = `${question}\n\n${lines}\n\nReply "${nonce} <number>". No reply in ${opts.timeoutMin || DEFAULT_ASK_MINUTES} min means none of these.`;
  const startedSec = Math.floor(Date.now() / 1000) - 5;
  const telegramState = new Map();
  for (const c of listeners) {
    if (c.type !== 'telegram') continue;
    const state = {};
    try {
      await pollTelegram(c, state, '------', 0);
    } catch {
      // Unreachable now; polling below retries and reports nothing until it answers.
    }
    telegramState.set(c, state);
  }
  const delivery = await send(text, { config: cfg, ask: { nonce, options } });
  const posted = new Map(cfg.channels.map((c, i) => [c, delivery.results[i] && delivery.results[i].meta]));
  const deadline = Date.now() + (opts.timeoutMin || DEFAULT_ASK_MINUTES) * 60000;
  const interval = opts.pollMs || POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    for (const c of listeners) {
      try {
        const hit =
          c.type === 'telegram' ? await pollTelegram(c, telegramState.get(c), nonce, options.length) :
          c.type === 'slack' ? await pollSlack(c, posted.get(c), nonce, options.length) :
          c.type === 'discord' ? await pollDiscord(c, posted.get(c), nonce, options.length) :
          await pollNtfy(c, startedSec, nonce, options.length);
        if (hit) {
          const sealable = UNFORGEABLE.includes(hit.channel) && hit.sealable !== false;
          return { answered: true, nonce, question, options, ...hit, choiceText: options[hit.choice - 1], sealable, at: new Date().toISOString(), delivery };
        }
      } catch {
        // A poll that fails is retried until the deadline; the person may still answer elsewhere.
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return { answered: false, nonce, question, options, delivery };
}

function flags(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[++i]);
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'send' && rest[0]) {
    const r = await send(rest[0]);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.error ? 1 : 0);
  }
  if (cmd === 'test') {
    const r = await send(`ticket-loop: test message from ${os.hostname()}. If you can read this, this channel will reach you.`);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.error || r.sent < (r.results || []).length ? 1 : 0);
  }
  if (cmd === 'ask' && rest[0]) {
    const options = flags(rest, '--option');
    if (options.length < 2) {
      console.error('notify ask: give at least two --option values');
      process.exit(1);
    }
    const timeoutMin = Number(flags(rest, '--timeout-min')[0]) || DEFAULT_ASK_MINUTES;
    const r = await ask(rest[0], options, { timeoutMin });
    const runDir = flags(rest, '--run')[0];
    if (runDir && r.answered) {
      const sealed = spawnSync(
        process.execPath,
        [path.join(__dirname, 'ledger.js'), 'approval', runDir, '--question', r.question, '--choice', String(r.choice), '--choice-text', r.choiceText,
          '--channel', r.channel, '--sender', r.sender, '--nonce', r.nonce, ...(r.sealable ? [] : ['--forgeable'])],
        { encoding: 'utf8', timeout: 15000 }
      );
      r.sealed = sealed.status === 0;
      if (!r.sealed) r.sealError = (sealed.stderr || '').trim();
    }
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.error ? 1 : r.answered ? 0 : 3);
  }
  console.error('usage: notify.js send "<message>" | test | ask "<question>" --option <a> --option <b> [--timeout-min n] [--run <runDir>]');
  process.exit(1);
}

if (require.main === module) main();
module.exports = { readConfig, send, ask, parseAnswer, configPath, ENV_NOTIFY, UNFORGEABLE };
