#!/usr/bin/env node
// PostToolUse hook: format + analyze each edited file using the PER-REPO PROFILE
// (.agents/ticket-loop.config.json -> hooks.postEdit). Stack-agnostic: with no config
// (or no hooks.postEdit block) it is inert. Example block (Flutter):
//   "hooks": {
//     "postEdit": {
//       "extensions": [".dart"],
//       "exclude": "\\.(g|freezed|tailor|gr|config|gen)\\.dart$",
//       "format": "dart format {file}",
//       "analyze": "dart analyze {file}",
//       "analyzeErrorRegex": "\\berror\\b\\s*[-•]|^\\s*error\\b"
//     }
//   }
// analyzeErrorRegex: block (exit 2) only when an output line matches; when unset, any
// non-zero analyze exit blocks with the output tail.
'use strict';
const lib = require('./hook_lib.js');

const ANALYZE_TIMEOUT_MS = 90000;
const FORMAT_TIMEOUT_MS = 30000;
const TAIL_LINES = 40;

function shouldProcess(file, conf) {
  if (!file) return false;
  const normalized = String(file).replace(/\\/g, '/');
  const extensions = conf.extensions || [];
  if (!extensions.some((ext) => normalized.endsWith(ext))) return false;
  if (conf.exclude) {
    try {
      if (new RegExp(conf.exclude).test(normalized)) return false;
    } catch {
      // Invalid exclude regex in config: fail open (process the file) rather than crash.
    }
  }
  return true;
}

function findBlockingLines(output, errorRegexSource) {
  if (!errorRegexSource) return null; // caller treats any non-zero exit as blocking
  let re;
  try {
    re = new RegExp(errorRegexSource);
  } catch {
    return null;
  }
  const lines = output.split('\n').filter((l) => re.test(l));
  return lines;
}

function main() {
  const input = lib.readStdinJson();
  if (!input) process.exit(0);
  const file = input.tool_input && input.tool_input.file_path;
  if (!file) process.exit(0);

  const { found, config } = lib.loadConfig();
  const conf = found && config.hooks && config.hooks.postEdit;
  if (!conf) process.exit(0); // no profile / no postEdit block -> inert by design

  if (!shouldProcess(file, conf)) process.exit(0);
  if (!require('fs').existsSync(file)) process.exit(0);

  if (conf.format) {
    const res = lib.runArgv(lib.buildArgv(conf.format, { '{file}': file }), {
      timeoutMs: FORMAT_TIMEOUT_MS,
    });
    if (res.error) {
      console.error(`post_edit hook: format failed to run (${res.error.message})`);
      process.exit(1);
    }
  }

  if (!conf.analyze) process.exit(0);

  const res = lib.runArgv(lib.buildArgv(conf.analyze, { '{file}': file }), {
    timeoutMs: ANALYZE_TIMEOUT_MS,
  });
  if (res.error) {
    console.error(`post_edit hook: analyze failed to run (${res.error.message})`);
    process.exit(1);
  }
  if (res.status === 0) process.exit(0);

  const out = lib.combinedOutput(res);
  const blocking = findBlockingLines(out, conf.analyzeErrorRegex);
  if (blocking === null) {
    // No errorRegex configured: any non-zero analyze exit is a block.
    console.error(`post_edit: analyze failed for ${file} — fix before continuing:\n${lib.tail(out, TAIL_LINES)}`);
    process.exit(2);
  }
  if (blocking.length > 0) {
    console.error(`post_edit: analyze found ERRORS in ${file} — fix before continuing:\n${blocking.join('\n')}`);
    process.exit(2);
  }
  if (out.trim().length > 0) process.exit(0); // warnings/infos only — don't block
  console.error(`post_edit hook: analyze exited ${res.status} with no output — treating as a hook/environment failure.`);
  process.exit(1);
}

if (require.main === module) main();
module.exports = { shouldProcess, findBlockingLines };
