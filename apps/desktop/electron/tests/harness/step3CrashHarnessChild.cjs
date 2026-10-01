'use strict';

/**
 * Real Process Crash Harness - Child Worker
 * Phase 2 Step 3 Correction Pass
 *
 * Runs the ACTUAL commandPipeline in an isolated Node process.
 * Does NOT use dummy or spike tables.
 * Exercises: commandPipeline, tickets, ticket_entries, local_outbox.
 */

const databaseManager = require('../../database/databaseManager.cjs');
const commandPipeline = require('../../database/commandPipeline.cjs');

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return null;
}

const baseUserDataPath = getArg('--base-dir');
const companyId = getArg('--company-id') || 'company_crash_test';
const mode = getArg('--mode'); // 'uncommitted' | 'committed'
const cmdJson = getArg('--cmd-json');

if (!baseUserDataPath || !mode || !cmdJson) {
  console.error('Usage: node step3CrashHarnessChild.cjs --base-dir <path> --company-id <id> --mode <uncommitted|committed> --cmd-json <json>');
  process.exit(1);
}

const command = JSON.parse(cmdJson);

// 1. Seed models and workers in real company database
const db = databaseManager.getCompanyDatabase(baseUserDataPath, companyId);
db.prepare(`
  INSERT OR IGNORE INTO models (id, company_id, name, operations_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
`).run(
  command.modelId,
  companyId,
  'Crash Test Model',
  JSON.stringify([
    { name: 'Bichish', rate: 1200 },
    { name: 'Tikish', rate: 3500 }
  ])
);

db.prepare(`
  INSERT OR IGNORE INTO workers (id, company_id, name, created_at, updated_at)
  VALUES (?, ?, ?, datetime('now'), datetime('now'))
`).run(1, companyId, 'Ali Karimov');
db.prepare(`
  INSERT OR IGNORE INTO parties (
    id, company_id, party_number, physical_party_number, model_id, model_name,
    status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'Crash Test Model', 'ACTIVE', datetime('now'), datetime('now'))
`).run(command.partyRecordId, companyId, command.partyNumber, command.partyNumber, command.modelId);

function holdProcessAliveForever() {
  // Synchronously blocks until killed by parent process via taskkill
  while (true) {
    try {
      const waitBuf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(waitBuf, 0, 0, 60000);
    } catch (err) {
      // Fallback sleep
      const start = Date.now();
      while (Date.now() - start < 1000) {}
    }
  }
}

if (mode === 'uncommitted') {
  // Execute real command with hook pausing AFTER ticket, entries, and outbox insert, BUT BEFORE COMMIT
  try {
    commandPipeline.executeSubmitTicketCommand(baseUserDataPath, companyId, command, {
      testHooks: {
        beforeCommit: () => {
          // Both fact and outbox have been inserted inside active SQLite transaction.
          // Emit exact synchronization signal to stdout
          process.stdout.write('STEP3_CRASH_STATE=UNCOMMITTED_READY\n');
          // Block indefinitely so parent process can kill us while transaction is uncommitted
          holdProcessAliveForever();
        }
      }
    });
  } catch (err) {
    console.error('Child uncommitted error:', err);
    process.exit(1);
  }
} else if (mode === 'committed') {
  // Execute real command, allowing COMMIT to complete fully
  try {
    const result = commandPipeline.executeSubmitTicketCommand(baseUserDataPath, companyId, command);
    if (result.committed) {
      // Emit exact synchronization signal
      process.stdout.write('STEP3_CRASH_STATE=COMMIT_COMPLETE\n');
      // Hold process alive with open DB connection and un-flushed process state
      holdProcessAliveForever();
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error('Child committed error:', err);
    process.exit(1);
  }
} else {
  console.error('Unknown mode:', mode);
  process.exit(1);
}
