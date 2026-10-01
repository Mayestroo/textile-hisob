import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, execSync } from 'child_process';

const { buildFastifyServer } = require('../../../server/app.cjs');
const { getServerPool, resetServerDatabase, closeServerPool } = require('../../../server/infrastructure/db.cjs');
const { getCompanyDatabase, closeAllCompanyDatabases } = require('../database/databaseManager.cjs');
const { executeSubmitTicketCommand } = require('../database/commandPipeline.cjs');
const {
  insertOutboxOperation,
  getOperation,
  updateOperationStatus,
  recoverStrandedSendingOperations
} = require('../database/outboxManager.cjs');
const { SyncClient } = require('./syncClient.cjs');
const { dispatchOutbox, isDependencySatisfied } = require('./outboxDispatcher.cjs');
const { executeReconnectProtocol } = require('./reconnectManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../../../server/modules/sync/canonicalPayload.cjs');

function killProcessTree(pid: number) {
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } catch (err) {}
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {}
  }
}

describe('Phase 2 Step 4 — Stranded SENDING Recovery & Crash Invariants', () => {
  let serverApp: any;
  let serverPool: any;
  let testUserDataDir: string;
  const serverPort = 3199;
  let baseUrl: string;

  const COMPANY_ALPHA = 'company-rec-alpha';
  const COMPANY_BETA = 'company-rec-beta';
  const TOKEN_ALPHA = `novda-test-token:${COMPANY_ALPHA}:electron-rec-1`;

  beforeAll(async () => {
    serverPool = getServerPool();
    await resetServerDatabase();
    serverApp = buildFastifyServer({ pool: serverPool, allowTestTokens: true });
    await serverApp.listen({ port: serverPort, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${serverPort}`;
  });

  afterAll(async () => {
    if (serverApp) await serverApp.close();
    await closeServerPool();
    closeAllCompanyDatabases();
  });

  beforeEach(async () => {
    await resetServerDatabase();
    closeAllCompanyDatabases();
    testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-rec-test-'));
  });

  afterEach(() => {
    closeAllCompanyDatabases();
    try {
      if (testUserDataDir && fs.existsSync(testUserDataDir)) {
        fs.rmSync(testUserDataDir, { recursive: true, force: true });
      }
    } catch {}
  });

  function seedCompany(companyId: string) {
    const db = getCompanyDatabase(testUserDataDir, companyId);
    db.prepare(`
      INSERT OR IGNORE INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run('m_test', companyId, 'Test Model', JSON.stringify([{ name: 'Bichish', rate: 1000 }]));

    db.prepare(`
      INSERT OR IGNORE INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
    `).run(1, companyId, 'Alisher');
    db.prepare(`
      INSERT OR IGNORE INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name, status, created_at, updated_at)
      VALUES ('party-recovery-1', ?, '1', '1', 'm_test', 'Test Model', 'ACTIVE', datetime('now'), datetime('now'))
    `).run(companyId);
    return db;
  }

  async function seedServerParty() {
    await serverPool.query(
      `INSERT INTO models (id, company_id, name, operations_json)
       VALUES ('m_test', $1, 'Test Model', '[{"name":"Bichish","rate":1000}]')
       ON CONFLICT (company_id, id) DO NOTHING`,
      [COMPANY_ALPHA]
    );
    await serverPool.query(
      `INSERT INTO workers (id, company_id, name)
       VALUES (1, $1, 'Alisher')
       ON CONFLICT (company_id, id) DO NOTHING`,
      [COMPANY_ALPHA]
    );
    await serverPool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ('party-recovery-1', $1, '1', '1', 'm_test', 'ACTIVE')`,
      [COMPANY_ALPHA]
    );
  }

  // ----------------------------------------------------------------
  // 1. Basic SENDING recovery: counters unchanged, payload intact
  // ----------------------------------------------------------------
  it('1. basic recovery: SENDING -> PENDING, counters untouched, payload immutable', () => {
    const db = seedCompany(COMPANY_ALPHA);
    const payload = { test: 'recovery-1', companyId: COMPANY_ALPHA };
    const pJson = canonicalStringify(payload);
    const pHash = computePayloadHash(pJson);

    insertOutboxOperation(db, {
      operation_id: 'op_rec_basic_1',
      company_id: COMPANY_ALPHA,
      command_type: 'SubmitTicket',
      entity_type: 'ticket',
      entity_id: 't_rec_basic_1',
      base_revision: 0,
      payload_json: pJson,
      payload_hash: pHash,
      causal_sequence: 10,
      status: 'PENDING',
      attempt_count: 0,
      retry_count: 0
    });

    // Dispatcher transitions PENDING -> SENDING (attempt=1, retry=0)
    updateOperationStatus(db, COMPANY_ALPHA, 'op_rec_basic_1', 'SENDING');
    const sendingOp = getOperation(db, COMPANY_ALPHA, 'op_rec_basic_1');
    expect(sendingOp.status).toBe('SENDING');
    expect(sendingOp.attempt_count).toBe(1);
    expect(sendingOp.retry_count).toBe(0);

    // Run startup recovery
    const recovered = recoverStrandedSendingOperations(db, COMPANY_ALPHA);
    expect(recovered.length).toBe(1);

    const recoveredOp = getOperation(db, COMPANY_ALPHA, 'op_rec_basic_1');
    expect(recoveredOp.status).toBe('PENDING');
    expect(recoveredOp.attempt_count).toBe(1); // Unchanged!
    expect(recoveredOp.retry_count).toBe(0); // Unchanged!
    expect(recoveredOp.last_error).toBe('RECOVERED_STRANDED_SENDING');
    expect(recoveredOp.payload_json).toBe(pJson); // Immutability preserved
    expect(recoveredOp.payload_hash).toBe(pHash);
    expect(recoveredOp.causal_sequence).toBe(10);
  });

  // ----------------------------------------------------------------
  // 2. Non-SENDING rows completely unaffected by recovery
  // ----------------------------------------------------------------
  it('2. non-SENDING rows (PENDING, SYNCED, CONFLICT, DEAD_LETTER) are untouched', () => {
    const db = seedCompany(COMPANY_ALPHA);

    const makeOp = (opId: string, status: string, attempt: number, retry: number) => {
      const payload = { opId, status };
      const pJson = canonicalStringify(payload);
      const pHash = computePayloadHash(pJson);
      insertOutboxOperation(db, {
        operation_id: opId,
        company_id: COMPANY_ALPHA,
        command_type: 'SubmitTicket',
        entity_type: 'ticket',
        entity_id: `ent_${opId}`,
        base_revision: 0,
        payload_json: pJson,
        payload_hash: pHash,
        causal_sequence: 1,
        status: 'PENDING',
        attempt_count: attempt,
        retry_count: retry
      });

      if (status !== 'PENDING') {
        updateOperationStatus(db, COMPANY_ALPHA, opId, 'SENDING');
        if (status !== 'SENDING') {
          updateOperationStatus(db, COMPANY_ALPHA, opId, status, `Test error for ${status}`);
        }
      }
    };

    makeOp('op_p', 'PENDING', 0, 0);
    makeOp('op_s', 'SENDING', 1, 0);
    makeOp('op_synced', 'SYNCED', 1, 0);
    makeOp('op_conflict', 'CONFLICT', 2, 1);
    makeOp('op_dl', 'DEAD_LETTER', 3, 2);

    // Run recovery
    const recovered = recoverStrandedSendingOperations(db, COMPANY_ALPHA);
    expect(recovered.length).toBe(1);
    expect(recovered[0].operation_id).toBe('op_s');

    // Verify all rows
    expect(getOperation(db, COMPANY_ALPHA, 'op_p').status).toBe('PENDING');
    expect(getOperation(db, COMPANY_ALPHA, 'op_s').status).toBe('PENDING');
    expect(getOperation(db, COMPANY_ALPHA, 'op_s').last_error).toBe('RECOVERED_STRANDED_SENDING');
    expect(getOperation(db, COMPANY_ALPHA, 'op_synced').status).toBe('SYNCED');
    expect(getOperation(db, COMPANY_ALPHA, 'op_conflict').status).toBe('CONFLICT');
    expect(getOperation(db, COMPANY_ALPHA, 'op_dl').status).toBe('DEAD_LETTER');
  });

  // ----------------------------------------------------------------
  // 3. Company isolation during recovery
  // ----------------------------------------------------------------
  it('3. recovery isolates by company and does not touch other company databases', () => {
    const dbA = seedCompany(COMPANY_ALPHA);
    const dbB = seedCompany(COMPANY_BETA);

    const makeSendingOp = (db: any, compId: string, opId: string) => {
      const payload = { opId, compId };
      const pJson = canonicalStringify(payload);
      const pHash = computePayloadHash(pJson);
      insertOutboxOperation(db, {
        operation_id: opId,
        company_id: compId,
        command_type: 'SubmitTicket',
        entity_type: 'ticket',
        entity_id: `ent_${opId}`,
        base_revision: 0,
        payload_json: pJson,
        payload_hash: pHash,
        causal_sequence: 1,
        status: 'PENDING',
        attempt_count: 0,
        retry_count: 0
      });
      updateOperationStatus(db, compId, opId, 'SENDING');
    };

    makeSendingOp(dbA, COMPANY_ALPHA, 'op_alpha_stranded');
    makeSendingOp(dbB, COMPANY_BETA, 'op_beta_stranded');

    // Recover ONLY Company Alpha
    const recovered = recoverStrandedSendingOperations(dbA, COMPANY_ALPHA);
    expect(recovered.length).toBe(1);
    expect(recovered[0].operation_id).toBe('op_alpha_stranded');

    // Check Alpha: recovered to PENDING
    expect(getOperation(dbA, COMPANY_ALPHA, 'op_alpha_stranded').status).toBe('PENDING');

    // Check Beta: remains SENDING (completely untouched)
    expect(getOperation(dbB, COMPANY_BETA, 'op_beta_stranded').status).toBe('SENDING');
  });

  // ----------------------------------------------------------------
  // 4. Causal child unblock path
  // ----------------------------------------------------------------
  it('4. causal child ordering: child remains blocked until recovered parent retries and becomes SYNCED', async () => {
    const db = seedCompany(COMPANY_ALPHA);
    const syncClient = new SyncClient({ baseUrl, token: TOKEN_ALPHA });
    await seedServerParty();

    // Seed server model & worker
    await serverPool.query(`
      INSERT INTO models (id, company_id, name, operations_json)
      VALUES ('m_test', $1, 'Test Model', '[{"name":"Bichish","rate":1000}]')
      ON CONFLICT DO NOTHING
    `, [COMPANY_ALPHA]);
    await serverPool.query(`
      INSERT INTO workers (id, company_id, name)
      VALUES (1, $1, 'Alisher')
      ON CONFLICT DO NOTHING
    `, [COMPANY_ALPHA]);

    // Parent: SubmitTicket (1)
    const cmdParent = {
      commandId: 'cmd_p_1',
      operationId: 'op_parent_causal',
      companyId: COMPANY_ALPHA,
      ticketId: '00000000-0000-4000-8000-000000000301',
      modelId: 'm_test',
      partyNumber: '1',
      partyRecordId: 'party-recovery-1',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 10,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 10 }]
    };
    executeSubmitTicketCommand(testUserDataDir, COMPANY_ALPHA, cmdParent);

    // Child: SubmitTicket (2), depends on parent
    const cmdChild = {
      commandId: 'cmd_c_1',
      operationId: 'op_child_causal',
      companyId: COMPANY_ALPHA,
      ticketId: '00000000-0000-4000-8000-000000000302',
      modelId: 'm_test',
      partyNumber: '1',
      partyRecordId: 'party-recovery-1',
      effectiveDate: '2026-09-01',
      pattaNumber: 2,
      qty: 10,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 10 }],
      dependsOnOperationId: 'op_parent_causal',
      causalSequence: 1
    };
    executeSubmitTicketCommand(testUserDataDir, COMPANY_ALPHA, cmdChild);

    // Simulate parent transitioned to SENDING before crash
    updateOperationStatus(db, COMPANY_ALPHA, 'op_parent_causal', 'SENDING');

    // Child must be BLOCKED
    const childOpBefore = getOperation(db, COMPANY_ALPHA, 'op_child_causal');
    expect(isDependencySatisfied(db, COMPANY_ALPHA, childOpBefore)).toBe(false);

    // Startup recovery runs
    recoverStrandedSendingOperations(db, COMPANY_ALPHA);

    // Parent is now PENDING
    const parentRecovered = getOperation(db, COMPANY_ALPHA, 'op_parent_causal');
    expect(parentRecovered.status).toBe('PENDING');

    // Child MUST STILL BE BLOCKED because parent is PENDING, not SYNCED!
    const childOpAfterRec = getOperation(db, COMPANY_ALPHA, 'op_child_causal');
    expect(isDependencySatisfied(db, COMPANY_ALPHA, childOpAfterRec)).toBe(false);

    // Now dispatch outbox: parent dispatches first
    const dispatchRes = await dispatchOutbox(db, COMPANY_ALPHA, syncClient);
    expect(dispatchRes.synced).toBe(1);

    // Parent is now SYNCED
    const parentSynced = getOperation(db, COMPANY_ALPHA, 'op_parent_causal');
    expect(parentSynced.status).toBe('SYNCED');

    // Now child dependency MUST BE SATISFIED!
    const childOpNow = getOperation(db, COMPANY_ALPHA, 'op_child_causal');
    expect(isDependencySatisfied(db, COMPANY_ALPHA, childOpNow)).toBe(true);

    // Dispatch child
    const childDispatchRes = await dispatchOutbox(db, COMPANY_ALPHA, syncClient);
    expect(childDispatchRes.synced).toBe(1);
    expect(getOperation(db, COMPANY_ALPHA, 'op_child_causal').status).toBe('SYNCED');
  });

  // ----------------------------------------------------------------
  // 5. Mandatory Real Crash + Server-Commit Scenario (Hard Kill)
  // ----------------------------------------------------------------
  it('5. hard crash after server commit: restart recovery -> retry same operation -> server dedup -> local ACK', async () => {
    // Ensure server has model and worker seeded in PostgreSQL
    await serverPool.query(`
      INSERT INTO models (id, company_id, name, operations_json)
      VALUES ('m_test', $1, 'Test Model', '[{"name":"Bichish","rate":1000}]')
      ON CONFLICT DO NOTHING
    `, [COMPANY_ALPHA]);
    await seedServerParty();
    await serverPool.query(`
      INSERT INTO workers (id, company_id, name)
      VALUES (1, $1, 'Alisher')
      ON CONFLICT DO NOTHING
    `, [COMPANY_ALPHA]);

    const command = {
      commandId: 'cmd_crash_hard_1',
      operationId: 'op_crash_hard_1',
      companyId: COMPANY_ALPHA,
      ticketId: '00000000-0000-4000-8000-000000000303',
      modelId: 'm_test',
      partyNumber: '1',
      partyRecordId: 'party-recovery-1',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 15,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 15 }]
    };

    const childScript = path.join(__dirname, '../tests/harness/step4CrashChild.cjs');
    let killExecuted = false;

    // Spawn child worker in a real separate OS process
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          childScript,
          '--base-dir', testUserDataDir,
          '--company-id', COMPANY_ALPHA,
          '--server-url', baseUrl,
          '--token', TOKEN_ALPHA,
          '--cmd-json', JSON.stringify(command)
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      let stdoutBuffer = '';
      let stderrBuffer = '';

      const timeoutTimer = setTimeout(() => {
        if (!killExecuted) {
          killProcessTree(child.pid!);
          reject(new Error(`Timeout waiting for child crash signal. Stdout: ${stdoutBuffer}, Stderr: ${stderrBuffer}`));
        }
      }, 15000);

      child.stdout?.on('data', (data) => {
        stdoutBuffer += data.toString();
        if (!killExecuted && stdoutBuffer.includes('STEP4_CRASH_STATE=SERVER_COMMITTED_BEFORE_ACK')) {
          killExecuted = true;
          // Exact target crash state: PostgreSQL committed, but child hasn't executed local ACK transaction!
          // Execute REAL HARD PROCESS TERMINATION
          killProcessTree(child.pid!);
        }
      });

      child.stderr?.on('data', (data) => {
        stderrBuffer += data.toString();
      });

      child.on('exit', () => {
        clearTimeout(timeoutTimer);
        if (killExecuted) {
          resolve();
        } else {
          reject(new Error(`Child exited without signal. Stderr: ${stderrBuffer}, Stdout: ${stdoutBuffer}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        reject(err);
      });
    });

    expect(killExecuted).toBe(true);

    // Close any file handles from before, and inspect post-crash state
    closeAllCompanyDatabases();
    const db = getCompanyDatabase(testUserDataDir, COMPANY_ALPHA);

    // 1. Local SQLite state right after crash:
    // Outbox must still be in 'SENDING'
    const opBeforeRecovery = getOperation(db, COMPANY_ALPHA, 'op_crash_hard_1');
    expect(opBeforeRecovery.status).toBe('SENDING');
    expect(opBeforeRecovery.attempt_count).toBe(1);
    expect(opBeforeRecovery.retry_count).toBe(0);

    // Local ticket fact must still be 'PENDING_SYNC' (unconfirmed local projection)
    const ticketBefore = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get('00000000-0000-4000-8000-000000000303');
    expect(ticketBefore.status).toBe('PENDING_SYNC');

    // 2. Authoritative PostgreSQL state:
    // Server has ALREADY COMMITTED the ticket!
    const serverTickets = await serverPool.query(`
      SELECT * FROM tickets WHERE company_id = $1 AND id = $2
    `, [COMPANY_ALPHA, '00000000-0000-4000-8000-000000000303']);
    expect(serverTickets.rows.length).toBe(1);

    const serverOps = await serverPool.query(`
      SELECT * FROM operations_dedup WHERE company_id = $1 AND operation_id = $2
    `, [COMPANY_ALPHA, 'op_crash_hard_1']);
    expect(serverOps.rows.length).toBe(1);

    const changeLogsBefore = await serverPool.query(`
      SELECT * FROM change_log WHERE company_id = $1 AND operation_id = $2
    `, [COMPANY_ALPHA, 'op_crash_hard_1']);
    expect(changeLogsBefore.rows.length).toBe(1);

    // 3. Application restarts -> Run startup recovery
    const recovered = recoverStrandedSendingOperations(db, COMPANY_ALPHA);
    expect(recovered.length).toBe(1);
    expect(recovered[0].operation_id).toBe('op_crash_hard_1');

    const opAfterRecovery = getOperation(db, COMPANY_ALPHA, 'op_crash_hard_1');
    expect(opAfterRecovery.status).toBe('PENDING');
    expect(opAfterRecovery.attempt_count).toBe(1); // Not incremented on recovery!
    expect(opAfterRecovery.retry_count).toBe(0);
    expect(opAfterRecovery.last_error).toBe('RECOVERED_STRANDED_SENDING');

    // 4. Dispatcher runs retry on the SAME immutable operationId
    const syncClient = new SyncClient({ baseUrl, token: TOKEN_ALPHA });
    const retryDispatchRes = await dispatchOutbox(db, COMPANY_ALPHA, syncClient);
    expect(retryDispatchRes.attempted).toBe(1);
    expect(retryDispatchRes.synced).toBe(1);

    // 5. Local ACK transaction executed!
    const finalOp = getOperation(db, COMPANY_ALPHA, 'op_crash_hard_1');
    expect(finalOp.status).toBe('SYNCED');
    expect(finalOp.attempt_count).toBe(2); // Incremented on actual retry send!
    expect(finalOp.retry_count).toBe(1);

    // Local ticket is now CONFIRMED
    const finalTicket = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get('00000000-0000-4000-8000-000000000303');
    expect(finalTicket.status).toBe('CONFIRMED');

    // 6. Verify PostgreSQL has NO duplicate mutations or change-log entries!
    const serverTicketsAfter = await serverPool.query(`
      SELECT * FROM tickets WHERE company_id = $1 AND id = $2
    `, [COMPANY_ALPHA, '00000000-0000-4000-8000-000000000303']);
    expect(serverTicketsAfter.rows.length).toBe(1);

    const changeLogsAfter = await serverPool.query(`
      SELECT * FROM change_log WHERE company_id = $1 AND operation_id = $2
    `, [COMPANY_ALPHA, 'op_crash_hard_1']);
    expect(changeLogsAfter.rows.length).toBe(1); // Exactly ONE server change log entry!
  });
});
