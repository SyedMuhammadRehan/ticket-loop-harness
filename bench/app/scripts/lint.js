'use strict';
// The repo's analyzer: strict mode, no stray logging, and the layering rule from
// docs/ARCHITECTURE.md. Exits 1 with one line per finding.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function findings(file) {
  const rel = path.relative(path.join(SRC, '..'), file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  if (!/^'use strict';/.test(text)) out.push(`${rel}: missing 'use strict' on the first line`);
  text.split(/\r?\n/).forEach((line, i) => {
    if (/\bconsole\.(log|debug)\(/.test(line)) out.push(`${rel}:${i + 1}: stray console logging`);
    if (/\bdebugger\b/.test(line)) out.push(`${rel}:${i + 1}: debugger statement`);
    const required = /require\('([^']+)'\)/.exec(line);
    if (required && !rel.startsWith('src/http/') && /(^|\/)http(\/|$)/.test(required[1])) {
      out.push(`${rel}:${i + 1}: the domain must not depend on src/http`);
    }
  });
  return out;
}

const problems = sourceFiles(SRC).flatMap(findings);
for (const p of problems) console.error(p);
if (problems.length) {
  console.error(`lint: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log('lint: clean');
