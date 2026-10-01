'use strict';

/**
 * Real Process Crash Harness - Parent Controller
 * Phase 2 Step 3 Correction Pass
 *
 * Enforces:
 * - Hard process kill (taskkill /F /T /PID <pid>) under real command execution.
 * - Zero orphan facts or outbox rows on crash BEFORE commit.
 * - Complete survival of fact and outbox on crash AFTER commit.
 * - PRAGMA integrity_check returns 'ok' in both cases.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const databaseManager = require('../../database/databaseManager.cjs');

function killProcessTree(pid) {
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } catch (err) {
      // Process may have already exited
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {}
  }
}

/**
 * Runs a single crash test against the real child command pipeline.
 *
 * @param {string} tempUserDataDir
 * @param {string} companyId
 * @param {'uncommitted' | 'committed'} mode
 * @param {object} command
 * @returns {Promise<{ exited: boolean, signal: string }>}
 */
function runCrashTest(tempUserDataDir, companyId, mode, command) {
  return new Promise((resolve, reject) => {
    const childScript = path.join(__dirname, 'step3CrashHarnessChild.cjs');
    const child = spawn(
      process.execPath,
      [
        childScript,
        '--base-dir', tempUserDataDir,
        '--company-id', companyId,
        '--mode', mode,
        '--cmd-json', JSON.stringify(command)
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stdoutBuffer = '';
    let stderrBuffer = '';
    const targetSignal = mode === 'uncommitted' ? 'STEP3_CRASH_STATE=UNCOMMITTED_READY' : 'STEP3_CRASH_STATE=COMMIT_COMPLETE';
    let killExecuted = false;

    const timeoutTimer = setTimeout(() => {
      if (!killExecuted) {
        killProcessTree(child.pid);
        reject(new Error(`Timeout waiting for child signal: ${targetSignal}. Stdout: ${stdoutBuffer}, Stderr: ${stderrBuffer}`));
      }
    }, 10000);

    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      if (!killExecuted && stdoutBuffer.includes(targetSignal)) {
        killExecuted = true;
        // Target state reached! Perform REAL hard process termination.
        killProcessTree(child.pid);
      }
    });

    child.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
    });

    child.on('exit', () => {
      clearTimeout(timeoutTimer);
      if (killExecuted) {
        resolve({ exited: true, signal: targetSignal });
      } else {
        reject(new Error(`Child exited prematurely without emitting signal ${targetSignal}. Stderr: ${stderrBuffer}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      reject(err);
    });
  });
}

/**
 * Executes the full crash harness suite.
 */
async function executeStep3CrashHarness() {
  console.log('====================================================');
  console.log('STARTING PHASE 2 STEP 3 REAL HARD CRASH HARNESS');
  console.log('====================================================');

  const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step3-hard-crash-'));
  const companyId = 'crash_corp';

  try {
    // TEST 1: UNCOMMITTED HARD CRASH
    console.log('[1/2] Executing Uncommitted Hard Crash Test...');
    const cmd1 = {
      commandId: 'cmd_crash_uncommitted',
      operationId: 'op_crash_uncommitted',
      companyId,
      ticketId: '10000000-0000-4000-8000-000000000001',
      modelId: 'model_crash_1',
      partyNumber: '1',
      partyRecordId: 'party_crash_1',
      pattaNumber: 1,
      qty: 40,
      entries: [{ workerId: 1, opName: 'Bichish', rateSnapshot: 1200 }]
    };

    await runCrashTest(tempUserDataDir, companyId, 'uncommitted', cmd1);
    console.log('   -> Real taskkill successfully executed on uncommitted state');

    // Inspect database after crash
    const db1 = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    const uncommittedTicket = db1.prepare('SELECT * FROM tickets WHERE id = ?').get('10000000-0000-4000-8000-000000000001');
    const uncommittedEntries = db1.prepare('SELECT * FROM ticket_entries WHERE ticket_id = ?').all('10000000-0000-4000-8000-000000000001');
    const uncommittedOutbox = db1.prepare('SELECT * FROM local_outbox WHERE operation_id = ?').get('op_crash_uncommitted');
    const integrity1 = db1.pragma('integrity_check', { simple: true });

    if (uncommittedTicket) throw new Error('Uncommitted ticket leaked into database after crash!');
    if (uncommittedEntries.length > 0) throw new Error('Uncommitted entries leaked into database after crash!');
    if (uncommittedOutbox) throw new Error('Uncommitted outbox operation leaked into database after crash!');
    if (integrity1 !== 'ok') throw new Error(`Integrity check failed: ${integrity1}`);

    databaseManager.closeAllCompanyDatabases();
    console.log('   -> PASS: 0 orphan tickets, 0 orphan entries, 0 orphan outbox. Integrity: ok');

    // TEST 2: COMMITTED HARD CRASH
    console.log('[2/2] Executing Committed Hard Crash Test...');
    const cmd2 = {
      commandId: 'cmd_crash_committed',
      operationId: 'op_crash_committed',
      companyId,
      ticketId: '10000000-0000-4000-8000-000000000002',
      modelId: 'model_crash_1',
      partyNumber: '1',
      partyRecordId: 'party_crash_1',
      pattaNumber: 2,
      qty: 65,
      entries: [{ workerId: 1, opName: 'Bichish', rateSnapshot: 1200 }]
    };

    await runCrashTest(tempUserDataDir, companyId, 'committed', cmd2);
    console.log('   -> Real taskkill successfully executed on committed state');

    // Inspect database after crash
    const db2 = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    const committedTicket = db2.prepare('SELECT * FROM tickets WHERE id = ?').get('10000000-0000-4000-8000-000000000002');
    const committedEntries = db2.prepare('SELECT * FROM ticket_entries WHERE ticket_id = ?').all('10000000-0000-4000-8000-000000000002');
    const committedOutbox = db2.prepare('SELECT * FROM local_outbox WHERE operation_id = ?').get('op_crash_committed');
    const integrity2 = db2.pragma('integrity_check', { simple: true });

    if (!committedTicket) throw new Error('Committed ticket missing after hard crash!');
    if (committedEntries.length !== 1) throw new Error(`Expected 1 entry, found ${committedEntries.length}`);
    if (!committedOutbox) throw new Error('Committed outbox operation missing after hard crash!');
    if (!committedOutbox.payload_hash || committedOutbox.payload_hash.length !== 64) {
      throw new Error(`Committed outbox operation missing valid 64-char payload_hash! (Found: ${committedOutbox.payload_hash})`);
    }
    const { computePayloadHash } = require('../../database/canonicalPayload.cjs');
    const expectedPayloadHash = computePayloadHash(committedOutbox.payload_json);
    if (committedOutbox.payload_hash !== expectedPayloadHash) {
      throw new Error(`Committed outbox payload_hash (${committedOutbox.payload_hash}) does not match payload_json (${expectedPayloadHash})`);
    }
    if (integrity2 !== 'ok') throw new Error(`Integrity check failed: ${integrity2}`);

    databaseManager.closeAllCompanyDatabases();
    console.log('   -> PASS: Fact and Outbox survived hard crash with exact counts and payload_hash. Integrity: ok');

    console.log('====================================================');
    console.log('ALL STEP 3 REAL HARD CRASH INVARIANTS VERIFIED: PASS');
    console.log('====================================================');
    return { success: true };
  } finally {
    databaseManager.closeAllCompanyDatabases();
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
    } catch (err) {}
  }
}

if (require.main === module) {
  executeStep3CrashHarness()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Crash harness failed:', err);
      process.exit(1);
    });
}

module.exports = {
  runCrashTest,
  executeStep3CrashHarness
};
