#!/usr/bin/env node
// The two profile choices that belong to the person, not to detection: which model each role
// runs on, and what a finished run may publish. Setup asks; this writes the answers. It touches
// only those keys, never while a run is open, and never past what the org policy allows.
//
// usage: choose.js --show
//        choose.js [--model <role>=<model>]... [--publish none|push|push,pr|push,pr,ticket]
//   roles:  survey, implementer, fixer, qa      models: inherit, haiku, sonnet, opus, fable
'use strict';
const fs = require('fs');
const path = require('path');
const policy = require('./policy.js');
const { withoutBom } = require('./load_config.js');

const PROFILE_REL = path.join('.agents', 'ticket-loop.config.json');
const ROLES = ['survey', 'implementer', 'fixer', 'qa'];
// 'inherit' is the session's own model; the rest are the tiers the Agent tool accepts by name.
const MODELS = ['inherit', 'haiku', 'sonnet', 'opus', 'fable'];
const ACTS = ['push', 'pr', 'ticket'];

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function openRun(root) {
  const runs = path.join(root, '.agents', 'ticket-runs');
  try {
    return fs
      .readdirSync(runs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.includes('._old_'))
      .find((e) => fs.existsSync(path.join(runs, e.name, 'budget.json')) && !fs.existsSync(path.join(runs, e.name, 'closed.json')));
  } catch {
    return null;
  }
}

function current(profile) {
  const models = Object.fromEntries(ROLES.map((role) => [role, (profile.models && profile.models[role]) || 'inherit']));
  const allowed = profile.publish && Array.isArray(profile.publish.allowed) ? profile.publish.allowed : [];
  return { models, publish: ACTS.filter((a) => allowed.includes(a)) };
}

// What the org policy leaves open, so a person is offered only what they can have.
function limits() {
  const loaded = policy.readPolicy();
  if (!loaded || loaded.error) return { policy: loaded && loaded.error ? loaded.error : null, models: null, publish: null };
  const models = Object.fromEntries(ROLES.map((role) => [role, policy.allowedFor(loaded.policy, role)]).filter(([, list]) => list));
  const publish = loaded.policy.publish && Array.isArray(loaded.policy.publish.allowed) ? loaded.policy.publish.allowed : null;
  return { policy: loaded.path, models: Object.keys(models).length ? models : null, publish };
}

// Returns { changes } or { error }. Nothing is written here.
function parse(args) {
  const changes = { models: {}, publish: null };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === '--model') {
      const [role, model] = String(value || '').split('=');
      if (!ROLES.includes(role)) return { error: `"${role}" is not a role; the roles are ${ROLES.join(', ')}` };
      if (!MODELS.includes(model)) return { error: `"${model}" is not a model this can set; choose from ${MODELS.join(', ')}` };
      changes.models[role] = model;
      i++;
    } else if (args[i] === '--publish') {
      const acts = value === 'none' ? [] : String(value || '').split(',').filter(Boolean);
      const unknown = acts.filter((a) => !ACTS.includes(a));
      if (value === undefined || unknown.length) return { error: `--publish takes none, or a list of ${ACTS.join(', ')}` };
      if (acts.includes('pr') && !acts.includes('push')) return { error: 'a pull request needs the branch pushed: allow "push" as well as "pr"' };
      changes.publish = ACTS.filter((a) => acts.includes(a));
      i++;
    } else {
      return { error: `unknown argument ${args[i]}` };
    }
  }
  if (!Object.keys(changes.models).length && changes.publish === null) return { error: 'nothing to change: give --model or --publish, or --show' };
  return { changes };
}

function apply(profile, changes) {
  const next = { ...profile };
  if (Object.keys(changes.models).length) next.models = { ...(profile.models || {}), ...changes.models };
  if (changes.publish !== null) next.publish = { ...(profile.publish || {}), allowed: changes.publish };
  return next;
}

function fail(message, code = 1) {
  console.error(`choose: ${message}`);
  process.exit(code);
}

function main() {
  const args = process.argv.slice(2);
  const root = findRoot(process.cwd());
  if (!root) fail('not inside a git repository');
  const file = path.join(root, PROFILE_REL);
  if (!fs.existsSync(file)) fail(`there is no profile at ${file} yet; write one with init.js first`);
  let profile;
  try {
    profile = JSON.parse(withoutBom(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    fail(`the profile could not be read (${err.message})`);
  }

  if (args.length === 1 && args[0] === '--show') {
    process.stdout.write(JSON.stringify({ ...current(profile), roles: ROLES, modelChoices: MODELS, publishChoices: ACTS, orgPolicy: limits() }, null, 2) + '\n');
    return;
  }

  const parsed = parse(args);
  if (parsed.error) fail(parsed.error, 2);
  const run = openRun(root);
  if (run) fail(`ticket run ${run.name} is open, and the profile is frozen while a run is active`);

  const next = apply(profile, parsed.changes);
  const judged = policy.applyPolicy(next, policy.readPolicy());
  if (judged.violations.length) fail(`the org policy does not allow this:\n  - ${judged.violations.join('\n  - ')}`);
  const cut = parsed.changes.publish !== null ? parsed.changes.publish.filter((a) => !current(judged.cfg).publish.includes(a)) : [];
  if (cut.length) fail(`the org policy does not let this repo publish: ${cut.join(', ')}`);

  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  const now = current(next);
  console.log(`choose: wrote ${file}`);
  console.log(`  models:  ${ROLES.map((role) => `${role} ${now.models[role]}`).join(', ')}`);
  console.log(`  publish: ${now.publish.length ? now.publish.join(', ') : 'nothing — the loop hands you a branch'}`);
  if (now.publish.length) console.log('  each run still asks before it publishes; this only sets what may be asked for');
}

if (require.main === module) main();
module.exports = { parse, apply, current, ROLES, MODELS, ACTS };
