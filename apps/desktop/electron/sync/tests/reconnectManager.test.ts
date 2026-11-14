import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const databaseManager = require('../../database/core/databaseManager.cjs');
const { insertOutboxOperation, getOperation } = require('../../database/outbox/outboxManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../../database/core/canonicalPayload.cjs');
const { isDependencySatisfied } = require('../outboxDispatcher.cjs');
const { executePullOnlyProtocol, executeReconnectProtocol, reconcileAcceptedOutboxOperations } = require('../reconnectManager.cjs');

describe('reconnect accepted-operation reconciliation', () => {
  let userData: string;
  const companyId = 'company_reconnect_reconciliation';

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-reconnect-reconcile-'));
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  function insertOperation(db: any, operationId: string, causalSequence: number, dependency?: string) {
    const payloadJson = canonicalStringify({ operationId });
    const payloadHash = computePayloadHash(payloadJson);
    insertOutboxOperation(db, {
      operation_id: operationId,
      company_id: companyId,
      command_type: 'UpdateBatchSettings',
      entity_type: 'batch_settings',
      entity_id: companyId,
      base_revision: 0,
      payload_json: payloadJson,
      payload_hash: payloadHash,
      depends_on_operation_id: dependency,
      causal_sequence: causalSequence,
      status: 'PENDING'
    });
    return payloadHash;
  }

  it('acks only exact server replays so dependent outbox operations can proceed', async () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const acceptedHash = insertOperation(db, 'op-accepted', 1);
    insertOperation(db, 'op-dependent', 2, 'op-accepted');
    const mismatchHash = insertOperation(db, 'op-hash-mismatch', 3);
    const requested: any[] = [];
    const syncClient = {
      getOperationStatuses: async (operations: any[]) => {
        requested.push(operations);
        return {
          success: true,
          results: [
            { operationId: 'op-accepted', status: 'APPLIED', payloadHash: acceptedHash, serverRevision: 1 },
            { operationId: 'op-dependent', status: 'NOT_FOUND' },
            { operationId: 'op-hash-mismatch', status: 'APPLIED', payloadHash: '0'.repeat(64) }
          ]
        };
      }
    };

    await expect(reconcileAcceptedOutboxOperations(db, companyId, syncClient)).resolves.toBe(1);

    expect(getOperation(db, companyId, 'op-accepted').status).toBe('SYNCED');
    expect(getOperation(db, companyId, 'op-accepted').accepted_payload_hash).toBe(acceptedHash);
    expect(getOperation(db, companyId, 'op-dependent').status).toBe('PENDING');
    expect(getOperation(db, companyId, 'op-hash-mismatch').status).toBe('PENDING');
    expect(isDependencySatisfied(db, companyId, { depends_on_operation_id: 'op-accepted' })).toBe(true);
    expect(requested).toEqual([[
      { operationId: 'op-accepted', payloadHash: acceptedHash },
      { operationId: 'op-dependent', payloadHash: getOperation(db, companyId, 'op-dependent').payload_hash },
      { operationId: 'op-hash-mismatch', payloadHash: mismatchHash }
    ]]);
  });

  it('pulls every available change-feed page without dispatching local outbox operations', async () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const cursors: Array<string | number> = [];
    const syncClient = {
      pullChanges: async (cursor: string | number) => {
        cursors.push(cursor);
        if (cursors.length === 1) {
          return {
            items: [{
              changeId: '10', companyId, entityType: 'party_history', entityId: companyId,
              changeType: 'UPDATE', payload: { archivedAt: '2026-10-07T10:00:00.000Z' }
            }],
            nextCursor: '10', hasMore: true, nextPattaNumber: 13
          };
        }
        return { items: [], nextCursor: '11', hasMore: false, nextPattaNumber: 13 };
      },
      pushOperations: vi.fn()
    };

    const result = await executePullOnlyProtocol(db, companyId, syncClient);

    expect(cursors).toEqual([0, 10]);
    expect(result).toMatchObject({ pulledCount: 1, pages: 2, hasMore: false, finalCursor: 11, nextPattaNumber: 13 });
    expect(syncClient.pushOperations).not.toHaveBeenCalled();
  });

  it('checks receipts beyond 100 unaccepted rows and clears accepted batch errors without resending', async () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    for (let i = 0; i < 100; i++) insertOperation(db, `blocked-${i}`, i, 'missing-parent');
    const hashes = new Map<string, string>();
    for (const [index, status] of ['CONFLICT', 'DEAD_LETTER'].entries()) {
      const id = `accepted-batch-${index}`;
      const payloadJson = canonicalStringify({ operationId: id, batchId: id, companyId,
        ...(index === 1 ? { batchSettingsBaseRevision: 3 } : {}) });
      const hash = computePayloadHash(payloadJson);
      hashes.set(id, hash);
      insertOutboxOperation(db, { operation_id: id, company_id: companyId, command_type: 'CompletePattaBatch',
        entity_type: 'patta_batch', entity_id: id, payload_json: payloadJson, payload_hash: hash,
        causal_sequence: 100 + index, status, last_error: 'ACTIVE_PARTY_EXISTS', error_message: 'Active party already exists' });
    }
    const getOperationStatuses = vi.fn(async (operations: any[]) => ({ results: operations.map(op => hashes.has(op.operationId)
      ? { operationId: op.operationId, status: 'APPLIED', payloadHash: hashes.get(op.operationId), serverRevision: 1 }
      : { operationId: op.operationId, status: 'NOT_FOUND' }) }));
    const pushOperations = vi.fn();
    const client = { getOperationStatuses, pushOperations,
      pullChanges: async () => ({ items: [], nextCursor: '0', hasMore: false }) };
    expect(await executeReconnectProtocol(db, companyId, client)).toMatchObject({
      reconciledCount: 2, pushed: { attempted: 0 }
    });
    expect(getOperationStatuses.mock.calls.map(([ops]) => ops.length)).toEqual([100, 2]);
    expect(pushOperations).not.toHaveBeenCalled();
    for (const [id, hash] of hashes) {
      expect(getOperation(db, companyId, id)).toMatchObject({ status: 'SYNCED', accepted_payload_hash: hash,
        last_error: null, error_message: null, attempt_count: 0 });
    }
    // The unchanged first page must not starve a later page on subsequent reconnects either.
    insertOperation(db, 'accepted-later', 103);
    hashes.set('accepted-later', getOperation(db, companyId, 'accepted-later').payload_hash);
    expect((await executeReconnectProtocol(db, companyId, client)).reconciledCount).toBe(1);
    expect(pushOperations).not.toHaveBeenCalled();
  });

  it('reconciles acceptance before legacy retry recovery touches the failed command', async () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const payload = { companyId, commandId: 'legacy', operationId: 'legacy', batchId: 'legacy',
      parties: [{ partyRecordId: 'party', pattaCount: 2, cumulativePattaCount: 12, printedAt: '2026-11-01T00:00:00.000Z' }] };
    const json = canonicalStringify(payload);
    const hash = computePayloadHash(json);
    insertOutboxOperation(db, { company_id: companyId, operation_id: 'legacy', command_type: 'CompletePattaBatch',
      entity_type: 'patta_batch', entity_id: 'legacy', payload_json: json, payload_hash: hash, status: 'CONFLICT',
      last_error: JSON.stringify({ code: 'REVISION_CONFLICT', message: 'Batch settings revision is missing; reload before printing' }) });
    const pushOperations = vi.fn();
    const result = await executeReconnectProtocol(db, companyId, {
      pullChanges: async () => ({ items: [], nextCursor: '0', hasMore: false, capabilities: { legacyPattaBatchReplayV1: true } }),
      getOperationStatuses: async () => ({ results: [{ operationId: 'legacy', status: 'APPLIED', payloadHash: hash, serverRevision: 1 }] }),
      pushOperations
    });
    expect(result).toMatchObject({ reconciledCount: 1, recoveredLegacyPattaBatchCount: 0, pushed: { attempted: 0 } });
    expect(pushOperations).not.toHaveBeenCalled();
  });

  it('does not open a SQLite write transaction for an unchanged empty poll', async () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    db.prepare(`INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
      VALUES (?, 1, '2000-01-01T00:00:00.000Z')`).run(companyId);
    const before = db.prepare(`SELECT updated_at FROM company_patta_sequences WHERE company_id = ?`).get(companyId);
    const syncClient = {
      pullChanges: async () => ({ items: [], nextCursor: '0', hasMore: false, nextPattaNumber: 1 })
    };

    const result = await executePullOnlyProtocol(db, companyId, syncClient, { maxPages: 1 });

    expect(result).toMatchObject({ pulledCount: 0, pages: 1, hasMore: false, finalCursor: 0 });
    expect(db.prepare(`SELECT updated_at FROM company_patta_sequences WHERE company_id = ?`).get(companyId))
      .toEqual(before);
  });

  it.each([
    { featureEnabled: false, expectedStatus: 'DEAD_LETTER', expectedPushes: 0, expectedRecovered: 0 },
    { featureEnabled: true, expectedStatus: 'SYNCED', expectedPushes: 1, expectedRecovered: 1 }
  ])('retries a voided-patta duplicate only when the VPS advertises support ($featureEnabled)', async ({
    featureEnabled, expectedStatus, expectedPushes, expectedRecovered
  }) => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = new Date().toISOString();
    const partyId = 'party-voided';
    const oldTicketId = '00000000-0000-4000-8000-000000009101';
    const failedTicketId = '00000000-0000-4000-8000-000000009102';
    const operationId = 'op-voided-patta-retry';
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-a', ?, 'Model A', '[]', ?, ?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, created_at, updated_at)
      VALUES (?, ?, '12', '12', 'model-a', 'ACTIVE', ?, ?)`).run(partyId, companyId, now, now);
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number,
      qty, status, submitted_at, created_at)
      VALUES (?, ?, 'model-a', '12', ?, 5, 1, 'VOIDED', ?, ?),
             (?, ?, 'model-a', '12', ?, 5, 1, 'PENDING_SYNC', ?, ?)`)
      .run(oldTicketId, companyId, partyId, now, now, failedTicketId, companyId, partyId, now, now);

    const payload = {
      operationId, companyId, ticketId: failedTicketId, modelId: 'model-a',
      partyNumber: '12', partyRecordId: partyId, pattaNumber: 5, qty: 1,
      entries: [{ opName: 'Sew', workerId: 71 }]
    };
    const payloadJson = canonicalStringify(payload);
    insertOutboxOperation(db, {
      operation_id: operationId,
      company_id: companyId,
      command_type: 'SubmitTicket',
      entity_type: 'ticket',
      entity_id: failedTicketId,
      base_revision: 0,
      payload_json: payloadJson,
      payload_hash: computePayloadHash(payloadJson),
      status: 'DEAD_LETTER',
      attempt_count: 1,
      last_error: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "idx_tickets_party_patta"' })
    });

    let pushedCount = 0;
    const syncClient = {
      pullChanges: async (cursor: string | number) => ({
        success: true,
        items: [],
        nextCursor: String(cursor),
        hasMore: false,
        nextPattaNumber: 6,
        capabilities: featureEnabled ? { voidedPattaReuse: true } : {}
      }),
      getOperationStatuses: async (operations: any[]) => ({
        success: true,
        results: operations.map((operation) => ({ operationId: operation.operationId, status: 'NOT_FOUND' }))
      }),
      pushOperations: async (operations: any[]) => {
        pushedCount += operations.length;
        return {
          success: true,
          results: operations.map((operation) => ({
            operationId: operation.operationId,
            status: 'APPLIED',
            serverRevision: 1,
            committedAt: now
          }))
        };
      }
    };

    const result = await executeReconnectProtocol(db, companyId, syncClient);

    expect(result.recoveredVoidedPattaDuplicateCount).toBe(expectedRecovered);
    expect(pushedCount).toBe(expectedPushes);
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get(operationId))
      .toEqual({ status: expectedStatus });
  });
});
