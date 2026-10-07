import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const databaseManager = require('./databaseManager.cjs');
const {
  acknowledgeOutboxOperation,
  getOutboxDiagnostics,
  insertOutboxOperation,
  listOutboxReconciliationCandidates,
  recoverVoidedPattaDuplicateTickets,
  supersedeBatchSettingsAlreadyApplied
} = require('./outboxManager.cjs');
const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');

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
    expect(acknowledgeOutboxOperation(db, companyId, 'op-accepted', acceptedHash)).toBe(true);
    expect(acknowledgeOutboxOperation(db, companyId, 'op-accepted', acceptedHash)).toBe(false);
    expect(acknowledgeOutboxOperation(db, companyId, 'op-not-accepted', '0'.repeat(64))).toBe(false);
    expect(acknowledgeOutboxOperation(db, companyId, 'missing', acceptedHash)).toBe(false);

    expect(db.prepare('SELECT status FROM local_outbox WHERE company_id = ? AND operation_id = ?')
      .get(companyId, 'op-accepted')).toEqual({ status: 'SYNCED' });
    expect(db.prepare('SELECT status FROM local_outbox WHERE company_id = ? AND operation_id = ?')
      .get(companyId, 'op-not-accepted')).toEqual({ status: 'PENDING' });
    expect(listOutboxReconciliationCandidates(db, companyId).map((row: any) => row.operation_id))
      .toEqual(['op-not-accepted']);
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
});
