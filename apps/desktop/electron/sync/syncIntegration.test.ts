import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fork } from 'node:child_process';

const { buildFastifyServer } = require('../../../server/app.cjs');
const { getServerPool, resetServerDatabase, closeServerPool } = require('../../../server/infrastructure/db.cjs');
const { getCompanyDatabase, closeCompanyDatabase, closeAllCompanyDatabases } = require('../database/databaseManager.cjs');
const { executeSubmitTicketCommand, executeRecordAdjustmentCommand } = require('../database/commandPipeline.cjs');
const { executeWorkbookCommand } = require('../database/workbookCommandPipeline.cjs');
const { getOperation, updateOperationStatus } = require('../database/outboxManager.cjs');
const { rebuildCompanyProjections } = require('../database/projectionReader.cjs');
const { SyncClient } = require('./syncClient.cjs');
const { dispatchOutbox } = require('./outboxDispatcher.cjs');
const { applyChangesBatch, getLocalCursor, setLocalCursor } = require('./changeFeedApplier.cjs');
const { executeReconnectProtocol } = require('./reconnectManager.cjs');
const { acquireAndStoreLease, consumeNextPartyNumber, getActiveLease } = require('./leaseManager.cjs');
const { loadPayrollValuationFromSqlite } = require('../database/payrollReader.cjs');
const { canonicalStringify, computePayloadHash } = require('../../../server/modules/sync/canonicalPayload.cjs');

