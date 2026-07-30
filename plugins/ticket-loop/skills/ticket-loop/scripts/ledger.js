#!/usr/bin/env node
// Mechanical budget enforcement (zero deps). Counters live in budget.json, written
// ONLY by this script and shielded from Edit/Write/shell tampering by freeze_guard.
//
//   ledger.js init <runDir> [baseSha]   create budget.json + ledger.md skeleton
//   ledger.js dispatch <runDir> [label] +1 dispatch; exit 2 when the budget is exhausted
//   ledger.js replan <runDir>           +1 re-plan;  exit 2 when the cap is reached
//   ledger.js status <runDir>           print counters as JSON
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_DISPATCHES = 25;
const MAX_REPLANS = 2;

function budgetPath(runDir) {
  return path.join(runDir, 'budget.json');
}

function readBudget(runDir) {
  try {
    return JSON.parse(fs.readFileSync(budgetPath(runDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeBudget(runDir, budget) {
  fs.writeFileSync(budgetPath(runDir), JSON.stringify(budget, null, 2) + '\n');
}

function cmdInit(runDir, baseSha) {
  fs.mkdirSync(runDir, { recursive: true });
  if (fs.existsSync(budgetPath(runDir))) {
    console.error(
      `ledger init: ${budgetPath(runDir)} already exists — refusing to reset counters. ` +
        `RESUME keeps existing counts; CLEAN RESTART must archive the old run dir first.`
    );
    process.exit(1);
  }
  writeBudget(runDir, {
    dispatches: 0,
    replans: 0,
    maxDispatches: MAX_DISPATCHES,
    maxReplans: MAX_REPLANS,
    history: [],
  });

  const ledgerFile = path.join(runDir, 'ledger.md');
  if (!fs.existsSync(ledgerFile)) {
    const ticket = path.basename(runDir);
    fs.writeFileSync(
      ledgerFile,
      `# Ledger — ${ticket}\n` +
        `base: ${baseSha || 'unknown'}\n` +
        `started: ${new Date().toISOString()}\n` +
        `counters: budget.json (script-managed via ledger.js — never edit by hand)\n` +
        `## Check history\n` +
        `| check | results (oldest→newest) |\n` +
        `|---|---|\n` +
        `## Attempts\n`
    );
  }
  console.log(`ledger: initialized ${runDir} (budget ${MAX_DISPATCHES} dispatches / ${MAX_REPLANS} re-plans)`);
}

function requireBudget(runDir) {
  const budget = readBudget(runDir);
  if (!budget) {
    console.error(`ledger: ${budgetPath(runDir)} missing or unreadable — run "ledger.js init ${runDir}" first.`);
    process.exit(1);
  }
  return budget;
}

function cmdDispatch(runDir, label) {
  const budget = requireBudget(runDir);
  const max = budget.maxDispatches || MAX_DISPATCHES;
  if (budget.dispatches >= max) {
    console.error(
      `HARD BUDGET: ${budget.dispatches}/${max} dispatches used — do NOT dispatch. ` +
        `Go to Stage 7 with status INCOMPLETE.`
    );
    process.exit(2);
  }
  const next = {
    ...budget,
    dispatches: budget.dispatches + 1,
    history: [...(budget.history || []), { t: new Date().toISOString(), kind: 'dispatch', label: label || null }],
  };
  writeBudget(runDir, next);
  console.log(`ledger: dispatch OK — ${next.dispatches}/${max} used`);
}

function cmdReplan(runDir) {
  const budget = requireBudget(runDir);
  const max = budget.maxReplans == null ? MAX_REPLANS : budget.maxReplans;
  if (budget.replans >= max) {
    console.error(
      `CIRCUIT BREAKER: ${budget.replans}/${max} re-plans used — do NOT re-plan again. ` +
        `Go to Stage 7 with status INCOMPLETE.`
    );
    process.exit(2);
  }
  const next = {
    ...budget,
    replans: budget.replans + 1,
    history: [...(budget.history || []), { t: new Date().toISOString(), kind: 'replan' }],
  };
  writeBudget(runDir, next);
  console.log(`ledger: replan OK — ${next.replans}/${max} used`);
}

function cmdStatus(runDir) {
  const budget = requireBudget(runDir);
  process.stdout.write(JSON.stringify(budget, null, 2) + '\n');
}

function main() {
  const [cmd, runDir, ...rest] = process.argv.slice(2);
  if (!cmd || !runDir) {
    console.error('usage: ledger.js init <runDir> [baseSha] | dispatch <runDir> [label] | replan <runDir> | status <runDir>');
    process.exit(1);
  }
  if (cmd === 'init') return cmdInit(runDir, rest[0]);
  if (cmd === 'dispatch') return cmdDispatch(runDir, rest.join(' '));
  if (cmd === 'replan') return cmdReplan(runDir);
  if (cmd === 'status') return cmdStatus(runDir);
  console.error(`ledger.js: unknown command "${cmd}"`);
  process.exit(1);
}
main();
