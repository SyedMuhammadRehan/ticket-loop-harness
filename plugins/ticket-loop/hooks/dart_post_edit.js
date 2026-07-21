#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ANALYZE_ON_EDIT = true;
const STATE_DIR = path.join('.claude', 'hooks', 'state');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Resolve a real dart.exe and spawn it directly. Never shell:true — it exposes an
// injection surface via tool_input.file_path, and shell-less .bat spawns throw EINVAL.
function resolveDart() {
  if (process.platform !== 'win32') return 'dart';

  const direct = spawnSync('dart.exe', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (!direct.error) return 'dart.exe';

  const where = spawnSync('where', ['dart'], { encoding: 'utf8', timeout: 5000 });
  if (!where.error && where.stdout) {
    const batLine = where.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.toLowerCase().endsWith('.bat'));
    if (batLine) {
      const dartExe = path.join(path.dirname(batLine), 'cache', 'dart-sdk', 'bin', 'dart.exe');
      if (fs.existsSync(dartExe)) return dartExe;
    }
  }

  return null;
}

function main() {
  let input;
  try {
    let stdin = readStdin();
    if (stdin.charCodeAt(0) === 0xFEFF) stdin = stdin.slice(1);
    input = JSON.parse(stdin);
  } catch { process.exit(0); }
  const file = input && input.tool_input && input.tool_input.file_path;
  if (!file || !file.endsWith('.dart')) process.exit(0);
  if (!fs.existsSync(file)) process.exit(0);
  const generated = file.endsWith('.g.dart') || file.endsWith('.freezed.dart');

  const dartCmd = resolveDart();
  if (!dartCmd) {
    console.error('dart_post_edit hook: could not resolve a dart executable - skipping format/analyze.');
    process.exit(1);
  }

  const fmtRes = spawnSync(dartCmd, ['format', file], { encoding: 'utf8', timeout: 30000 });
  if (fmtRes.error) {
    console.error(`dart_post_edit hook: failed to spawn "${dartCmd} format ${file}" - ${fmtRes.error.message}`);
    process.exit(1);
  }

  if (!ANALYZE_ON_EDIT || generated) process.exit(0);

  const started = Date.now();
  const res = spawnSync(dartCmd, ['analyze', file], { encoding: 'utf8', timeout: 90000 });
  const elapsed = Date.now() - started;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'analyze-timing.log'), `${elapsed}ms ${file}\n`);
  } catch {}

  if (res.error) {
    console.error(`dart_post_edit hook: failed to spawn "${dartCmd} analyze ${file}" - ${res.error.message}`);
    process.exit(1);
  }

  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const errorLines = out.split('\n').filter((l) => /\berror\b\s*[-•]/.test(l) || /^\s*error\b/i.test(l));

  if (res.status !== 0) {
    if (errorLines.length > 0) {
      console.error(`dart analyze found ERRORS in ${file} — fix before continuing:\n${errorLines.join('\n')}`);
      process.exit(2);
    }
    if (out.trim().length > 0) process.exit(0);
    console.error(`dart_post_edit hook: "${dartCmd} analyze ${file}" exited ${res.status} with no output - treating as a hook/environment failure.`);
    process.exit(1);
  }

  process.exit(0);
}
main();
