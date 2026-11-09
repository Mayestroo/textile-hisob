'use strict';

const manager = require('../database/databaseManager.cjs');
const { executeSubmitTicketCommand } = require('../database/commandPipeline.cjs');
const { executeWorkbookCommand } = require('../database/workbookCommandPipeline.cjs');
const { getOperation } = require('../database/outboxManager.cjs');
const { loadPayrollValuationFromSqlite } = require('../database/payrollReader.cjs');
const { SyncClient } = require('./syncClient.cjs');
const { dispatchOutbox } = require('./outboxDispatcher.cjs');
const { executeReconnectProtocol } = require('./reconnectManager.cjs');
const { getLocalCursor } = require('./changeFeedApplier.cjs');
const { canonicalStringify, computePayloadHash } = require('../database/canonicalPayload.cjs');

let directory;
let companyId;
let db;
let client;
let baseUrl;
let activeCompanyId;
let contextGeneration = 0;
const releases = new Map();

function seed() {
  db = manager.getCompanyDatabase(directory, companyId);
  const now = '2026-09-15T12:00:00.000Z';
  db.prepare(`INSERT OR IGNORE INTO models (id, company_id, name, operations_json, created_at, updated_at)
    VALUES ('m_test', ?, 'Test Model', ?, ?, ?)`).run(companyId,
    JSON.stringify([{ name: 'Bichish', rate: 7 }, { name: 'Tikish', rate: 3 }]), now, now);
  db.prepare('UPDATE models SET operations_json=? WHERE company_id=? AND id=?')
    .run(JSON.stringify([{ name: 'Bichish', rate: 7 }, { name: 'Tikish', rate: 3 }]), companyId, 'm_test');
  const worker = db.prepare(`INSERT OR IGNORE INTO workers (id, company_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`);
  for (const [id, name] of [[1, 'Worker Ali'], [2, 'Worker two'], [3, 'Worker three']]) worker.run(id, companyId, name, now, now);
  db.prepare(`INSERT OR IGNORE INTO periods (id, company_id, name, start_date, end_date, is_closed, status, created_at)
    VALUES ('race-P', ?, 'Race P', '2026-09-01', '2026-09-30', 0, 'OPEN', ?)`).run(companyId, now);
  const party = db.prepare(`INSERT OR IGNORE INTO parties (id, company_id, party_number, physical_party_number,
    model_id, model_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'm_test', 'Test Model', 'ACTIVE', ?, ?)`);
  for (const number of ['1', '20', '21', '30']) party.run(`party-sync-${number}`, companyId, number, number, now, now);
}

function payroll(periodId = 'race-P') {
  const value = loadPayrollValuationFromSqlite(db, companyId, periodId);
  return { workers: value.workers.map(worker => ({ workerId: worker.workerId, gross: worker.gross,
    pieces: worker.pieces, syncStatus: worker.syncStatus, accountingStatus: worker.accountingStatus })),
    acceptanceEvidence: value.acceptanceEvidence };
}

