'use strict';
// CLAUDE.md states that package.json, plugin.json and marketplace.json must agree, and that the
// marketplace version governs installs so a mismatch there ships the wrong thing silently. That
// was prose with nothing behind it: a release shipped 0.12.0 twice, and the second one reached
// no install because `plugin update` compares version numbers and saw no change.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./helpers.js');

const SEMVER = /^\d+\.\d+\.\d+$/;

const SOURCES = {
  'package.json': (json) => json.version,
  'plugins/ticket-loop/.claude-plugin/plugin.json': (json) => json.version,
  // The marketplace lists plugins; the one this repo ships is the entry to check.
  '.claude-plugin/marketplace.json': (json) => (json.plugins || []).find((p) => p.name === 'ticket-loop').version,
};

function versions() {
  return Object.entries(SOURCES).map(([rel, pick]) => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    return { rel, version: pick(JSON.parse(raw)) };
  });
}

test('every version file is present and carries a well-formed version', () => {
  for (const { rel, version } of versions()) {
    assert.ok(version, `${rel} declares no version`);
    assert.match(version, SEMVER, `${rel} version "${version}" is not MAJOR.MINOR.PATCH`);
  }
});

test('package.json, plugin.json and marketplace.json declare the same version', () => {
  const found = versions();
  const distinct = [...new Set(found.map((f) => f.version))];
  assert.strictEqual(
    distinct.length,
    1,
    `version files disagree: ${found.map((f) => `${f.rel}=${f.version}`).join(', ')}. ` +
      `The marketplace version governs installs, so a mismatch ships the wrong thing silently.`
  );
});
