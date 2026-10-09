// An organisation's floor under every repo's profile. One file per machine, distributed however
// the organisation distributes things, at ~/.claude/ticket-loop/policy.json or wherever
// TICKET_LOOP_POLICY points. A profile may tighten anything here and loosen nothing:
//
//   riskPaths              globs added to every profile's riskPaths
//   allowedModels          { role: [model, ...] } — a profile naming another model is a violation
//   qaScope.maxSmallDiffLines  caps the diff size a focused QA read may cover
//   requireMatchingTest    forces hooks.stopGate.requireMatchingTest on
//   attribution.commitTrailer  forces the trailer string onto every worktree commit
//   dispatchPolicy.maxRunTokens  caps the tokens one run may spend
//   publish.allowed        the most a repo may publish; a profile's list is cut down to it
//
// A violation is not repaired silently: changing a model behind the user's back would leave the
// run on a tier nobody chose. It is reported, and preflight stops on it.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_POLICY = 'TICKET_LOOP_POLICY';

function policyPath() {
  return process.env[ENV_POLICY] || path.join(os.homedir(), '.claude', 'ticket-loop', 'policy.json');
}

// null when there is no policy; { error } when there is one that cannot be read, which callers
// treat as a violation rather than as no policy.
function readPolicy() {
  const file = policyPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const policy = JSON.parse(text);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('not a JSON object');
    return { policy, path: file, sha256: crypto.createHash('sha256').update(text).digest('hex') };
  } catch (err) {
    return { error: `the org policy at ${file} could not be read (${err.message})`, path: file };
  }
}

function sameModel(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
}

// The model a role may use under the policy, or null when the policy does not limit that role.
function allowedFor(policy, role) {
  const list = policy && policy.allowedModels && policy.allowedModels[role];
  return Array.isArray(list) && list.length ? list.map(String) : null;
}

function modelAllowed(policy, role, model) {
  const list = allowedFor(policy, role);
  return !list || list.some((m) => sameModel(m, model || 'inherit'));
}

// Returns a new config with the floor applied, and the violations the floor cannot fix.
function applyPolicy(cfg, loaded) {
  if (!loaded) return { cfg, violations: [], applied: [] };
  if (loaded.error) return { cfg, violations: [loaded.error], applied: [] };
  const p = loaded.policy;
  const applied = [];
  const violations = [];
  const out = JSON.parse(JSON.stringify(cfg));

  if (Array.isArray(p.riskPaths) && p.riskPaths.length) {
    const before = new Set(out.riskPaths || []);
    const added = p.riskPaths.filter((g) => !before.has(g));
    out.riskPaths = [...(out.riskPaths || []), ...added];
    if (added.length) applied.push(`riskPaths gained ${added.join(', ')}`);
  }
  const cap = p.qaScope && p.qaScope.maxSmallDiffLines;
  if (Number.isInteger(cap) && cap >= 0) {
    out.qaScope = { ...(out.qaScope || {}) };
    if (!Number.isInteger(out.qaScope.smallDiffLines) || out.qaScope.smallDiffLines > cap) {
      out.qaScope.smallDiffLines = cap;
      applied.push(`qaScope.smallDiffLines capped at ${cap}`);
    }
  }
  const tokenCap = p.dispatchPolicy && p.dispatchPolicy.maxRunTokens;
  if (Number.isInteger(tokenCap) && tokenCap > 0) {
    const own = out.dispatchPolicy && out.dispatchPolicy.maxRunTokens;
    if (!Number.isInteger(own) || own > tokenCap) {
      out.dispatchPolicy = { ...(out.dispatchPolicy || {}), maxRunTokens: tokenCap };
      applied.push(`dispatchPolicy.maxRunTokens capped at ${tokenCap}`);
    }
  }
  if (p.publish && Array.isArray(p.publish.allowed)) {
    const own = (out.publish && Array.isArray(out.publish.allowed)) ? out.publish.allowed : [];
    const kept = own.filter((a) => p.publish.allowed.includes(a));
    if (kept.length !== own.length) applied.push(`publish.allowed cut to [${kept.join(', ')}]`);
    out.publish = { ...(out.publish || {}), allowed: kept };
  }
  if (p.requireMatchingTest === true && out.hooks && out.hooks.stopGate && out.hooks.stopGate.requireMatchingTest !== true) {
    out.hooks = { ...out.hooks, stopGate: { ...out.hooks.stopGate, requireMatchingTest: true } };
    applied.push('hooks.stopGate.requireMatchingTest forced on');
  }
  if (p.attribution && typeof p.attribution.commitTrailer === 'string') {
    out.attribution = { ...(out.attribution || {}), commitTrailer: p.attribution.commitTrailer };
    applied.push('attribution.commitTrailer set by the org policy');
  }
  for (const [role, model] of Object.entries(out.models || {})) {
    if (!modelAllowed(p, role, model)) {
      violations.push(`models.${role} is "${model}" but the org policy allows only ${allowedFor(p, role).join(', ')} for ${role}`);
    }
  }
  return { cfg: out, violations, applied };
}

module.exports = { readPolicy, applyPolicy, modelAllowed, allowedFor, policyPath, ENV_POLICY };