async function execute(message) {
  const { requestId, action, payload = {} } = message;
  if (action === 'init') {
    directory = payload.directory;
    companyId = payload.companyId;
    activeCompanyId = companyId;
    contextGeneration++;
    baseUrl = payload.baseUrl;
    client = new SyncClient({ baseUrl, token: payload.token });
    seed();
    return { initialized: true };
  }
  if (action === 'edit') return executeWorkbookCommand(directory, companyId, payload);
  if (action === 'submit') return executeSubmitTicketCommand(directory, companyId, payload);
  if (action === 'dispatch') return dispatchOutbox(db, companyId, client, { baseUserDataPath: directory });
  if (action === 'dispatchGated') {
    return dispatchOutbox(db, companyId, { pushOperations: async operations => {
      process.send({ type: 'raceReady', requestId });
      await new Promise(resolve => releases.set(requestId, resolve));
      return client.pushOperations(operations);
    } }, { baseUserDataPath: directory });
  }
  if (action === 'reconnect') return executeReconnectProtocol(db, companyId, client, { baseUserDataPath: directory });
  if (action === 'reconnectDelayed') {
    const capturedCompanyId = companyId;
    const capturedDb = db;
    const capturedGeneration = contextGeneration;
    const delayedClient = {
      pullChanges: async (cursor, limit) => {
        const response = await client.pullChanges(cursor, limit);
        process.send({ type: 'delayedPullReady', requestId, itemCount: response.items?.length || 0,
          entityTypes: [...new Set((response.items || []).map(item => item.entityType))] });
        await new Promise(resolve => releases.set(`pull:${requestId}`, resolve));
        return response;
      },
      getOperationStatuses: (...args) => client.getOperationStatuses(...args),
      pushOperations: (...args) => client.pushOperations(...args)
    };
    try {
      return await executeReconnectProtocol(capturedDb, capturedCompanyId, delayedClient, {
        baseUserDataPath: directory,
        isContextCurrent: () => activeCompanyId === capturedCompanyId && contextGeneration === capturedGeneration
      });
    } catch (error) { return { error: error.message }; }
  }
  if (action === 'prepareContext') {
    const contextDb = manager.getCompanyDatabase(directory, payload.companyId);
    contextDb.prepare(`INSERT INTO local_meta(key,value,updated_at) VALUES('context_marker',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(payload.marker || 'prepared-context', new Date().toISOString());
    return { prepared: true };
  }
  if (action === 'switchContext') {
    activeCompanyId = payload.companyId;
    contextGeneration++;
    manager.getCompanyDatabase(directory, activeCompanyId);
    return { activeCompanyId, contextGeneration };
  }
  if (action === 'restartLocalDatabase') {
    manager.closeCompanyDatabase(companyId);
    db = manager.getCompanyDatabase(directory, companyId);
    return { reopened: true, cursor: getLocalCursor(db) };
  }
  if (action === 'contextSnapshot') {
    const contextDb = manager.getCompanyDatabase(directory, payload.companyId);
    return {
      cursor: getLocalCursor(contextDb),
      meta: contextDb.prepare('SELECT key, value, updated_at FROM local_meta ORDER BY key').all(),
      tickets: contextDb.prepare('SELECT id, status, server_revision FROM tickets WHERE company_id=? ORDER BY id').all(payload.companyId),
      entries: contextDb.prepare(`SELECT e.id, e.ticket_id, e.worker_id, e.qty FROM ticket_entries e
        WHERE e.company_id=? ORDER BY e.ticket_id, e.id`).all(payload.companyId),
      adjustments: contextDb.prepare(`SELECT adjustment_id, delta_qty, original_ticket_id, original_entry_id,
        original_period_id, original_rate_snapshot, attribution_status FROM production_adjustments
        WHERE company_id=? ORDER BY adjustment_id`).all(payload.companyId),
      outbox: contextDb.prepare(`SELECT operation_id, status, payload_json, payload_hash FROM local_outbox
        WHERE company_id=? ORDER BY operation_id`).all(payload.companyId)
    };
  }
  if (action === 'adjustmentSnapshot') return db.prepare(`SELECT adjustment_id, delta_qty, original_ticket_id,
    original_entry_id, original_period_id, original_rate_snapshot, attribution_status, status, server_revision
    FROM production_adjustments WHERE company_id=? AND adjustment_id=?`).get(companyId, payload.adjustmentId);
  if (action === 'closedPeriodPayroll') return payroll('closed-Q');
  if (action === 'seedClosedSource') {
    const now = '2026-09-15T12:00:00.000Z';
    const archive = { period: { id: 'closed-Q', companyId }, models: [{ id: 'm_test', name: 'Test Model',
      operations: [{ name: 'Bichish', rate: 11 }, { name: 'Tikish', rate: 4 }] }] };
    const archiveJson = canonicalStringify(archive);
    db.prepare(`INSERT OR IGNORE INTO periods (id, company_id, name, start_date, end_date, is_closed, status, server_revision, created_at)
      VALUES ('closed-Q', ?, 'Closed Q', '2026-08-01', '2026-08-31', 1, 'CLOSED', 1, ?)`).run(companyId, now);
    db.prepare(`INSERT OR IGNORE INTO period_archives(company_id, period_id, archive_json, sha256, archived_at)
      VALUES (?, 'closed-Q', ?, ?, ?)`).run(companyId, archiveJson,
      computePayloadHash(canonicalStringify(archive)), now);
    db.prepare(`INSERT OR IGNORE INTO tickets (id, company_id, model_id, period_id, party_number, party_record_id,
      patta_number, qty, status, is_closed, submitted_at, created_at, provenance, server_revision)
      VALUES ('00000000-0000-4000-8000-000000000226', ?, 'm_test', 'closed-Q', '30', 'party-sync-30',
        1, 4, 'CONFIRMED', 1, ?, ?, 'REMOTE_SYNC', 1)`).run(companyId, now, now);
    db.prepare(`INSERT OR IGNORE INTO ticket_entries(id, ticket_id, company_id, op_name, worker_id, rate_snapshot, qty, created_at)
      VALUES ('entry_closed_source', '00000000-0000-4000-8000-000000000226', ?, 'Bichish', ?, NULL, 4, ?)`).run(companyId, payload.workerId, now);
    return { seeded: true, archiveHash: computePayloadHash(canonicalStringify(archive)) };
  }
  if (action === 'payroll') return payroll(payload.periodId || 'race-P');
  if (action === 'snapshot') return {
    ticket: db.prepare('SELECT status, server_revision FROM tickets WHERE company_id=? AND id=?').get(companyId, payload.ticketId),
    entries: db.prepare('SELECT worker_id, qty FROM ticket_entries WHERE company_id=? AND ticket_id=? ORDER BY id').all(companyId, payload.ticketId),
    operation: getOperation(db, companyId, payload.operationId)
  };
  if (action === 'release') {
    releases.get(payload.targetRequestId)?.();
    releases.delete(payload.targetRequestId);
    return { released: true };
  }
  if (action === 'releasePull') {
    const key = `pull:${payload.targetRequestId}`;
    releases.get(key)?.();
    releases.delete(key);
    return { released: true };
  }
  if (action === 'close') {
    manager.closeAllCompanyDatabases();
    return { closed: true };
  }
  throw new Error(`Unsupported acceptance worker action: ${action}`);
}

process.on('message', async message => {
  try {
    const result = await execute(message);
    process.send({ type: 'response', requestId: message.requestId, result });
    if (message.action === 'close') setImmediate(() => process.disconnect());
  } catch (error) {
    process.send({ type: 'response', requestId: message.requestId,
      error: { message: error.message, code: error.code || null, stack: error.stack } });
  }
});
