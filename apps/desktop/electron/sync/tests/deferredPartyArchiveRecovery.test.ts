import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const manager = require('../../database/core/databaseManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../../database/core/canonicalPayload.cjs');
const { insertOutboxOperation, getOperation } = require('../../database/outbox/outboxManager.cjs');
const { recoverDeferredPartyArchives } = require('../deferredPartyArchiveRecovery.cjs');
const { dispatchOutbox } = require('../outboxDispatcher.cjs');
const { applyChangesBatch } = require('../changeFeedApplier.cjs');
const { executeReconnectProtocol } = require('../reconnectManager.cjs');

describe('archive accepted before late issuance / replacement recovery', () => {
  const companyId = 'archive-order-test';
  let directory: string;
  let db: any;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-deferred-archive-'));
    db = manager.getCompanyDatabase(directory, companyId);
  });
  afterEach(() => {
    manager.closeAllCompanyDatabases();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function add(commandType: string, id: string, payload: any, status: string, createdAt: string) {
    const json = canonicalStringify({ companyId, commandId: id, operationId: id, ...payload });
    insertOutboxOperation(db, { company_id: companyId, operation_id: id, command_type: commandType,
      entity_type: commandType === 'CompletePattaBatch' ? 'patta_batch' : 'party_history',
      entity_id: commandType === 'CompletePattaBatch' ? payload.batchId : companyId,
      payload_json: json, payload_hash: computePayloadHash(json), status, created_at: createdAt,
      last_error: status === 'DEAD_LETTER' ? JSON.stringify({ code: 'ACTIVE_PARTY_EXISTS' }) : null });
    return getOperation(db, companyId, id);
  }
  function fixture(number = '37', quantity = 104, modelId = 'new-model', archiveTime = '2026-10-01T11:00:00.000Z') {
    const now = '2026-10-01T10:00:00.000Z';
    for (const id of ['old-model', 'new-model']) db.prepare(`INSERT INTO models(id,company_id,name,operations_json,created_at,updated_at)
      VALUES (?,?,?,'[]',?,?)`).run(id, companyId, id, now, now);
    db.prepare(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id,status,is_closed,is_archived,
      server_revision,patta_count,patta_start_number,patta_end_number,ish_soni_per_patta,created_at,updated_at)
      VALUES ('old-party',?,?,?,'old-model','CLOSED',1,1,1,2,11,12,103,?,?)`)
      .run(companyId, number, number, now, now);
    add('CompletePattaBatch', 'original-issuance', { batchId: 'original-batch',
      parties: [{ partyRecordId: 'old-party', partyNumber: number, modelId: 'old-model', pattaCount: 2,
        cumulativePattaCount: 12, ishSoniPerPatta: 103, printedAt: now }] }, 'SYNCED', now);
    const archive = add('ArchivePartyHistory', 'original-archive', { partyRecordIds: ['old-party'] }, 'SYNCED', archiveTime);
    const batch = add('CompletePattaBatch', 'replacement', { batchId: 'replacement-batch',
      parties: [{ partyRecordId: 'new-party', partyNumber: number, modelId, pattaCount: 2,
        cumulativePattaCount: 12, ishSoniPerPatta: quantity, sizes: { M: 2 }, printedAt: '2026-10-01T12:00:00.000Z' }] },
    'DEAD_LETTER', '2026-10-01T12:00:00.000Z');
    return { archive, batch };
  }
  function receiptClient(accepted = true, mismatch = false) {
    return { getOperationStatuses: vi.fn(async (operations: any[]) => ({ results: operations.map(op => ({
      operationId: op.operationId, status: accepted ? 'APPLIED' : 'NOT_FOUND',
      payloadHash: mismatch ? '0'.repeat(64) : op.payloadHash, serverRevision: 1,
      committedAt: op.operationId === 'original-issuance' ? '2026-10-03T00:00:00.000Z' : '2026-10-01T11:00:01.000Z'
    })) })) };
  }

  it.each([['37', 104, 'old-model'], ['216', 140, 'new-model']])(
    'repairs only prior accepted archive intent before retrying distinct replacement #%s', async (number, quantity, model) => {
      const { batch } = fixture(number, quantity, model);
      const client = { ...receiptClient(), pushOperations: vi.fn(async (operations: any[]) => ({
        results: operations.map(op => ({ operationId: op.operationId, status: 'APPLIED', serverRevision: 1 })) })) };
      expect(await recoverDeferredPartyArchives(db, companyId, client)).toEqual({ queued: 1, retried: 0 });
      const repair = db.prepare("SELECT * FROM local_outbox WHERE operation_id LIKE 'archive_repair_%'").get();
      expect(JSON.parse(repair.payload_json).partyRecordIds).toEqual(['old-party']);
      expect(getOperation(db, companyId, 'replacement')).toMatchObject({ status: 'DEAD_LETTER', payload_json: batch.payload_json });
      expect(await recoverDeferredPartyArchives(db, companyId, client)).toEqual({ queued: 0, retried: 0 });
      expect(await dispatchOutbox(db, companyId, client)).toMatchObject({ attempted: 1, synced: 1 });
      expect(client.pushOperations.mock.calls[0][0][0].commandType).toBe('ArchivePartyHistory');
      // Even an ACK cannot substitute for an authoritative closure feed fact.
      expect(await recoverDeferredPartyArchives(db, companyId, client)).toEqual({ queued: 0, retried: 0 });
      applyChangesBatch(db, companyId, [{ changeId: 1, companyId, entityType: 'party', entityId: 'old-party',
        entityRevision: 2, operationId: repair.operation_id, changeType: 'UPDATE',
        payload: { partyRecordId: 'old-party', status: 'CLOSED', isClosed: true, isArchived: true } }], '1');
      expect(await recoverDeferredPartyArchives(db, companyId, client)).toEqual({ queued: 0, retried: 1 });
      expect(getOperation(db, companyId, 'replacement')).toMatchObject({ status: 'PENDING', payload_json: batch.payload_json,
        payload_hash: batch.payload_hash, accepted_payload_hash: null });
      const intent = JSON.parse(getOperation(db, companyId, 'replacement').payload_json).parties[0];
      expect(intent).toMatchObject({ partyRecordId: 'new-party', modelId: model, ishSoniPerPatta: quantity, cumulativePattaCount: 12 });
      db.prepare("UPDATE local_outbox SET status='DEAD_LETTER',last_error=? WHERE operation_id='replacement'")
        .run(JSON.stringify({ code: 'ACTIVE_PARTY_EXISTS' }));
      expect(await recoverDeferredPartyArchives(db, companyId, client)).toEqual({ queued: 0, retried: 0 });
    });

  it.each([[false, false], [true, true]])('requires an exact server receipt (%s, %s)', async (accepted, mismatch) => {
    fixture();
    expect(await recoverDeferredPartyArchives(db, companyId, receiptClient(accepted, mismatch))).toEqual({ queued: 0, retried: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM local_outbox').get().n).toBe(3);
  });

  it('does not infer an archive from a local archived flag or another company', async () => {
    fixture();
    db.prepare("UPDATE local_outbox SET status='CONFLICT' WHERE operation_id='original-archive'").run();
    expect(await recoverDeferredPartyArchives(db, companyId, receiptClient())).toEqual({ queued: 0, retried: 0 });
    db.prepare("UPDATE local_outbox SET status='SYNCED' WHERE operation_id='original-archive'").run();
    expect(await recoverDeferredPartyArchives(db, 'other-company', receiptClient())).toEqual({ queued: 0, retried: 0 });
  });

  it('does not repair an archive intent created after the replacement', async () => {
    fixture('37', 104, 'new-model', '2026-10-02T00:00:00.000Z');
    expect(await recoverDeferredPartyArchives(db, companyId, receiptClient())).toEqual({ queued: 0, retried: 0 });
  });

  it('does not replay a correctly ordered archive or guess when server timestamps are unavailable', async () => {
    fixture();
    for (const committedAt of [undefined, '2026-09-30T00:00:00.000Z']) {
      const client = { getOperationStatuses: async (operations: any[]) => ({ results: operations.map(op => ({
        operationId: op.operationId, status: 'APPLIED', payloadHash: op.payloadHash, serverRevision: 1,
        committedAt: op.operationId === 'original-issuance' ? committedAt : '2026-10-01T11:00:01.000Z'
      })) }) };
      expect(await recoverDeferredPartyArchives(db, companyId, client)).toEqual({ queued: 0, retried: 0 });
    }
  });

  it('never sends an archive before its unresolved issuance, even without a captured dependency', async () => {
    add('CompletePattaBatch', 'issuance', { batchId: 'initial', parties: [{ partyRecordId: 'old-party' }] },
      'CONFLICT', '2026-10-01T10:00:00.000Z');
    add('ArchivePartyHistory', 'archive', { partyRecordIds: ['old-party'] }, 'PENDING', '2026-10-01T11:00:00.000Z');
    add('ArchivePartyHistory', 'independent', { partyRecordIds: ['other-party'] }, 'PENDING', '2026-10-01T12:00:00.000Z');
    const client = { pushOperations: vi.fn(async (operations: any[]) => ({ results: operations.map(op => ({
      operationId: op.operationId, status: 'APPLIED', serverRevision: 1
    })) })) };
    expect(await dispatchOutbox(db, companyId, client, { batchSize: 1 })).toMatchObject({ attempted: 1, synced: 1 });
    expect(client.pushOperations.mock.calls[0][0][0].operationId).toBe('independent');
    expect(getOperation(db, companyId, 'archive').status).toBe('PENDING');
    db.prepare("UPDATE local_outbox SET status='SYNCED' WHERE operation_id='issuance'").run();
    expect(await dispatchOutbox(db, companyId, client)).toMatchObject({ attempted: 1, synced: 1 });
    expect(client.pushOperations.mock.calls[1][0][0].operationId).toBe('archive');
  });

  it('repairs archive first, pulls authoritative closure, then accepts the unchanged replacement on reconnect', async () => {
    const { batch } = fixture();
    const accepted = new Set(['original-archive', 'original-issuance']);
    let feed: any[] = [];
    const sent: string[] = [];
    const client = {
      getOperationStatuses: async (operations: any[]) => ({ results: operations.map(op => ({
        operationId: op.operationId, status: accepted.has(op.operationId) ? 'APPLIED' : 'NOT_FOUND',
        payloadHash: op.payloadHash, serverRevision: 1,
        committedAt: op.operationId === 'original-archive' ? '2026-10-01T11:00:01.000Z' : '2026-10-03T00:00:00.000Z'
      })) }),
      pullChanges: async (cursor: string | number) => {
        const items = feed;
        feed = [];
        return { items, nextCursor: items.length ? '1' : String(cursor), hasMore: false,
          capabilities: { legacyPattaBatchReplayV1: true } };
      },
      pushOperations: async (operations: any[]) => ({ results: operations.map(op => {
        sent.push(op.commandType);
        accepted.add(op.operationId);
        if (op.commandType === 'ArchivePartyHistory') feed.push({ changeId: 1, companyId, entityType: 'party',
          entityId: 'old-party', entityRevision: 2, operationId: op.operationId, changeType: 'UPDATE',
          payload: { partyRecordId: 'old-party', status: 'CLOSED', isClosed: true, isArchived: true } });
        else expect(canonicalStringify(op.payload)).toBe(batch.payload_json);
        return { operationId: op.operationId, status: 'APPLIED', serverRevision: 1 };
      }) })
    };
    expect((await executeReconnectProtocol(db, companyId, client)).deferredPartyArchives).toEqual({ queued: 1, retried: 0 });
    expect(getOperation(db, companyId, 'replacement').status).toBe('DEAD_LETTER');
    expect((await executeReconnectProtocol(db, companyId, client)).deferredPartyArchives).toEqual({ queued: 0, retried: 1 });
    expect(getOperation(db, companyId, 'replacement')).toMatchObject({ status: 'SYNCED', payload_hash: batch.payload_hash });
    await executeReconnectProtocol(db, companyId, client);
    expect(sent).toEqual(['ArchivePartyHistory', 'CompletePattaBatch']);
  });
});
