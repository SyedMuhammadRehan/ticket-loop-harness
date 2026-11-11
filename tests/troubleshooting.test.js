'use strict';
// TROUBLESHOOTING.md is looked up by the message a person was shown. An entry whose heading no
// longer matches anything the plugin prints is a page nobody can find, so every heading has to
// be wording that still exists in the shipped hooks, scripts or skills.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./helpers.js');

const PLUGIN = path.join(REPO_ROOT, 'plugins', 'ticket-loop');
const DOC = path.join(REPO_ROOT, 'TROUBLESHOOTING.md');

function shippedText() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|md)$/.test(e.name)) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(PLUGIN);
  return out.join('\n');
}

const headings = () => [...fs.readFileSync(DOC, 'utf8').matchAll(/^### `(.+)`$/gm)].map((m) => m[1]);

test('every troubleshooting heading is wording the plugin still prints', () => {
  const shipped = shippedText();
  const found = headings();
  assert.ok(found.length >= 25, `only ${found.length} entries parsed; the heading format drifted`);
  for (const h of found) assert.ok(shipped.includes(h), `TROUBLESHOOTING.md has an entry for "${h}", which nothing in the plugin prints any more`);
});

test('every entry says what to do', () => {
  const body = fs.readFileSync(DOC, 'utf8');
  const sections = body.split(/^### /m).slice(1);
  for (const s of sections) assert.match(s, /\*\*Do:\*\*/, `the entry "${s.split('\n')[0]}" gives no fix`);
});

test('the write guard\'s refusal and the README point at the troubleshooting page', () => {
  assert.match(fs.readFileSync(path.join(PLUGIN, 'hooks', 'freeze_guard.js'), 'utf8'), /TROUBLESHOOTING\.md/);
  assert.match(fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8'), /\(TROUBLESHOOTING\.md\)/);
});
