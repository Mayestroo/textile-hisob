import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const manager = require('../../database/core/databaseManager.cjs');
const { insertOutboxOperation } = require('../../database/outbox/outboxManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../../database/core/canonicalPayload.cjs');
const { reconcileEquivalentConflicts } = require('../conflictReconciliation.cjs');
const { executeReconnectProtocol } = require('../reconnectManager.cjs');
const companyId = 'equivalent-conflicts';
const localId = '00000000-0000-4000-8000-000000000201';
const serverId = '00000000-0000-4000-8000-000000000202';
const operations = [{ id: 'sew', name: 'Sew', rate: 5 }];
const now = '2026-11-16T10:00:00Z';

describe('safe conflict reconciliation (SQLite + simulated authenticated inspection)', () => {
  let directory: string;
  let db: any;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-conflict-inspection-'));
    db = manager.getCompanyDatabase(directory, companyId);
    db.prepare(`INSERT INTO models (id, company_id, name, hisob_sheet_name, title, operations_json,
      patta_ops_order_json, server_revision, created_at, updated_at)
      VALUES ('m', ?, 'M', 'M-hisob', 'Model- M', ?, '["Sew"]', 30, ?, ?)`)
      .run(companyId, JSON.stringify(operations), now, now);
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (1, ?, 'A', ?, ?), (2, ?, 'B', ?, ?)`).run(companyId, now, now, companyId, now, now);
    db.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, created_at, updated_at)
      VALUES ('p', ?, '45', '45', 'm', ?, ?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, is_closed, created_at, updated_at)
      VALUES ('P', ?, 'Current', '2026-11-01', 0, ?, ?)`).run(companyId, now, now);
  });
  afterEach(() => {
    manager.closeAllCompanyDatabases();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function fixture(type = 'SubmitTicket') {
    const payload = type === 'SubmitTicket'
      ? { companyId, commandId: 'cmd', operationId: 'op', ticketId: localId, modelId: 'm', periodId: 'P',
        partyRecordId: 'p', partyNumber: '45', pattaNumber: 7, qty: 100,
        entries: [{ opName: 'Sew', workerId: 1, qty: 40, rateSnapshot: 5 }, { opName: 'Sew', workerId: 2, qty: 60, rateSnapshot: 5 }] }
      : { companyId, commandId: 'cmd', operationId: 'op', modelId: 'm', name: 'M', operations, pattaOpsOrder: ['Sew'] };
    if (type === 'SubmitTicket') {
      db.prepare(`INSERT INTO tickets (id, company_id, model_id, period_id, party_record_id, party_number,
        patta_number, qty, status, server_revision, submitted_at, created_at)
        VALUES (?, ?, 'm', 'P', 'p', '45', 7, 100, 'PENDING_SYNC', 0, ?, ?)`).run(localId, companyId, now, now);
      for (const entry of payload.entries!) db.prepare(`INSERT INTO ticket_entries
        (id, company_id, ticket_id, op_name, worker_id, qty, rate_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`${localId}-${entry.workerId}`, companyId, localId, entry.opName, entry.workerId, entry.qty, entry.rateSnapshot, now);
    }
    const json = canonicalStringify(payload);
    const hash = computePayloadHash(json);
    insertOutboxOperation(db, { operation_id: 'op', company_id: companyId, command_type: type,
      entity_type: type === 'SubmitTicket' ? 'ticket' : 'model', entity_id: type === 'SubmitTicket' ? localId : 'm',
      base_revision: type === 'SubmitTicket' ? 0 : 30, payload_json: json, payload_hash: hash,
      status: type === 'SubmitTicket' ? 'DEAD_LETTER' : 'CONFLICT',
      last_error: JSON.stringify(type === 'SubmitTicket'
        ? { code: '23505', message: 'duplicate key violates unique constraint "idx_tickets_party_patta"' }
        : { code: 'REVISION_CONFLICT', message: 'Model revision conflict; expected 31, supplied 30' }) });
    const snapshot = type === 'SubmitTicket'
      ? { ...payload, ticketId: serverId, status: 'CONFIRMED', isClosed: false, submittedAt: now,
        entries: payload.entries!.map(entry => ({ ...entry, entryId: `server-entry-${entry.workerId}` })) }
      : { ...payload };
    const result = { companyId, operationId: 'op', payloadHash: hash, status: 'EQUIVALENT',
      canonicalEntityId: type === 'SubmitTicket' ? serverId : 'm', entityRevision: type === 'SubmitTicket' ? 1 : 31, snapshot };
    const client = { inspectConflicts: vi.fn(async () => ({ success: true, results: [result] })) };
    return { payload, json, hash, snapshot, result, client };
  }

  it('keeps the original duplicate as evidence and installs just one canonical payable patta', async () => {
    const item = fixture();
    expect(await reconcileEquivalentConflicts(db, companyId, item.client)).toBe(1);
    expect(db.prepare('SELECT status FROM tickets WHERE id=?').get(localId).status).toBe('VOIDED');
    expect(db.prepare('SELECT id, qty FROM tickets WHERE status=?').all('CONFIRMED')).toEqual([{ id: serverId, qty: 100 }]);
    expect(db.prepare('SELECT id, qty FROM ticket_entries WHERE ticket_id=? ORDER BY qty').all(serverId))
      .toEqual([{ id: 'server-entry-1', qty: 40 }, { id: 'server-entry-2', qty: 60 }]);
    expect(db.prepare('SELECT COUNT(*) n FROM ticket_entries WHERE ticket_id=?').get(localId).n).toBe(2);
    expect(db.prepare('SELECT status, payload_json, accepted_payload_hash FROM local_outbox WHERE operation_id=?').get('op'))
      .toEqual({ status: 'SUPERSEDED', payload_json: item.json, accepted_payload_hash: null });
    expect(await reconcileEquivalentConflicts(db, companyId, item.client)).toBe(0);
  });

  it('resolves an identical model revision without overwriting server data or faking acceptance', async () => {
    const item = fixture('UpsertModel');
    expect(await reconcileEquivalentConflicts(db, companyId, item.client)).toBe(1);
    expect(db.prepare('SELECT server_revision, operations_json FROM models WHERE id=?').get('m'))
      .toEqual({ server_revision: 31, operations_json: JSON.stringify(operations) });
    expect(db.prepare('SELECT status, accepted_payload_hash FROM local_outbox WHERE operation_id=?').get('op'))
      .toEqual({ status: 'SUPERSEDED', accepted_payload_hash: null });
  });

  it.each(['different-qty', 'different-period', 'wrong-company', 'wrong-hash', 'dependent-command', 'no-endpoint'])
    ('does not clear unsafe or unverified duplicate intent: %s', async (scenario) => {
    const item = fixture();
    if (scenario === 'different-qty') (item.snapshot as any).qty = 99;
    if (scenario === 'different-period') (item.snapshot as any).periodId = 'Other';
    if (scenario === 'wrong-company') item.result.companyId = 'other-company';
    if (scenario === 'wrong-hash') item.result.payloadHash = '0'.repeat(64);
    if (scenario === 'dependent-command') insertOutboxOperation(db, { operation_id: 'child', company_id: companyId,
      command_type: 'UpdateTicket', entity_type: 'ticket', entity_id: localId, payload_json: '{}',
      payload_hash: computePayloadHash('{}'), depends_on_operation_id: 'op', status: 'PENDING' });
    expect(await reconcileEquivalentConflicts(db, companyId, scenario === 'no-endpoint' ? {} : item.client)).toBe(0);
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get('op').status).toBe('DEAD_LETTER');
    expect(db.prepare('SELECT status FROM tickets WHERE id=?').get(localId).status).toBe('PENDING_SYNC');
  });

  it('retains different server facts as an explicit manual-comparison conflict', async () => {
    const item = fixture('UpsertModel');
    (item.result as any).status = 'DIFFERENT';
    (item.result as any).differingFields = ['operations'];
    expect(await reconcileEquivalentConflicts(db, companyId, item.client)).toBe(0);
    const op = db.prepare('SELECT status, last_error, payload_json FROM local_outbox WHERE operation_id=?').get('op');
    expect(op.status).toBe('CONFLICT');
    expect(op.payload_json).toBe(item.json);
    expect(JSON.parse(op.last_error).details).toMatchObject({ resolution: 'MANUAL_COMPARISON_REQUIRED', differingFields: ['operations'] });
  });

  it('reconciles before pull so the incoming canonical row cannot collide with a provisional duplicate', async () => {
    const item = fixture();
    const pushOperations = vi.fn();
    await executeReconnectProtocol(db, companyId, { ...item.client, pushOperations,
      pullChanges: async () => ({ items: [{ entityType: 'ticket', entityId: serverId, entityRevision: 1,
        changeType: 'INSERT', payload: item.snapshot }], nextCursor: '1', hasMore: false }) });
    expect(pushOperations).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) n FROM tickets WHERE status=?').get('CONFIRMED').n).toBe(1);
    expect(db.prepare('SELECT qty FROM ticket_entries WHERE ticket_id=? ORDER BY qty').all(serverId)).toEqual([{ qty: 40 }, { qty: 60 }]);
  });
});
