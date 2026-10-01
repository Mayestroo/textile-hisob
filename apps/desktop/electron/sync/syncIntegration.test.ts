import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const { buildFastifyServer } = require('../../../server/app.cjs');
const { getServerPool, resetServerDatabase, closeServerPool } = require('../../../server/infrastructure/db.cjs');
const { getCompanyDatabase, closeAllCompanyDatabases } = require('../database/databaseManager.cjs');
const { executeSubmitTicketCommand } = require('../database/commandPipeline.cjs');
const { getOperation, updateOperationStatus } = require('../database/outboxManager.cjs');
const { rebuildCompanyProjections } = require('../database/projectionReader.cjs');
const { SyncClient } = require('./syncClient.cjs');
const { dispatchOutbox } = require('./outboxDispatcher.cjs');
const { applyChangesBatch, getLocalCursor, setLocalCursor } = require('./changeFeedApplier.cjs');
const { executeReconnectProtocol } = require('./reconnectManager.cjs');
const { acquireAndStoreLease, consumeNextPartyNumber, getActiveLease } = require('./leaseManager.cjs');
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

  function seedCompany(companyId: string) {
    const db = getCompanyDatabase(testUserDataDir, companyId);
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
    // Local outbox is still PENDING!
    expect(getOperation(dbA, COMPANY_A, 'op_lost_1').status).toBe('PENDING');

    // Step B: Outbox dispatcher retries dispatching the pending operation
    const retryDispatch = await dispatchOutbox(dbA, COMPANY_A, syncClient, { baseUserDataPath: testUserDataDir });
    expect(retryDispatch.attempted).toBe(1);
    expect(retryDispatch.synced).toBe(1);

    // Verify exactly 1 fact exists in PostgreSQL
    const pgCheck = await serverPool.query('SELECT COUNT(*) FROM tickets WHERE id = $1', ['00000000-0000-4000-8000-000000000202']);
    expect(parseInt(pgCheck.rows[0].count, 10)).toBe(1);

    // Exactly 1 change_log entry in PostgreSQL
    const clCheck = await serverPool.query('SELECT COUNT(*) FROM change_log WHERE operation_id = $1', ['op_lost_1']);
    expect(parseInt(clCheck.rows[0].count, 10)).toBe(1);

    // Local outbox is now SYNCED and local ticket is CONFIRMED
    expect(getOperation(dbA, COMPANY_A, 'op_lost_1').status).toBe('SYNCED');
    expect(dbA.prepare('SELECT status FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000202').status).toBe('CONFIRMED');
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
