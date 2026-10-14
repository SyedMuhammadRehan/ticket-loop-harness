'use strict';
// The by-hand install registers hooks from settings.example.json; the plugin from hooks.json.
// A hook missing from one of them is a guarantee that install does not have.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, HOOKS_DIR } = require('./helpers.js');

function registrations(file) {
  const { hooks } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks) {
        const script = (h.command.match(/([\w-]+\.js)/) || [])[1];
        out.push(`${event} | ${entry.matcher || ''} | ${script}`);
      }
    }
  }
  return out.sort();
}

test('settings.example.json registers exactly the hooks hooks.json registers', () => {
  const plugin = registrations(path.join(HOOKS_DIR, 'hooks.json'));
  const manual = registrations(path.join(REPO_ROOT, 'settings.example.json'));
  assert.deepStrictEqual(manual, plugin);
  assert.ok(plugin.includes('PreToolUse | Read|Grep | freeze_guard.js'), 'the key reads are guarded');
});
