'use strict';

/**
 * Real Process Crash Harness - Child Worker (Step 4)
 *
 * Runs real command submission and outbox dispatch in an isolated Node process.
 * Emits synchronization signal when PostgreSQL server commits and returns response,
 * but before local SQLite ACK transaction is executed.
 */

const path = require('path');
const databaseManager = require('../../database/databaseManager.cjs');
const commandPipeline = require('../../database/commandPipeline.cjs');
const { SyncClient } = require('../../sync/syncClient.cjs');
const { dispatchOutbox } = require('../../sync/outboxDispatcher.cjs');

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return null;
}

const baseUserDataPath = getArg('--base-dir');
const companyId = getArg('--company-id') || 'company_crash_step4';
const serverUrl = getArg('--server-url');
const token = getArg('--token');
const cmdJson = getArg('--cmd-json');

if (!baseUserDataPath || !serverUrl || !token || !cmdJson) {
  console.error('Usage: node step4CrashChild.cjs --base-dir <path> --company-id <id> --server-url <url> --token <token> --cmd-json <json>');
  process.exit(1);
}

const command = JSON.parse(cmdJson);

function holdProcessAliveForever() {
  while (true) {
    try {
      const waitBuf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(waitBuf, 0, 0, 60000);
    } catch (err) {
      const start = Date.now();
      while (Date.now() - start < 1000) {}
    }
  }
}

async function main() {
  // 1. Seed models and workers in real SQLite company database
  const db = databaseManager.getCompanyDatabase(baseUserDataPath, companyId);
  db.prepare(`
    INSERT OR IGNORE INTO models (id, company_id, name, operations_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    command.modelId,
    companyId,
    'Crash Test Model Step 4',
    JSON.stringify([
      { name: 'Bichish', rate: 1500 },
      { name: 'Tikish', rate: 4000 }
    ])
  );

  db.prepare(`
    INSERT OR IGNORE INTO workers (id, company_id, name, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(1, companyId, 'Rustam Karimov');

  db.prepare(`
    INSERT OR IGNORE INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Crash Test Model Step 4', 'ACTIVE', datetime('now'), datetime('now'))
  `).run(command.partyRecordId, companyId, command.partyNumber, command.partyNumber, command.modelId);

  // 2. Submit ticket locally (transitions to PENDING fact and PENDING outbox operation)
  commandPipeline.executeSubmitTicketCommand(baseUserDataPath, companyId, command);

  // 3. Prepare sync client
  const syncClient = new SyncClient({
    baseUrl: serverUrl,
    token,
    timeoutMs: 10000
  });

  // 4. Dispatch outbox with test hook that triggers right after server response is received
  await dispatchOutbox(db, companyId, syncClient, {
    testHooks: {
      afterServerResponse: async (serverResponse) => {
        // Confirm server responded with APPLIED
        const firstResult = serverResponse?.results?.[0];
        if (firstResult && firstResult.status === 'APPLIED') {
          process.stdout.write('STEP4_CRASH_STATE=SERVER_COMMITTED_BEFORE_ACK\n');
          holdProcessAliveForever();
        } else {
          console.error('Unexpected server response before crash hook:', serverResponse);
          process.exit(1);
        }
      }
    }
  });
}

main().catch((err) => {
  console.error('Child crashed with error:', err);
  process.exit(1);
});