describe('Electron Client Sync & End-to-End Integration (Step 4)', () => {
  let serverApp: any;
  let serverPool: any;
  let testUserDataDir: string;
  let serverPort = 3099;
  let baseUrl: string;

  const COMPANY_A = 'company-sync-alpha';
  const TOKEN_A = `novda-test-token:${COMPANY_A}:electron-workstation-1`;

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
    testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-sync-test-'));
  });

  afterEach(() => {
    closeAllCompanyDatabases();
    try {
      if (testUserDataDir && fs.existsSync(testUserDataDir)) {
        fs.rmSync(testUserDataDir, { recursive: true, force: true });
      }
    } catch {}
  });

  function seedCompany(companyId: string, userDataPath = testUserDataDir) {
    const db = getCompanyDatabase(userDataPath, companyId);
    db.prepare(`
      INSERT OR IGNORE INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run('m_test', companyId, 'Test Model', JSON.stringify([{ name: 'Bichish' }, { name: 'Tikish' }]));

    db.prepare(`
      INSERT OR IGNORE INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
    `).run(1, companyId, 'Worker Ali');
    const insertParty = db.prepare(`
      INSERT OR IGNORE INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'm_test', 'Test Model', 'ACTIVE', datetime('now'), datetime('now'))
    `);
    for (const partyNumber of ['1', '2', '3', '4', '10', '99']) {
      insertParty.run(`party-sync-${partyNumber}`, companyId, partyNumber, partyNumber);
    }
    return db;
  }

  async function seedServerParty(partyNumber: string) {
    await serverPool.query(
      `INSERT INTO models (id, company_id, name, operations_json)
       VALUES ('m_test', $1, 'Test Model', '[{"name":"Bichish"},{"name":"Tikish"}]')
       ON CONFLICT (company_id, id) DO NOTHING`,
      [COMPANY_A]
    );
    await serverPool.query(
      `INSERT INTO workers (id, company_id, name)
       VALUES (1, $1, 'Worker Ali')
       ON CONFLICT (company_id, id) DO NOTHING`,
      [COMPANY_A]
    );
    await serverPool.query(
      `INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status)
       VALUES ($1, $2, $3, $3, 'm_test', 'ACTIVE')`,
      [`party-sync-${partyNumber}`, COMPANY_A, partyNumber]
    );
  }

  // ----------------------------------------------------------------
  // 1-3: Outbox Dispatch, PENDING_SYNC -> CONFIRMED, and Projection Invariant
  // ----------------------------------------------------------------
  it('1. outbox dispatcher pushes PENDING ticket; server acknowledges; ticket becomes CONFIRMED', async () => {
    const dbA = seedCompany(COMPANY_A);
    await seedServerParty('1');

    // 1. Submit ticket locally in SQLite (initial state: PENDING_SYNC, outbox: PENDING)
    const cmdResult = executeSubmitTicketCommand(testUserDataDir, COMPANY_A, {
      commandId: 'cmd_sync_1',
      operationId: 'op_sync_1',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000201',
      modelId: 'm_test',
      partyNumber: '1',
      partyRecordId: 'party-sync-1',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 50,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 50 }]
    });
    expect(cmdResult.status).toBe('PENDING_SYNC');

    // Verify initial fact and outbox status
    const ticketBefore = dbA.prepare('SELECT status FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000201');
    expect(ticketBefore.status).toBe('PENDING_SYNC');

    const outboxBefore = getOperation(dbA, COMPANY_A, 'op_sync_1');
    expect(outboxBefore.status).toBe('PENDING');

    // 2. Initial projections: optimistic includes 50; accounting EXCLUDES (0)
    const projBefore = rebuildCompanyProjections(testUserDataDir, COMPANY_A);
    expect(projBefore.optimistic['m_test']?.[1]?.['Bichish']).toBe(50);
    expect(projBefore.accounting['m_test']?.[1]?.['Bichish'] || 0).toBe(0);

    // 3. Dispatch outbox to authoritative server
    const syncClient = new SyncClient({ baseUrl, token: TOKEN_A });
    const dispatchResult = await dispatchOutbox(dbA, COMPANY_A, syncClient, { baseUserDataPath: testUserDataDir });
    expect(dispatchResult.attempted).toBe(1);
    expect(dispatchResult.synced).toBe(1);
    expect(dispatchResult.conflict).toBe(0);
    expect(dispatchResult.deadLetter).toBe(0);

    // 4. Verify post-sync fact and outbox status
    const ticketAfter = dbA.prepare('SELECT status FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000201');
    expect(ticketAfter.status).toBe('CONFIRMED');

    const outboxAfter = getOperation(dbA, COMPANY_A, 'op_sync_1');
    expect(outboxAfter.status).toBe('SYNCED');

    // 5. Post-sync projections: accounting NOW INCLUDES 50!
    const projAfter = rebuildCompanyProjections(testUserDataDir, COMPANY_A);
    expect(projAfter.optimistic['m_test']?.[1]?.['Bichish']).toBe(50);
    expect(projAfter.accounting['m_test']?.[1]?.['Bichish']).toBe(50);
  });

  it('offline command survives SQLite restart, reconnects through the server handler, and reconciles expected payroll once', async () => {
    const db = seedCompany(COMPANY_A);
    db.prepare('UPDATE models SET operations_json = ? WHERE company_id = ? AND id = ?')
      .run(JSON.stringify([{ name: 'Bichish', rate: 7 }, { name: 'Tikish', rate: 3 }]), COMPANY_A, 'm_test');
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, end_date, is_closed, status, created_at)
      VALUES ('offline-P', ?, 'Offline P', '2026-09-01', '2026-09-30', 0, 'OPEN', '2026-09-01')`).run(COMPANY_A);
    await seedServerParty('1');
    await serverPool.query(`INSERT INTO periods(id, company_id, start_date, end_date, is_closed)
      VALUES ('offline-P', $1, '2026-09-01', '2026-09-30', 0)`, [COMPANY_A]);

    const command = {
      commandId: 'cmd_offline_acceptance', operationId: 'op_offline_acceptance', companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000221', modelId: 'm_test', periodId: 'offline-P',
      partyNumber: '1', partyRecordId: 'party-sync-1', effectiveDate: '2026-09-15',
      submittedAt: '2026-09-15T12:00:00.000Z', pattaNumber: 1, qty: 15,
      entries: [{ opName: 'Bichish', workerId: 1, rateSnapshot: null }]
    };
    expect(executeSubmitTicketCommand(testUserDataDir, COMPANY_A, command).committed).toBe(true);
    const original = getOperation(db, COMPANY_A, command.operationId);
    const expectedMoney = 15 * 7;
    expect(loadPayrollValuationFromSqlite(db, COMPANY_A, 'offline-P').workers[0])
      .toMatchObject({ gross: expectedMoney, syncStatus: 'UNSYNCED' });

    closeAllCompanyDatabases();
    const reopened = getCompanyDatabase(testUserDataDir, COMPANY_A);
    expect(getOperation(reopened, COMPANY_A, command.operationId)).toMatchObject({
      status: 'PENDING', payload_json: original.payload_json, payload_hash: original.payload_hash
    });
    const client = new SyncClient({ baseUrl, token: TOKEN_A });
    const reconnect = await executeReconnectProtocol(reopened, COMPANY_A, client, { baseUserDataPath: testUserDataDir });
    expect(reconnect.success).toBe(true);
    expect(reconnect.pushed.synced).toBe(1);

    const serverTicket = await serverPool.query(`SELECT qty, status FROM tickets WHERE company_id = $1 AND id = $2`,
      [COMPANY_A, command.ticketId]);
    const serverEntries = await serverPool.query(`SELECT qty FROM ticket_entries WHERE company_id = $1 AND ticket_id = $2`,
      [COMPANY_A, command.ticketId]);
    const serverDedup = await serverPool.query(`SELECT COUNT(*) FROM operations_dedup WHERE company_id = $1 AND operation_id = $2`,
      [COMPANY_A, command.operationId]);
    expect(serverTicket.rows).toHaveLength(1);
    expect(Number(serverTicket.rows[0].qty)).toBe(15);
    expect(serverTicket.rows[0].status).toBe('CONFIRMED');
    expect(serverEntries.rows.map((row: any) => Number(row.qty))).toEqual([15]);
    expect(Number(serverDedup.rows[0].count)).toBe(1);
    expect(loadPayrollValuationFromSqlite(reopened, COMPANY_A, 'offline-P').workers[0])
      .toMatchObject({ gross: expectedMoney, syncStatus: 'UNKNOWN' });

    const replay = await executeReconnectProtocol(reopened, COMPANY_A, client, { baseUserDataPath: testUserDataDir });
    expect(replay.success).toBe(true);
    expect(replay.pushed.attempted).toBe(0);
    expect(loadPayrollValuationFromSqlite(reopened, COMPANY_A, 'offline-P').workers[0].gross).toBe(expectedMoney);
    expect(Number((await serverPool.query(`SELECT COUNT(*) FROM tickets WHERE company_id = $1 AND id = $2`,
      [COMPANY_A, command.ticketId])).rows[0].count)).toBe(1);
    expect(Number((await serverPool.query(`SELECT COUNT(*) FROM operations_dedup WHERE company_id = $1 AND operation_id = $2`,
      [COMPANY_A, command.operationId])).rows[0].count)).toBe(1);
  });

  it('retains a stale local edit as CONFLICT while payroll and replay preserve the newer server revision', async () => {
    const db = seedCompany(COMPANY_A);
    db.prepare('UPDATE models SET operations_json = ? WHERE company_id = ? AND id = ?')
      .run(JSON.stringify([{ name: 'Bichish', rate: 7 }, { name: 'Tikish', rate: 3 }]), COMPANY_A, 'm_test');
    const now = '2026-09-15T12:00:00.000Z';
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (2, ?, 'Worker newer server', ?, ?), (3, ?, 'Worker local edit', ?, ?)`)
      .run(COMPANY_A, now, now, COMPANY_A, now, now);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, end_date, is_closed, status, created_at)
      VALUES ('conflict-P', ?, 'Conflict P', '2026-09-01', '2026-09-30', 0, 'OPEN', ?)`).run(COMPANY_A, now);
    await seedServerParty('1');
    await serverPool.query(`INSERT INTO workers (id, company_id, name, status)
      VALUES (2, $1, 'Worker newer server', 'ACTIVE'), (3, $1, 'Worker local edit', 'ACTIVE')`, [COMPANY_A]);
    await serverPool.query(`INSERT INTO periods(id, company_id, start_date, end_date, is_closed)
      VALUES ('conflict-P', $1, '2026-09-01', '2026-09-30', 0)`, [COMPANY_A]);

    const ticketId = '00000000-0000-4000-8000-000000000222';
    const submit = { commandId: 'cmd_conflict_submit', operationId: 'op_conflict_submit', companyId: COMPANY_A,
      ticketId, modelId: 'm_test', periodId: 'conflict-P', partyNumber: '1', partyRecordId: 'party-sync-1',
      effectiveDate: '2026-09-15', submittedAt: now, pattaNumber: 1, qty: 15,
      entries: [{ opName: 'Bichish', workerId: 1, rateSnapshot: null }] };
    executeSubmitTicketCommand(testUserDataDir, COMPANY_A, submit);
    const client = new SyncClient({ baseUrl, token: TOKEN_A });
    expect(await dispatchOutbox(db, COMPANY_A, client, { baseUserDataPath: testUserDataDir }))
      .toMatchObject({ attempted: 1, synced: 1 });
    expect(loadPayrollValuationFromSqlite(db, COMPANY_A, 'conflict-P').workers[0].gross).toBe(105);

    const localEdit = { commandType: 'UpdateTicket', commandId: 'cmd_local_stale_edit',
      operationId: 'op_local_stale_edit', companyId: COMPANY_A, entityId: ticketId, baseRevision: 1,
      payload: { ticketId, entries: [{ opName: 'Bichish', workerId: 3 }] } };
    expect(executeWorkbookCommand(testUserDataDir, COMPANY_A, localEdit)).toMatchObject({ committed: true, status: 'PENDING_SYNC' });
    const localOperation = getOperation(db, COMPANY_A, localEdit.operationId);
    const originalLocalPayload = localOperation.payload_json;
    const originalLocalHash = localOperation.payload_hash;
    const expectedMoney = 15 * 7;
    expect(loadPayrollValuationFromSqlite(db, COMPANY_A, 'conflict-P').workers
      .find((worker: any) => worker.workerId === 3)).toMatchObject({ gross: expectedMoney, syncStatus: 'UNSYNCED' });

    // A separate accepted operation advances the actual server ticket to revision 2.
    const serverEntryId = (await serverPool.query(`SELECT id FROM ticket_entries WHERE company_id = $1 AND ticket_id = $2`,
      [COMPANY_A, ticketId])).rows[0].id;
    const remotePayload = { commandId: 'cmd_server_newer_edit', operationId: 'op_server_newer_edit',
      companyId: COMPANY_A, ticketId, baseRevision: 1,
      entries: [{ entryId: serverEntryId, opName: 'Bichish', workerId: 2 }] };
    const remoteJson = canonicalStringify(remotePayload);
    const remotePush = await client.pushOperations([{ operationId: remotePayload.operationId, companyId: COMPANY_A,
      commandType: 'UpdateTicket', entityType: 'ticket', entityId: ticketId, baseRevision: 1,
      payloadHash: computePayloadHash(remoteJson), payload: remotePayload }]);
    expect(remotePush.results[0]).toMatchObject({ status: 'APPLIED', serverRevision: 2 });

    closeAllCompanyDatabases();
    const reopened = getCompanyDatabase(testUserDataDir, COMPANY_A);
    expect(getOperation(reopened, COMPANY_A, localEdit.operationId)).toMatchObject({
      status: 'PENDING', payload_json: originalLocalPayload
    });
    const recovered = await executeReconnectProtocol(reopened, COMPANY_A, client, { baseUserDataPath: testUserDataDir });
    expect(recovered.success).toBe(true);
    expect(getOperation(reopened, COMPANY_A, localEdit.operationId)).toMatchObject({
      status: 'CONFLICT', payload_json: originalLocalPayload, payload_hash: originalLocalHash
    });
    expect(JSON.parse(getOperation(reopened, COMPANY_A, localEdit.operationId).last_error))
      .toMatchObject({ code: 'REVISION_CONFLICT', message: expect.stringContaining('current revision is 2') });
    expect(reopened.prepare('SELECT server_revision FROM tickets WHERE company_id=? AND id=?').get(COMPANY_A, ticketId)
      .server_revision).toBe(2);
    expect(reopened.prepare('SELECT worker_id, qty FROM ticket_entries WHERE company_id=? AND ticket_id=?')
      .all(COMPANY_A, ticketId)).toEqual([{ worker_id: 2, qty: 15 }]);

    const payroll = loadPayrollValuationFromSqlite(reopened, COMPANY_A, 'conflict-P');
    expect(payroll.workers.find((worker: any) => worker.workerId === 2))
      .toMatchObject({ gross: expectedMoney, syncStatus: 'UNSYNCED', accountingStatus: 'INCOMPLETE' });
    expect(payroll.workers.find((worker: any) => worker.workerId === 3)?.gross || 0).toBe(0);
    expect(payroll.acceptanceEvidence[ticketId]).toBeNull();

    const serverTicket = await serverPool.query('SELECT qty, server_revision FROM tickets WHERE company_id=$1 AND id=$2',
      [COMPANY_A, ticketId]);
    const serverEntries = await serverPool.query('SELECT worker_id, qty FROM ticket_entries WHERE company_id=$1 AND ticket_id=$2',
      [COMPANY_A, ticketId]);
    const serverDedup = await serverPool.query('SELECT COUNT(*) FROM operations_dedup WHERE company_id=$1 AND operation_id=$2',
      [COMPANY_A, remotePayload.operationId]);
    expect(serverTicket.rows).toHaveLength(1);
    expect(Number(serverTicket.rows[0].qty)).toBe(15);
    expect(Number(serverTicket.rows[0].server_revision)).toBe(2);
    expect(serverEntries.rows.map((row: any) => ({ worker_id: Number(row.worker_id), qty: Number(row.qty) })))
      .toEqual([{ worker_id: 2, qty: 15 }]);
    expect(Number(serverDedup.rows[0].count)).toBe(1);

    const replay = await executeReconnectProtocol(reopened, COMPANY_A, client, { baseUserDataPath: testUserDataDir });
    expect(replay.success).toBe(true);
    expect(replay.pushed.attempted).toBe(0);
    expect(getOperation(reopened, COMPANY_A, localEdit.operationId).payload_json).toBe(originalLocalPayload);
    expect(reopened.prepare('SELECT worker_id, qty FROM ticket_entries WHERE company_id=? AND ticket_id=?')
      .all(COMPANY_A, ticketId)).toEqual([{ worker_id: 2, qty: 15 }]);
    expect(loadPayrollValuationFromSqlite(reopened, COMPANY_A, 'conflict-P').workers
      .find((worker: any) => worker.workerId === 2)).toMatchObject({ gross: expectedMoney, syncStatus: 'UNSYNCED' });
    expect(Number((await serverPool.query('SELECT COUNT(*) FROM tickets WHERE company_id=$1 AND id=$2',
      [COMPANY_A, ticketId])).rows[0].count)).toBe(1);
    expect(Number((await serverPool.query('SELECT COUNT(*) FROM operations_dedup WHERE company_id=$1 AND operation_id=$2',
      [COMPANY_A, remotePayload.operationId])).rows[0].count)).toBe(1);
  });

  it('races two isolated SQLite clients at the same ticket revision and converges without losing independent work', async () => {
    const secondClientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-sync-client-b-'));
    const worker = fork(path.join(process.cwd(), 'apps/desktop/electron/sync/twoClientAcceptanceWorker.cjs'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: process.env
    });
    let requestNumber = 0;
    const responses = new Map<number, { resolve: (message: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    let resolveRaceReady: (() => void) | null = null;
    worker.on('message', (message: any) => {
      if (message.type === 'raceReady') resolveRaceReady?.();
      if (message.type === 'response') {
        const callbacks = responses.get(message.requestId);
        if (!callbacks) return;
        responses.delete(message.requestId);
        clearTimeout(callbacks.timer);
        if (message.error) callbacks.reject(new Error(message.error.stack || message.error.message));
        else callbacks.resolve(message.result);
      }
    });
    worker.on('exit', code => {
      if (code === 0) return;
      for (const callbacks of responses.values()) callbacks.reject(new Error(`two-client worker exited with ${code}`));
      responses.clear();
    });
    const requestWorker = (action: string, payload = {}) => new Promise<any>((resolve, reject) => {
      const requestId = ++requestNumber;
      const timer = setTimeout(() => {
        responses.delete(requestId);
        reject(new Error(`two-client worker request timed out: ${action}`));
      }, 10000);
      responses.set(requestId, { resolve, reject, timer });
      worker.send({ requestId, action, payload }, error => {
        if (error) { clearTimeout(timer); responses.delete(requestId); reject(error); }
      });
    });
    try {
      let dbA = seedCompany(COMPANY_A);
      const now = '2026-09-15T12:00:00.000Z';
      const modelRates = JSON.stringify([{ name: 'Bichish', rate: 7 }, { name: 'Tikish', rate: 3 }]);
      dbA.prepare('UPDATE models SET operations_json = ? WHERE company_id = ? AND id = ?').run(modelRates, COMPANY_A, 'm_test');
      dbA.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at)
        VALUES (2, ?, 'Worker two', ?, ?), (3, ?, 'Worker three', ?, ?)`)
        .run(COMPANY_A, now, now, COMPANY_A, now, now);
      dbA.prepare(`INSERT INTO periods (id, company_id, name, start_date, end_date, is_closed, status, created_at)
        VALUES ('race-P', ?, 'Race P', '2026-09-01', '2026-09-30', 0, 'OPEN', ?)`).run(COMPANY_A, now);
      dbA.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name,
        status, created_at, updated_at) VALUES ('party-sync-20', ?, '20', '20', 'm_test', 'Test Model', 'ACTIVE', ?, ?),
        ('party-sync-21', ?, '21', '21', 'm_test', 'Test Model', 'ACTIVE', ?, ?)`)
        .run(COMPANY_A, now, now, COMPANY_A, now, now);
      await seedServerParty('1');
      await seedServerParty('20');
      await seedServerParty('21');
      await serverPool.query(`INSERT INTO workers (id, company_id, name, status)
        VALUES (2, $1, 'Worker two', 'ACTIVE'), (3, $1, 'Worker three', 'ACTIVE')`, [COMPANY_A]);
      await serverPool.query(`INSERT INTO periods(id, company_id, start_date, end_date, is_closed)
        VALUES ('race-P', $1, '2026-09-01', '2026-09-30', 0)`, [COMPANY_A]);

      const clientA = new SyncClient({ baseUrl, token: TOKEN_A });
      await requestWorker('init', { directory: secondClientDir, companyId: COMPANY_A, baseUrl,
        token: `novda-test-token:${COMPANY_A}:electron-workstation-2` });
      const ticketId = '00000000-0000-4000-8000-000000000223';
      const submit = { commandId: 'cmd_race_submit', operationId: 'op_race_submit', companyId: COMPANY_A,
        ticketId, modelId: 'm_test', periodId: 'race-P', partyNumber: '1', partyRecordId: 'party-sync-1',
        effectiveDate: '2026-09-15', submittedAt: now, pattaNumber: 1, qty: 15,
        entries: [{ opName: 'Bichish', workerId: 1, rateSnapshot: null }] };
      executeSubmitTicketCommand(testUserDataDir, COMPANY_A, submit);
      expect(await dispatchOutbox(dbA, COMPANY_A, clientA, { baseUserDataPath: testUserDataDir }))
        .toMatchObject({ attempted: 1, synced: 1 });
      const clientBStart = await requestWorker('reconnect');
      expect(clientBStart.success).toBe(true);
      expect((await requestWorker('snapshot', { ticketId, operationId: 'op_race_B' })).ticket)
        .toMatchObject({ server_revision: 1, status: 'CONFIRMED' });

      const updateA = { commandType: 'UpdateTicket', commandId: 'cmd_race_A', operationId: 'op_race_A',
        companyId: COMPANY_A, entityId: ticketId, baseRevision: 1,
        payload: { ticketId, entries: [{ opName: 'Bichish', workerId: 2 }] } };
      const updateB = { commandType: 'UpdateTicket', commandId: 'cmd_race_B', operationId: 'op_race_B',
        companyId: COMPANY_A, entityId: ticketId, baseRevision: 1,
        payload: { ticketId, entries: [{ opName: 'Bichish', workerId: 3 }] } };
      executeWorkbookCommand(testUserDataDir, COMPANY_A, updateA);
      await requestWorker('edit', updateB);
      const pendingA = getOperation(dbA, COMPANY_A, updateA.operationId);
      const pendingB = (await requestWorker('snapshot', { ticketId, operationId: updateB.operationId })).operation;
      expect(pendingA.base_revision).toBe(1);
      expect(pendingB.base_revision).toBe(1);
      const payloads = [pendingA.payload_json, pendingB.payload_json];

      let openParentGate!: () => void;
      let resolveParentReady!: () => void;
      const parentGate = new Promise<void>(resolve => { openParentGate = resolve; });
      const parentReady = new Promise<void>(resolve => { resolveParentReady = resolve; });
      let resolveWorkerReady!: () => void;
      const workerReady = new Promise<void>(resolve => { resolveWorkerReady = resolve; });
      resolveRaceReady = resolveWorkerReady;
      const raceARequest = dispatchOutbox(dbA, COMPANY_A, { pushOperations: async operations => {
        resolveParentReady();
        await parentGate;
        return clientA.pushOperations(operations);
      } }, { baseUserDataPath: testUserDataDir });
      const gatedRequestId = requestNumber + 1;
      const raceBRequest = requestWorker('dispatchGated');
      await Promise.race([Promise.all([parentReady, workerReady]), new Promise((_, reject) =>
        setTimeout(() => reject(new Error('same-ticket race barrier did not receive both clients')), 10000))]);
      resolveRaceReady = null;
      openParentGate();
      await requestWorker('release', { targetRequestId: gatedRequestId });
      const [raceA, raceB] = await Promise.all([raceARequest, raceBRequest]);
      expect([raceA.synced + raceB.synced, raceA.conflict + raceB.conflict]).toEqual([1, 1]);
      const operationAAfterRace = getOperation(dbA, COMPANY_A, updateA.operationId);
      const operationBAfterRace = (await requestWorker('snapshot', { ticketId, operationId: updateB.operationId })).operation;
      expect([operationAAfterRace.status, operationBAfterRace.status].sort()).toEqual(['CONFLICT', 'SYNCED']);
      const winnerIsA = operationAAfterRace.status === 'SYNCED';
      const winnerWorkerId = winnerIsA ? 2 : 3;
      const loserOperation = winnerIsA ? operationBAfterRace : operationAAfterRace;
      const loserPayload = winnerIsA ? payloads[1] : payloads[0];
      expect(loserOperation.payload_json).toBe(loserPayload);
      expect(JSON.parse(loserOperation.last_error).code).toBe('REVISION_CONFLICT');

      // Concurrent-independent work from both clients is not causally tied to the ticket race.
      const independentA = { commandId: 'cmd_independent_A', operationId: 'op_independent_A', companyId: COMPANY_A,
        ticketId: '00000000-0000-4000-8000-000000000224', modelId: 'm_test', periodId: 'race-P',
        partyNumber: '20', partyRecordId: 'party-sync-20', effectiveDate: '2026-09-15', submittedAt: now,
        pattaNumber: 1, qty: 2, entries: [{ opName: 'Bichish', workerId: 1, rateSnapshot: null }] };
      const independentB = { commandId: 'cmd_independent_B', operationId: 'op_independent_B', companyId: COMPANY_A,
        ticketId: '00000000-0000-4000-8000-000000000225', modelId: 'm_test', periodId: 'race-P',
        partyNumber: '21', partyRecordId: 'party-sync-21', effectiveDate: '2026-09-15', submittedAt: now,
        pattaNumber: 1, qty: 3, entries: [{ opName: 'Tikish', workerId: 1, rateSnapshot: null }] };
      executeSubmitTicketCommand(testUserDataDir, COMPANY_A, independentA);
      await requestWorker('submit', independentB);
      const independentResults = await Promise.all([
        dispatchOutbox(dbA, COMPANY_A, clientA, { baseUserDataPath: testUserDataDir }),
        requestWorker('dispatch')
      ]);
      expect(independentResults.map((result: any) => result.synced)).toEqual([1, 1]);

      const outcome = (payroll: any) => payroll.workers.map((worker: any) => ({
        workerId: worker.workerId, gross: worker.gross, pieces: worker.pieces
      }));

      const persistedTicket = await serverPool.query('SELECT qty, server_revision FROM tickets WHERE company_id=$1 AND id=$2',
        [COMPANY_A, ticketId]);
      const persistedRaceEntries = await serverPool.query('SELECT worker_id, qty FROM ticket_entries WHERE company_id=$1 AND ticket_id=$2',
        [COMPANY_A, ticketId]);
      const persistedWork = await serverPool.query(`SELECT t.id, t.qty AS ticket_qty, e.op_name, e.worker_id, e.qty AS entry_qty
        FROM tickets t JOIN ticket_entries e ON e.company_id=t.company_id AND e.ticket_id=t.id
        WHERE t.company_id=$1 AND t.id = ANY($2::varchar[]) ORDER BY t.id`,
        [COMPANY_A, [ticketId, independentA.ticketId, independentB.ticketId]]);
      const ticketCount = await serverPool.query('SELECT COUNT(*) FROM tickets WHERE company_id=$1 AND id = ANY($2::varchar[])',
        [COMPANY_A, [ticketId, independentA.ticketId, independentB.ticketId]]);
      const raceDedup = await serverPool.query('SELECT operation_id FROM operations_dedup WHERE company_id=$1 AND operation_id = ANY($2::varchar[])',
        [COMPANY_A, [updateA.operationId, updateB.operationId]]);
      expect(persistedTicket.rows).toHaveLength(1);
      expect(Number(persistedTicket.rows[0].qty)).toBe(15);
      expect(Number(persistedTicket.rows[0].server_revision)).toBe(2);
      expect(persistedRaceEntries.rows.map((row: any) => ({ worker_id: Number(row.worker_id), qty: Number(row.qty) })))
        .toEqual([{ worker_id: winnerWorkerId, qty: 15 }]);
      expect(Number(ticketCount.rows[0].count)).toBe(3);
      expect(persistedWork.rows.map((row: any) => ({ id: row.id, qty: Number(row.ticket_qty), op: row.op_name,
        worker: Number(row.worker_id), workQty: Number(row.entry_qty) }))).toEqual([
        { id: independentA.ticketId, qty: 2, op: 'Bichish', worker: 1, workQty: 2 },
        { id: independentB.ticketId, qty: 3, op: 'Tikish', worker: 1, workQty: 3 },
        { id: ticketId, qty: 15, op: 'Bichish', worker: winnerWorkerId, workQty: 15 }
      ].sort((left, right) => left.id.localeCompare(right.id)));
      expect(raceDedup.rows.map((row: any) => row.operation_id)).toEqual([winnerIsA ? updateA.operationId : updateB.operationId]);
      expect(getOperation(dbA, COMPANY_A, independentA.operationId).status).toBe('SYNCED');
      expect((await requestWorker('snapshot', { ticketId: independentB.ticketId, operationId: independentB.operationId }))
        .operation.status).toBe('SYNCED');

      // Client A refreshes the accepted source, then records a +2 source-linked correction
      // while client B remains on its pre-race feed cursor and has its local edit conflict.
      await executeReconnectProtocol(dbA, COMPANY_A, clientA, { baseUserDataPath: testUserDataDir });
      const sourceEntry = await serverPool.query(`SELECT id, worker_id, rate_snapshot FROM ticket_entries
        WHERE company_id=$1 AND ticket_id=$2`, [COMPANY_A, ticketId]);
      expect(Number(sourceEntry.rows[0].worker_id)).toBe(winnerWorkerId);
      const closedTicketId = '00000000-0000-4000-8000-000000000226';
      const closedNow = '2026-09-15T12:00:00.000Z';
      const closingArchive = { period: { id: 'closed-Q', companyId: COMPANY_A },
        models: [{ id: 'm_test', name: 'Test Model', operations: [
          { name: 'Bichish', rate: 11 }, { name: 'Tikish', rate: 4 }
        ] }] };
      const closingArchiveJson = canonicalStringify(closingArchive);
      dbA.prepare(`INSERT INTO periods (id, company_id, name, start_date, end_date, is_closed, status, server_revision, created_at)
        VALUES ('closed-Q', ?, 'Closed Q', '2026-08-01', '2026-08-31', 1, 'CLOSED', 1, ?)`)
        .run(COMPANY_A, closedNow);
      dbA.prepare(`INSERT INTO period_archives(company_id, period_id, archive_json, sha256, archived_at)
        VALUES (?, 'closed-Q', ?, ?, ?)`)
        .run(COMPANY_A, closingArchiveJson, computePayloadHash(canonicalStringify(closingArchive)), closedNow);
      dbA.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name,
        status, created_at, updated_at) VALUES ('party-sync-30', ?, '30', '30', 'm_test', 'Test Model', 'ACTIVE', ?, ?)`)
        .run(COMPANY_A, closedNow, closedNow);
      dbA.prepare(`INSERT INTO tickets (id, company_id, model_id, period_id, party_number, party_record_id,
        patta_number, qty, status, is_closed, submitted_at, created_at, provenance, server_revision)
        VALUES (?, ?, 'm_test', 'closed-Q', '30', 'party-sync-30', 1, 4, 'CONFIRMED', 1, ?, ?, 'REMOTE_SYNC', 1)`)
        .run(closedTicketId, COMPANY_A, closedNow, closedNow);
      dbA.prepare(`INSERT INTO ticket_entries(id, ticket_id, company_id, op_name, worker_id, rate_snapshot, qty, created_at)
        VALUES ('entry_closed_source', ?, ?, 'Bichish', ?, NULL, 4, ?)`)
        .run(closedTicketId, COMPANY_A, winnerWorkerId, closedNow);
      await seedServerParty('30');
      await serverPool.query(`INSERT INTO periods(id, company_id, start_date, end_date, is_closed)
        VALUES ('closed-Q', $1, '2026-08-01', '2026-08-31', 1)`, [COMPANY_A]);
      await serverPool.query(`INSERT INTO tickets(id, company_id, model_id, period_id, party_number, party_record_id,
        patta_number, qty, status, is_closed, submitted_at, server_revision)
        VALUES ($1, $2, 'm_test', 'closed-Q', '30', 'party-sync-30', 1, 4, 'CONFIRMED', 1, $3, 1)`,
        [closedTicketId, COMPANY_A, closedNow]);
      await serverPool.query(`INSERT INTO ticket_entries(id, ticket_id, company_id, op_name, worker_id, rate_snapshot, qty)
        VALUES ('entry_closed_source', $1, $2, 'Bichish', $3, NULL, 4)`, [closedTicketId, COMPANY_A, winnerWorkerId]);
      await requestWorker('seedClosedSource', { workerId: winnerWorkerId });

      expect(executeRecordAdjustmentCommand(testUserDataDir, COMPANY_A, {
        commandId: 'cmd_source_correction_A', operationId: 'op_source_correction_A', companyId: COMPANY_A,
        adjustmentId: 'adj_source_correction_A', modelId: 'm_test', workerId: winnerWorkerId,
        opName: 'Bichish', deltaQty: 2, reason: 'Source-linked local correction', createdBy: 'fixture-operator',
        effectiveDate: '2026-09-16', createdAt: '2026-09-16T12:00:00.000Z',
        originalTicketId: ticketId, originalEntryId: sourceEntry.rows[0].id
      })).toMatchObject({ committed: true, status: 'APPROVED' });
      const localCorrection = dbA.prepare(`SELECT original_ticket_id, original_entry_id, original_period_id,
        original_rate_snapshot, attribution_status FROM production_adjustments WHERE adjustment_id=?`)
        .get('adj_source_correction_A');
      expect(localCorrection).toEqual({ original_ticket_id: ticketId, original_entry_id: sourceEntry.rows[0].id,
        original_period_id: 'race-P', original_rate_snapshot: null, attribution_status: 'RESOLVED' });
      expect(executeRecordAdjustmentCommand(testUserDataDir, COMPANY_A, {
        commandId: 'cmd_closed_source_correction_A', operationId: 'op_closed_source_correction_A', companyId: COMPANY_A,
        adjustmentId: 'adj_closed_source_correction_A', modelId: 'm_test', workerId: winnerWorkerId,
        opName: 'Bichish', deltaQty: 2, reason: 'Closed-period source-linked correction', createdBy: 'fixture-operator',
        effectiveDate: '2026-09-16', createdAt: '2026-09-16T12:00:00.000Z',
        originalTicketId: closedTicketId, originalEntryId: 'entry_closed_source'
      })).toMatchObject({ committed: true, status: 'APPROVED' });
      expect(dbA.prepare(`SELECT original_period_id, original_rate_snapshot, attribution_status FROM production_adjustments
        WHERE adjustment_id='adj_closed_source_correction_A'`).get()).toEqual({
        original_period_id: 'closed-Q', original_rate_snapshot: null, attribution_status: 'RESOLVED'
      });
      expect(await dispatchOutbox(dbA, COMPANY_A, clientA, { baseUserDataPath: testUserDataDir }))
        .toMatchObject({ attempted: 2, synced: 2 });
      await executeReconnectProtocol(dbA, COMPANY_A, clientA, { baseUserDataPath: testUserDataDir });

      const serverCorrections = await serverPool.query(`SELECT adjustment_id, delta_qty, original_ticket_id, original_entry_id,
        original_period_id, original_rate_snapshot, attribution_status FROM production_adjustments
        WHERE company_id=$1 AND adjustment_id IN ('adj_source_correction_A','adj_closed_source_correction_A')
        ORDER BY adjustment_id`, [COMPANY_A]);
      expect(serverCorrections.rows.map((row: any) => ({ ...row, delta_qty: Number(row.delta_qty) }))).toEqual([
        { adjustment_id: 'adj_closed_source_correction_A', delta_qty: 2, original_ticket_id: closedTicketId,
          original_entry_id: 'entry_closed_source', original_period_id: 'closed-Q', original_rate_snapshot: null,
          attribution_status: 'RESOLVED' },
        { adjustment_id: 'adj_source_correction_A', delta_qty: 2, original_ticket_id: ticketId,
          original_entry_id: sourceEntry.rows[0].id, original_period_id: 'race-P', original_rate_snapshot: null,
          attribution_status: 'RESOLVED' }
      ]);
      const persistedSources = await serverPool.query(`SELECT t.id, t.period_id, t.qty AS ticket_qty, e.worker_id, e.qty AS entry_qty
        FROM tickets t JOIN ticket_entries e ON e.company_id=t.company_id AND e.ticket_id=t.id
        WHERE t.company_id=$1 AND t.id = ANY($2::varchar[]) ORDER BY t.id`,
        [COMPANY_A, [ticketId, closedTicketId]]);
      expect(persistedSources.rows.map((row: any) => ({ id: row.id, period: row.period_id,
        ticketQty: Number(row.ticket_qty), worker: Number(row.worker_id), entryQty: Number(row.entry_qty) }))).toEqual([
        { id: ticketId, period: 'race-P', ticketQty: 15, worker: winnerWorkerId, entryQty: 15 },
        { id: closedTicketId, period: 'closed-Q', ticketQty: 4, worker: winnerWorkerId, entryQty: 4 }
      ].sort((left, right) => left.id.localeCompare(right.id)));

      const persistedAOpenCorrection = getOperation(dbA, COMPANY_A, 'op_source_correction_A');
      const persistedAClosedCorrection = getOperation(dbA, COMPANY_A, 'op_closed_source_correction_A');
      const cursorABeforeRestart = getLocalCursor(dbA);
      closeCompanyDatabase(COMPANY_A);
      dbA = getCompanyDatabase(testUserDataDir, COMPANY_A);
      expect(getLocalCursor(dbA)).toBe(cursorABeforeRestart);
      expect(getOperation(dbA, COMPANY_A, 'op_source_correction_A')).toMatchObject({
        status: 'SYNCED', payload_json: persistedAOpenCorrection.payload_json, payload_hash: persistedAOpenCorrection.payload_hash
      });
      expect(getOperation(dbA, COMPANY_A, 'op_closed_source_correction_A')).toMatchObject({
        status: 'SYNCED', payload_json: persistedAClosedCorrection.payload_json, payload_hash: persistedAClosedCorrection.payload_hash
      });
      const cursorBBeforeRestart = (await requestWorker('contextSnapshot', { companyId: COMPANY_A })).cursor;
      expect((await requestWorker('restartLocalDatabase')).cursor).toBe(cursorBBeforeRestart);

      // Delay an actual server feed page after HTTP completion, change the client's
      // active company/session generation, then let the old response resume.
      const nextCompany = 'company-sync-beta';
      await requestWorker('prepareContext', { companyId: nextCompany, marker: 'beta-before-old-response' });
      const oldContextBefore = await requestWorker('contextSnapshot', { companyId: COMPANY_A });
      const newContextBefore = await requestWorker('contextSnapshot', { companyId: nextCompany });
      let resolveDelayedPull!: (notice: any) => void;
      const delayedPull = new Promise<any>(resolve => { resolveDelayedPull = resolve; });
      let delayedRequestId: number | null = null;
      const onDelayedPull = (message: any) => {
        if (message.type === 'delayedPullReady' && message.requestId === delayedRequestId) resolveDelayedPull(message);
      };
      worker.on('message', onDelayedPull);
      delayedRequestId = requestNumber + 1;
      const staleReconnect = requestWorker('reconnectDelayed');
      const heldResponse = await Promise.race([delayedPull, new Promise((_, reject) =>
        setTimeout(() => reject(new Error('actual feed response was not held at context fence')), 10000))]);
      expect(heldResponse.itemCount).toBeGreaterThan(0);
      expect(heldResponse.entityTypes).toContain('production_adjustment');
      await requestWorker('switchContext', { companyId: nextCompany });
      await requestWorker('releasePull', { targetRequestId: delayedRequestId });
      expect(await staleReconnect).toEqual({ error: 'SYNC_CONTEXT_CHANGED' });
      worker.off('message', onDelayedPull);
      expect(await requestWorker('contextSnapshot', { companyId: COMPANY_A })).toEqual(oldContextBefore);
      expect(await requestWorker('contextSnapshot', { companyId: nextCompany })).toEqual(newContextBefore);

      // A new intentional A context reconnects B; it sees the correction without re-entry.
      await requestWorker('switchContext', { companyId: COMPANY_A });
      const finalReconnect = await requestWorker('reconnect');
      expect(finalReconnect.success).toBe(true);
      expect(finalReconnect.pushed.attempted).toBe(0);
      const expectedByWorker = [
        { workerId: 1, gross: 23, pieces: 5 },
        { workerId: 2, gross: winnerWorkerId === 2 ? 119 : 0, pieces: winnerWorkerId === 2 ? 17 : 0 },
        { workerId: 3, gross: winnerWorkerId === 3 ? 119 : 0, pieces: winnerWorkerId === 3 ? 17 : 0 }
      ];
      const payrollA = loadPayrollValuationFromSqlite(dbA, COMPANY_A, 'race-P');
      const payrollB = await requestWorker('payroll');
      expect(outcome(payrollA)).toEqual(expectedByWorker);
      expect(outcome(payrollB)).toEqual(expectedByWorker);
      expect(payrollA.workers.reduce((sum: number, worker: any) => sum + worker.gross, 0)).toBe(142);
      expect(payrollB.workers.reduce((sum: number, worker: any) => sum + worker.gross, 0)).toBe(142);
      const losingPayroll = winnerIsA ? payrollB : payrollA;
      expect(losingPayroll.workers.find((worker: any) => worker.workerId === winnerWorkerId))
        .toMatchObject({ syncStatus: 'UNSYNCED', accountingStatus: 'INCOMPLETE' });
      const closedPayrollA = loadPayrollValuationFromSqlite(dbA, COMPANY_A, 'closed-Q');
      const closedPayrollB = await requestWorker('payroll', { periodId: 'closed-Q' });
      const expectedClosedByWorker = [
        { workerId: 1, gross: 0, pieces: 0 },
        { workerId: 2, gross: winnerWorkerId === 2 ? 66 : 0, pieces: winnerWorkerId === 2 ? 6 : 0 },
        { workerId: 3, gross: winnerWorkerId === 3 ? 66 : 0, pieces: winnerWorkerId === 3 ? 6 : 0 }
      ];
      expect(outcome(closedPayrollA)).toEqual(expectedClosedByWorker);
      expect(outcome(closedPayrollB)).toEqual(expectedClosedByWorker);
      expect(closedPayrollA.workers.reduce((sum: number, worker: any) => sum + worker.gross, 0)).toBe(66);
      expect(closedPayrollB.workers.reduce((sum: number, worker: any) => sum + worker.gross, 0)).toBe(66);
      const payrollAmount = (value: any) => value.workers.reduce((sum: number, worker: any) => sum + worker.gross, 0);
      const payrollPieces = (value: any) => value.workers.reduce((sum: number, worker: any) => sum + worker.pieces, 0);
      expect(payrollAmount(payrollA) + payrollAmount(closedPayrollA)).toBe(208);
      expect(payrollAmount(payrollB) + payrollAmount(closedPayrollB)).toBe(208);
      expect(payrollPieces(payrollA) + payrollPieces(closedPayrollA)).toBe(28);
      expect(payrollPieces(payrollB) + payrollPieces(closedPayrollB)).toBe(28);

      const localAdjustment = dbA.prepare(`SELECT original_period_id, original_rate_snapshot, attribution_status,
        status FROM production_adjustments WHERE company_id=? AND adjustment_id='adj_source_correction_A'`).get(COMPANY_A);
      expect(localAdjustment).toEqual({ original_period_id: 'race-P', original_rate_snapshot: null,
        attribution_status: 'RESOLVED', status: 'APPROVED' });
      const remoteAdjustment = await requestWorker('adjustmentSnapshot', { adjustmentId: 'adj_source_correction_A' });
      expect(remoteAdjustment).toMatchObject({ delta_qty: 2, original_period_id: 'race-P',
        original_rate_snapshot: null, attribution_status: 'RESOLVED', status: 'APPROVED' });
      const remoteClosedAdjustment = await requestWorker('adjustmentSnapshot',
        { adjustmentId: 'adj_closed_source_correction_A' });
      expect(remoteClosedAdjustment).toMatchObject({ delta_qty: 2, original_period_id: 'closed-Q',
        original_rate_snapshot: null, attribution_status: 'RESOLVED', status: 'APPROVED' });

      // Repeated recovery/feed replay must preserve both clients' facts and the one correction.
      const [againA, againB] = await Promise.all([
        executeReconnectProtocol(dbA, COMPANY_A, clientA, { baseUserDataPath: testUserDataDir }),
        requestWorker('reconnect')
      ]);
      expect(againA.pushed.attempted).toBe(0);
      expect(againB.pushed.attempted).toBe(0);
      expect(outcome(loadPayrollValuationFromSqlite(dbA, COMPANY_A, 'race-P'))).toEqual(expectedByWorker);
      expect(outcome(await requestWorker('payroll'))).toEqual(expectedByWorker);
      expect(outcome(loadPayrollValuationFromSqlite(dbA, COMPANY_A, 'closed-Q'))).toEqual(expectedClosedByWorker);
      expect(outcome(await requestWorker('payroll', { periodId: 'closed-Q' }))).toEqual(expectedClosedByWorker);
      const finalA = getOperation(dbA, COMPANY_A, updateA.operationId);
      const finalB = (await requestWorker('snapshot', { ticketId, operationId: updateB.operationId })).operation;
      expect([finalA.status, finalB.status].sort()).toEqual(['CONFLICT', 'SYNCED']);
      expect((finalA.status === 'CONFLICT' ? finalA : finalB).payload_json).toBe(loserPayload);
      expect(Number((await serverPool.query(`SELECT COUNT(*) FROM production_adjustments WHERE company_id=$1
        AND adjustment_id IN ('adj_source_correction_A','adj_closed_source_correction_A')`, [COMPANY_A])).rows[0].count)).toBe(2);
      expect(Number((await serverPool.query('SELECT COUNT(*) FROM ticket_entries WHERE company_id=$1 AND ticket_id = ANY($2::varchar[])',
        [COMPANY_A, [ticketId, closedTicketId, independentA.ticketId, independentB.ticketId]])).rows[0].count)).toBe(4);
    } finally {
      closeAllCompanyDatabases();
      if (worker.connected) {
        try { await requestWorker('close'); } catch {}
      }
      if (!worker.killed && worker.exitCode === null) worker.kill();
      fs.rmSync(secondClientDir, { recursive: true, force: true });
    }
  }, 30000);

  // ----------------------------------------------------------------
  // 4: Lost Response Recovery & Semantic Idempotency
  // ----------------------------------------------------------------
  it('2. lost HTTP response scenario: server commits, retry returns prior result, 1 fact exists', async () => {
    const dbA = seedCompany(COMPANY_A);
    await seedServerParty('2');

    const cmdRes = executeSubmitTicketCommand(testUserDataDir, COMPANY_A, {
      commandId: 'cmd_lost_1',
      operationId: 'op_lost_1',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000202',
      modelId: 'm_test',
      partyNumber: '2',
      partyRecordId: 'party-sync-2',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 40,
      entries: [{ opName: 'Tikish', workerId: 1, qty: 40 }]
    });
    const syncClient = new SyncClient({ baseUrl, token: TOKEN_A });

    // Step A: Manually send operation to server (simulating first POST success)
    const opRow = getOperation(dbA, COMPANY_A, 'op_lost_1');
    expect(opRow).toBeDefined();

    const firstPush = await syncClient.pushOperations([
      {
        operationId: opRow.operation_id,
        companyId: opRow.company_id,
        commandType: opRow.command_type,
        entityType: opRow.entity_type,
        entityId: opRow.entity_id,
        payloadHash: opRow.payload_hash,
        payload: JSON.parse(opRow.payload_json)
      }
    ]);
    expect(firstPush.results[0].status).toBe('APPLIED');
    expect(firstPush.results[0].isReplay).toBe(false);

    // Simulate that the client crashed or network response was dropped before local outbox was marked SYNCED.
    // Close/reopen SQLite to verify the exact immutable operation survives process restart.
    closeAllCompanyDatabases();
    const reopened = getCompanyDatabase(testUserDataDir, COMPANY_A);
    expect(getOperation(reopened, COMPANY_A, 'op_lost_1')).toMatchObject({
      status: 'PENDING', payload_json: opRow.payload_json, payload_hash: opRow.payload_hash
    });

    // Step B: Outbox dispatcher retries dispatching the pending operation
    const retryDispatch = await dispatchOutbox(reopened, COMPANY_A, syncClient, { baseUserDataPath: testUserDataDir });
    expect(retryDispatch.attempted).toBe(1);
    expect(retryDispatch.synced).toBe(1);

    // Verify exactly 1 fact exists in PostgreSQL
    const pgCheck = await serverPool.query('SELECT COUNT(*) FROM tickets WHERE id = $1', ['00000000-0000-4000-8000-000000000202']);
    expect(parseInt(pgCheck.rows[0].count, 10)).toBe(1);

    // Exactly 1 change_log entry in PostgreSQL
    const clCheck = await serverPool.query('SELECT COUNT(*) FROM change_log WHERE operation_id = $1', ['op_lost_1']);
    expect(parseInt(clCheck.rows[0].count, 10)).toBe(1);

    // Local outbox is now SYNCED and local ticket is CONFIRMED
    expect(getOperation(reopened, COMPANY_A, 'op_lost_1').status).toBe('SYNCED');
    expect(reopened.prepare('SELECT status FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000202').status).toBe('CONFIRMED');
  });

  // ----------------------------------------------------------------
  // 5: Causal Dependency Ordering
  // ----------------------------------------------------------------
  it('3. causal dependency ordering: dependent child is blocked until predecessor is SYNCED', async () => {
    const dbA = seedCompany(COMPANY_A);
    await seedServerParty('3');

    // Operation 1 (parent)
    executeSubmitTicketCommand(testUserDataDir, COMPANY_A, {
      commandId: 'cmd_parent',
      operationId: 'op_parent',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000203',
      modelId: 'm_test',
      partyNumber: '3',
      partyRecordId: 'party-sync-3',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 10,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 10 }]
    });

    // Operation 2 (child, depends on op_parent)
    executeSubmitTicketCommand(testUserDataDir, COMPANY_A, {
      commandId: 'cmd_child',
      operationId: 'op_child',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000204',
      modelId: 'm_test',
      partyNumber: '3',
      partyRecordId: 'party-sync-3',
      effectiveDate: '2026-09-01',
      pattaNumber: 2,
      qty: 15,
      entries: [{ opName: 'Tikish', workerId: 1, qty: 15 }],
      dependsOnOperationId: 'op_parent',
      causalSequence: 1
    });

    const syncClient = new SyncClient({ baseUrl, token: TOKEN_A });

    // In local outbox, mark parent as CONFLICT (simulating prerequisite blocked/unresolved)
    const { updateOperationStatus } = require('../database/outboxManager.cjs');
    updateOperationStatus(dbA, COMPANY_A, 'op_parent', 'SENDING');
    updateOperationStatus(dbA, COMPANY_A, 'op_parent', 'CONFLICT', 'Parent failed');

    // Try dispatching: child MUST be blocked!
    const dispatch1 = await dispatchOutbox(dbA, COMPANY_A, syncClient, { baseUserDataPath: testUserDataDir });
    expect(dispatch1.attempted).toBe(0);
    expect(getOperation(dbA, COMPANY_A, 'op_child').status).toBe('PENDING');

    // Now resolve parent: retry parent to PENDING then dispatch
    updateOperationStatus(dbA, COMPANY_A, 'op_parent', 'PENDING');
    const dispatch2 = await dispatchOutbox(dbA, COMPANY_A, syncClient, { baseUserDataPath: testUserDataDir });

    // First wave: parent is synced, child was waiting for parent to become SYNCED
    expect(dispatch2.synced).toBe(1);
    expect(getOperation(dbA, COMPANY_A, 'op_parent').status).toBe('SYNCED');

    // Second wave: child dependency is now satisfied and child becomes SYNCED!
    const dispatch3 = await dispatchOutbox(dbA, COMPANY_A, syncClient, { baseUserDataPath: testUserDataDir });
    expect(dispatch3.synced).toBe(1);
    expect(getOperation(dbA, COMPANY_A, 'op_child').status).toBe('SYNCED');
  });

  // ----------------------------------------------------------------
  // 6: Transient Network Failure Retries (SENDING -> PENDING)
  // ----------------------------------------------------------------
  it('4. transient network failure reverts SENDING to PENDING with retry counter increment', async () => {
    const dbA = seedCompany(COMPANY_A);

    executeSubmitTicketCommand(testUserDataDir, COMPANY_A, {
      commandId: 'cmd_net_fail',
      operationId: 'op_net_fail',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000205',
      modelId: 'm_test',
      partyNumber: '4',
      partyRecordId: 'party-sync-4',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 30,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 30 }]
    });

    // Client pointing to an unreachable port (simulating network partition)
    const badClient = new SyncClient({ baseUrl: 'http://127.0.0.1:49999', token: TOKEN_A, timeoutMs: 500 });
    const res = await dispatchOutbox(dbA, COMPANY_A, badClient, { baseUserDataPath: testUserDataDir });

    expect(res.transientErrors).toBe(1);
    expect(res.synced).toBe(0);

    const op = getOperation(dbA, COMPANY_A, 'op_net_fail');
    expect(op.status).toBe('PENDING');
    expect(op.retry_count).toBeGreaterThanOrEqual(0);
    expect(op.last_error).toBeDefined();
  });

  // ----------------------------------------------------------------
  // 7-8: 4-Phase Pull-First Reconnect Protocol & Idempotent Change Apply
  // ----------------------------------------------------------------
  it('5. pull-first reconnect protocol pulls remote changes and applies them idempotently', async () => {
    const dbA = seedCompany(COMPANY_A);
    const syncClient = new SyncClient({ baseUrl, token: TOKEN_A });
    await seedServerParty('10');

    // 1. Commit a ticket on the server from Workstation B for Company A
    const remotePayload = {
      commandId: 'cmd_remote_b',
      operationId: 'op_remote_b',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000206',
      modelId: 'm_test',
      partyNumber: '10',
      partyRecordId: 'party-sync-10',
      effectiveDate: '2026-09-01',
      pattaNumber: 1,
      qty: 100,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 100 }]
    };
    await syncClient.pushOperations([
      {
        operationId: 'op_remote_b',
        companyId: COMPANY_A,
        commandType: 'SubmitTicket',
        entityType: 'ticket',
        entityId: '00000000-0000-4000-8000-000000000206',
        payloadHash: computePayloadHash(canonicalStringify(remotePayload)),
        payload: remotePayload
      }
    ]);

    // 2. Also have a pending local outbox operation on Workstation A
    executeSubmitTicketCommand(testUserDataDir, COMPANY_A, {
      commandId: 'cmd_local_a',
      operationId: 'op_local_a',
      companyId: COMPANY_A,
      ticketId: '00000000-0000-4000-8000-000000000207',
      modelId: 'm_test',
      partyNumber: '10',
      partyRecordId: 'party-sync-10',
      effectiveDate: '2026-09-01',
      pattaNumber: 2,
      qty: 80,
      entries: [{ opName: 'Tikish', workerId: 1, qty: 80 }]
    });

    // 3. Execute full 4-phase reconnect protocol
    const reconnectResult = await executeReconnectProtocol(dbA, COMPANY_A, syncClient, { baseUserDataPath: testUserDataDir });
    expect(reconnectResult.success).toBe(true);
    expect(reconnectResult.pulledInitial).toBeGreaterThanOrEqual(1);
    expect(reconnectResult.pushed.synced).toBe(1);

    // Verify remote ticket is present locally and CONFIRMED
    const remoteTicketLocal = dbA.prepare('SELECT status, qty FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000206');
    expect(remoteTicketLocal).toBeDefined();
    expect(remoteTicketLocal.status).toBe('CONFIRMED');
    expect(remoteTicketLocal.qty).toBe(100);

    // Verify local ticket is pushed and CONFIRMED
    const localTicket = dbA.prepare('SELECT status, qty FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000207');
    expect(localTicket.status).toBe('CONFIRMED');

    // 4. Test Change Apply Idempotency: Re-apply the same remote change
    const duplicateApply = applyChangesBatch(
      dbA,
      COMPANY_A,
      [
        {
          entityType: 'ticket',
          entityId: '00000000-0000-4000-8000-000000000206',
          changeType: 'INSERT',
          payload: remotePayload
        }
      ],
      reconnectResult.finalCursor
    );
    expect(duplicateApply.appliedCount).toBe(1);

    // Verify 0 duplicate records in local SQLite
    const countCheck = dbA.prepare('SELECT COUNT(*) as cnt FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000206');
    expect(countCheck.cnt).toBe(1);
  });

  // ----------------------------------------------------------------
  // 9: Sync Cursor Atomicity & Crash Safety
  // ----------------------------------------------------------------
  it('6. sync cursor advances ONLY after local transaction commits; abort prevents cursor advance', async () => {
    const dbA = seedCompany(COMPANY_A);
    setLocalCursor(dbA, 5);
    expect(getLocalCursor(dbA)).toBe(5);

    const changeItem = {
      entityType: 'ticket',
      entityId: '00000000-0000-4000-8000-000000000208',
      changeType: 'INSERT',
      payload: {
        ticketId: '00000000-0000-4000-8000-000000000208',
        modelId: 'm_test',
        partyNumber: '99',
        partyRecordId: 'party-sync-99',
        effectiveDate: '2026-09-01',
        pattaNumber: 1,
        qty: 10,
        entries: []
      }
    };

    // Attempt to apply change batch with nextCursor = 10, but crash before commit
    expect(() => {
      applyChangesBatch(dbA, COMPANY_A, [changeItem], 10, {
        testHookBeforeCommit: () => {
          throw new Error('SIMULATED_LOCAL_PROCESS_CRASH');
        }
      });
    }).toThrow('SIMULATED_LOCAL_PROCESS_CRASH');

    // Cursor MUST NOT have advanced! Remains at 5
    expect(getLocalCursor(dbA)).toBe(5);

    // Fact MUST NOT exist
    const ticketCheck = dbA.prepare('SELECT * FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000208');
    expect(ticketCheck).toBeUndefined();

    // Now apply without crash: succeeds and cursor advances to 10
    applyChangesBatch(dbA, COMPANY_A, [changeItem], 10);
    expect(getLocalCursor(dbA)).toBe(10);
    expect(dbA.prepare('SELECT * FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000208')).toBeDefined();
  });

  // ----------------------------------------------------------------
  // 10-12: Party Sequence Lease Acquisition & Offline Consumption
  // ----------------------------------------------------------------
  it('7. party lease: acquire from server, persist locally, consume offline atomically', async () => {
    const dbA = seedCompany(COMPANY_A);
    const syncClient = new SyncClient({ baseUrl, token: TOKEN_A });

    // 1. Acquire lease from server for block of 5 numbers (e.g. 1..5)
    const storedLease = await acquireAndStoreLease(dbA, COMPANY_A, syncClient, 5);
    expect(storedLease).toBeDefined();
    expect(storedLease.range_start).toBe(1);
    expect(storedLease.range_end).toBe(5);
    expect(storedLease.next_available).toBe(1);
    expect(storedLease.status).toBe('ACTIVE');

    // 2. Consume numbers offline without server communication
    const n1 = consumeNextPartyNumber(dbA, COMPANY_A);
    const n2 = consumeNextPartyNumber(dbA, COMPANY_A);
    const n3 = consumeNextPartyNumber(dbA, COMPANY_A);
    const n4 = consumeNextPartyNumber(dbA, COMPANY_A);
    const n5 = consumeNextPartyNumber(dbA, COMPANY_A);

    expect([n1, n2, n3, n4, n5]).toEqual([1, 2, 3, 4, 5]);

    // 3. 6th attempt must be blocked with LEASE_EXHAUSTED
    expect(() => {
      consumeNextPartyNumber(dbA, COMPANY_A);
    }).toThrow('No active party sequence lease available');

    const leaseState = getActiveLease(dbA, COMPANY_A);
    expect(leaseState).toBeNull(); // No active lease remaining
  });
});
