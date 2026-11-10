import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const databaseManager = require('../core/databaseManager.cjs');
const {
  acknowledgeOutboxOperation,
  getOutboxDiagnostics,
  insertOutboxOperation,
  listOutboxReconciliationCandidates,
  recoverPeriodScopeMismatchTickets,
  recoverVoidedPattaDuplicateTickets,
  supersedeBatchSettingsAlreadyApplied
} = require('../outbox/outboxManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../core/canonicalPayload.cjs');
const { dispatchOutbox } = require('../../sync/outboxDispatcher.cjs');

describe('outbox server-acceptance reconciliation', () => {
  let userData: string;
  const companyId = 'company_outbox_reconciliation';

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-outbox-reconcile-'));
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  function insertPending(db: any, operationId: string, lastError?: string) {
    const payloadJson = canonicalStringify({ operationId });
    insertOutboxOperation(db, {
      operation_id: operationId,
      company_id: companyId,
      command_type: 'UpdateBatchSettings',
      entity_type: 'batch_settings',
      entity_id: companyId,
      base_revision: 0,
      payload_json: payloadJson,
      payload_hash: computePayloadHash(payloadJson),
      last_error: lastError,
      status: 'PENDING',
      causal_sequence: 1
    });
    return computePayloadHash(payloadJson);
  }

  it('marks only exact server-accepted operations synced and unblocks their dependents', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const acceptedHash = db.transaction(() => insertPending(db, 'op-accepted'))();
    db.transaction(() => insertPending(db, 'op-not-accepted'))();

    expect(listOutboxReconciliationCandidates(db, companyId)).toHaveLength(2);
    expect(acknowledgeOutboxOperation(db, companyId, 'op-accepted', acceptedHash, 1, '42')).toBe(true);
    expect(acknowledgeOutboxOperation(db, companyId, 'op-accepted', acceptedHash, 1, '42')).toBe(false);
    expect(acknowledgeOutboxOperation(db, companyId, 'op-not-accepted', '0'.repeat(64), 1)).toBe(false);
    expect(acknowledgeOutboxOperation(db, companyId, 'missing', acceptedHash, 1)).toBe(false);

    expect(db.prepare('SELECT status, accepted_change_id FROM local_outbox WHERE company_id = ? AND operation_id = ?')
      .get(companyId, 'op-accepted')).toEqual({ status: 'SYNCED', accepted_change_id: '42' });
    expect(db.prepare('SELECT status FROM local_outbox WHERE company_id = ? AND operation_id = ?')
      .get(companyId, 'op-not-accepted')).toEqual({ status: 'PENDING' });
    expect(listOutboxReconciliationCandidates(db, companyId).map((row: any) => row.operation_id))
      .toEqual(['op-not-accepted']);
  });

  it('fills a missing cursor receipt from a later exact worker feed acknowledgement', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const acceptedHash = db.transaction(() => insertPending(db, 'op-feed-receipt'))();
    expect(acknowledgeOutboxOperation(db, companyId, 'op-feed-receipt', acceptedHash, 2)).toBe(true);
    expect(acknowledgeOutboxOperation(db, companyId, 'op-feed-receipt', acceptedHash, 2, '57')).toBe(true);
    expect(acknowledgeOutboxOperation(db, companyId, 'op-feed-receipt', acceptedHash, 2, '57')).toBe(false);
    expect(db.prepare('SELECT status,accepted_payload_hash,accepted_server_revision,accepted_change_id FROM local_outbox WHERE operation_id=?')
      .get('op-feed-receipt')).toEqual({ status: 'SYNCED', accepted_payload_hash: acceptedHash,
        accepted_server_revision: 2, accepted_change_id: '57' });
  });

  it('keeps a company pending operation through context switch and SQLite reopen, then dispatches it when restored', async () => {
    const companyA = 'fixture_company_context_a';
    const companyB = 'fixture_company_context_b';
    const dbA = databaseManager.getCompanyDatabase(userData, companyA);
    const payloadJson = canonicalStringify({ operationId: 'fixture-op-a', companyId: companyA });
    const payloadHash = computePayloadHash(payloadJson);
    dbA.transaction(() => insertOutboxOperation(dbA, {
      operation_id: 'fixture-op-a', company_id: companyA, command_type: 'UpdateBatchSettings',
      entity_type: 'batch_settings', entity_id: companyA, base_revision: 0, payload_json: payloadJson,
      payload_hash: payloadHash, status: 'PENDING', causal_sequence: 1
    }))();

    databaseManager.closeAllCompanyDatabases();
    const dbB = databaseManager.getCompanyDatabase(userData, companyB);
    const bBefore = dbB.prepare('SELECT COUNT(*) AS count FROM local_outbox WHERE company_id = ?').get(companyB);
    expect(bBefore.count).toBe(0);
    databaseManager.closeAllCompanyDatabases();

    const restoredA = databaseManager.getCompanyDatabase(userData, companyA);
    expect(restoredA.prepare('SELECT status, payload_json, payload_hash FROM local_outbox WHERE company_id = ? AND operation_id = ?')
      .get(companyA, 'fixture-op-a')).toEqual({ status: 'PENDING', payload_json: payloadJson, payload_hash: payloadHash });
    const pushed: any[] = [];
    await dispatchOutbox(restoredA, companyA, {
      pushOperations: async (operations: any[]) => {
        pushed.push(...operations);
        return { results: operations.map((operation: any) => ({ operationId: operation.operationId, status: 'APPLIED', serverRevision: 1 })) };
      }
    });
    expect(pushed).toHaveLength(1);
    expect(restoredA.prepare('SELECT status, payload_hash FROM local_outbox WHERE company_id = ? AND operation_id = ?')
      .get(companyA, 'fixture-op-a')).toEqual({ status: 'SYNCED', payload_hash: payloadHash });
  });

  it('reports pending transport errors without exposing operation payloads', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    db.transaction(() => insertPending(db, 'op-network-error', 'Network request failed: fetch failed'))();

    const diagnostics = getOutboxDiagnostics(db, companyId);
    expect(diagnostics.pendingErrors).toHaveLength(1);
    expect(diagnostics.pendingErrors[0]).toMatchObject({
      command_type: 'UpdateBatchSettings',
      status: 'PENDING',
      last_error: 'Network request failed: fetch failed'
    });
    expect(diagnostics.pendingErrors[0]).not.toHaveProperty('payload_json');
  });

  it('supersedes only a stale settings conflict whose full snapshot is already authoritative', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-a', ?, 'Model A', '[]', ?, ?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO company_batch_settings (company_id, available_sizes_json, server_revision, updated_at)
      VALUES (?, '["M","L"]', 337, ?)`).run(companyId, now);
    db.prepare(`INSERT INTO patta_batch_settings (
      company_id, model_id, party_number, is_custom_party, total_ish_soni, color, sizes_json
    ) VALUES (?, 'model-a', '17', 0, '10', 'Qora', '{"M":"2","L":""}')`).run(companyId);

    const insertSettingsConflict = (operationId: string, partyNumber: string) => {
      const payloadJson = canonicalStringify({
        operationId,
        companyId,
        availableSizes: ['M', 'L'],
        configs: [{ modelId: 'model-a', partyNumber, isCustomParty: false, totalIshSoni: '10', color: 'Qora', sizes: { M: '2', L: '' } }]
      });
      insertOutboxOperation(db, {
        operation_id: operationId,
        company_id: companyId,
        command_type: 'UpdateBatchSettings',
        entity_type: 'batch_settings',
        entity_id: companyId,
        base_revision: 336,
        payload_json: payloadJson,
        payload_hash: computePayloadHash(payloadJson),
        status: 'CONFLICT',
        last_error: JSON.stringify({ code: 'REVISION_CONFLICT' }),
        causal_sequence: 0
      });
    };
    db.transaction(() => {
      insertSettingsConflict('op-settings-already-applied', '17');
      insertSettingsConflict('op-settings-different', '18');
    })();

    expect(supersedeBatchSettingsAlreadyApplied(db, companyId)).toBe(1);
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op-settings-already-applied'))
      .toEqual({ status: 'SUPERSEDED' });
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op-settings-different'))
      .toEqual({ status: 'CONFLICT' });
    expect(getOutboxDiagnostics(db, companyId).conflictCount).toBe(1);
  });

  it('retries one rejected SubmitTicket only after its matching local ticket is voided', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-a', ?, 'Model A', '[]', ?, ?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, created_at, updated_at)
      VALUES ('party-voided', ?, '12', '12', 'model-a', 'ACTIVE', ?, ?),
             ('party-active', ?, '13', '13', 'model-a', 'ACTIVE', ?, ?)`)
      .run(companyId, now, now, companyId, now, now);
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number,
      qty, status, submitted_at, created_at)
      VALUES ('00000000-0000-4000-8000-000000001001', ?, 'model-a', '12', 'party-voided', 5, 1, 'VOIDED', ?, ?),
             ('00000000-0000-4000-8000-000000001002', ?, 'model-a', '13', 'party-active', 6, 1, 'CONFIRMED', ?, ?)`)
      .run(companyId, now, now, companyId, now, now);

    const insertDeadLetter = (operationId: string, ticketId: string, partyRecordId: string, partyNumber: string, pattaNumber: number, attemptCount: number) => {
      const payloadJson = canonicalStringify({ operationId, ticketId, companyId, partyRecordId, partyNumber, pattaNumber });
      insertOutboxOperation(db, {
        operation_id: operationId,
        company_id: companyId,
        command_type: 'SubmitTicket',
        entity_type: 'ticket',
        entity_id: ticketId,
        base_revision: 0,
        payload_json: payloadJson,
        payload_hash: computePayloadHash(payloadJson),
        status: 'DEAD_LETTER',
        attempt_count: attemptCount,
        last_error: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "idx_tickets_party_patta"' }),
        causal_sequence: 0
      });
    };
    db.transaction(() => {
      insertDeadLetter('op-retry-voided', '00000000-0000-4000-8000-000000001101', 'party-voided', '12', 5, 1);
      insertDeadLetter('op-do-not-retry-active', '00000000-0000-4000-8000-000000001102', 'party-active', '13', 6, 1);
      insertDeadLetter('op-do-not-retry-repeatedly', '00000000-0000-4000-8000-000000001103', 'party-voided', '12', 5, 2);
    })();

    expect(recoverVoidedPattaDuplicateTickets(db, companyId)).toBe(1);
    expect(db.prepare('SELECT status, last_error FROM local_outbox WHERE operation_id = ?').get('op-retry-voided'))
      .toEqual({ status: 'PENDING', last_error: 'RETRY_AFTER_VOIDED_PATTA_RELEASE' });
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op-do-not-retry-active'))
      .toEqual({ status: 'DEAD_LETTER' });
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op-do-not-retry-repeatedly'))
      .toEqual({ status: 'DEAD_LETTER' });
  });

  it('does not requeue a mismatched captured period as the current open period', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, is_closed, status, server_revision, created_at, updated_at)
      VALUES ('period-current', ?, 'Current', '2026-09-01', 0, 'OPEN', 1, ?, ?)`).run(companyId, now, now);

    const insertPeriodMismatch = (operationId: string, ticketId: string, effectiveDate: string, attemptCount: number) => {
      const payloadJson = canonicalStringify({
        operationId,
        companyId,
        ticketId,
        periodId: 'period-old',
        effectiveDate,
        submittedAt: `${effectiveDate}T10:00:00.000Z`
      });
      insertOutboxOperation(db, {
        operation_id: operationId,
        company_id: companyId,
        command_type: 'SubmitTicket',
        entity_type: 'ticket',
        entity_id: ticketId,
        payload_json: payloadJson,
        payload_hash: computePayloadHash(payloadJson),
        status: 'DEAD_LETTER',
        attempt_count: attemptCount,
        last_error: JSON.stringify({ code: 'PERIOD_SCOPE_MISMATCH' })
      });
      return payloadJson;
    };

    const unchangedPayload = insertPeriodMismatch('op-period-valid', '00000000-0000-4000-8000-000000001201', '2026-09-23', 1);
    const retryPayload = insertPeriodMismatch('op-period-valid-retry', '00000000-0000-4000-8000-000000001202', '2026-09-23', 2);
    insertPeriodMismatch('op-period-outside', '00000000-0000-4000-8000-000000001203', '2026-08-31', 1);
    insertPeriodMismatch('op-period-retried', '00000000-0000-4000-8000-000000001204', '2026-09-23', 3);

    expect(recoverPeriodScopeMismatchTickets(db, companyId)).toBe(0);
    expect(db.prepare('SELECT status, payload_json FROM local_outbox WHERE operation_id = ?').get('op-period-valid'))
      .toEqual({ status: 'DEAD_LETTER', payload_json: unchangedPayload });
    expect(db.prepare('SELECT status, payload_json FROM local_outbox WHERE operation_id = ?').get('op-period-valid-retry'))
      .toEqual({ status: 'DEAD_LETTER', payload_json: retryPayload });
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op-period-outside'))
      .toEqual({ status: 'DEAD_LETTER' });
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op-period-retried'))
      .toEqual({ status: 'DEAD_LETTER' });
  });

  it('keeps captured period and flags conflicting server acknowledgement', async () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = new Date().toISOString();
    const ticketId = '00000000-0000-4000-8000-000000001301';
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-period-ack', ?, 'Model', '[]', ?, ?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO tickets (
      id, company_id, model_id, period_id, party_number, patta_number, qty, status, submitted_at, created_at
    ) VALUES (?, ?, 'model-period-ack', 'period-old', '1', 1, 1, 'PENDING_SYNC', ?, ?)`)
      .run(ticketId, companyId, now, now);
    const payloadJson = canonicalStringify({ operationId: 'op-period-ack', ticketId });
    insertOutboxOperation(db, {
      operation_id: 'op-period-ack',
      company_id: companyId,
      command_type: 'SubmitTicket',
      entity_type: 'ticket',
      entity_id: ticketId,
      payload_json: payloadJson,
      payload_hash: computePayloadHash(payloadJson),
      status: 'PENDING'
    });

    const dispatch = await dispatchOutbox(db, companyId, {
      pushOperations: async () => ({ results: [{
        operationId: 'op-period-ack', status: 'APPLIED', serverRevision: 1, periodId: 'period-current'
      }] })
    });

    expect(db.prepare('SELECT period_id, status FROM tickets WHERE company_id = ? AND id = ?')
      .get(companyId, ticketId)).toEqual({ period_id: 'period-old', status: 'PENDING_SYNC' });
    expect(db.prepare('SELECT status, last_error FROM local_outbox WHERE operation_id = ?').get('op-period-ack'))
      .toMatchObject({ status: 'CONFLICT', last_error: expect.stringContaining('TICKET_PERIOD_AUTHORITY_MISMATCH') });
    expect(dispatch).toMatchObject({ synced: 0, conflict: 1 });
  });
});
