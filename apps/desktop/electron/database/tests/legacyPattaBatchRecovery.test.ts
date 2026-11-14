import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const manager = require('../core/databaseManager.cjs');
const { insertOutboxOperation, recoverLegacyPattaBatches } = require('../outbox/outboxManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../core/canonicalPayload.cjs');
const { executeReconnectProtocol } = require('../../sync/reconnectManager.cjs');
const { loadWorkbookProjectionFromSqlite } = require('../readers/projectionReader.cjs');

describe('legacy print outbox upgrade', () => {
  const companyId = 'legacy-outbox';
  let directory: string;
  let db: any;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-print-upgrade-'));
    db = manager.getCompanyDatabase(directory, companyId);
  });
  afterEach(() => {
    manager.closeAllCompanyDatabases();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function queue(operationId: string, overrides: any = {}, rowOverrides: any = {}) {
    const payload = { companyId, commandId: operationId, operationId, batchId: operationId,
      parties: [{ partyRecordId: `party-${operationId}`, pattaCount: 3, cumulativePattaCount: 53, printedAt: '2026-10-01T12:00:00.000Z' }],
      ...overrides };
    const json = canonicalStringify(payload);
    insertOutboxOperation(db, { company_id: companyId, operation_id: operationId, command_type: 'CompletePattaBatch',
      entity_type: 'patta_batch', entity_id: operationId, base_revision: 0, payload_json: json,
      payload_hash: computePayloadHash(json), status: 'CONFLICT', attempt_count: 4,
      last_error: JSON.stringify({ code: 'REVISION_CONFLICT', message: 'Batch settings revision is missing or invalid; reload before printing' }),
      ...rowOverrides });
    return db.prepare('SELECT * FROM local_outbox WHERE operation_id=?').get(operationId);
  }

  it('requeues missing/null legacy revisions, preserving immutable identity, hash and dependency', () => {
    const before = queue('old', {}, { depends_on_operation_id: 'parent', causal_sequence: 9 });
    queue('null-revision', { batchSettingsBaseRevision: null }, { status: 'DEAD_LETTER' });
    expect(recoverLegacyPattaBatches(db, companyId)).toBe(2);
    const after = db.prepare('SELECT * FROM local_outbox WHERE operation_id=?').get('old');
    expect(after.status).toBe('PENDING');
    for (const field of ['operation_id', 'payload_json', 'payload_hash', 'depends_on_operation_id', 'causal_sequence',
      'base_revision', 'created_at', 'attempt_count', 'retry_count']) expect(after[field]).toBe(before[field]);
    expect(recoverLegacyPattaBatches(db, companyId)).toBe(0);
  });

  it('does not turn invalid evidence, a real CAS conflict, another company or an accepted row into a retry', () => {
    queue('modern', { batchSettingsBaseRevision: 3 });
    queue('invalid', { batchSettingsBaseRevision: '3' });
    queue('foreign', { companyId: 'other' });
    queue('other-tenant', { companyId: 'other' }, { company_id: 'other' });
    queue('missing-paper', { parties: [{ pattaCount: 3, cumulativePattaCount: 0 }] });
    queue('wrong-identity', {}, { entity_id: 'another-batch' });
    queue('accepted', {}, { status: 'SYNCED' });
    queue('genuine-conflict', {}, { last_error: JSON.stringify({ code: 'REVISION_CONFLICT', message: 'Party revision conflict; expected 2, supplied 1' }) });
    expect(recoverLegacyPattaBatches(db, companyId)).toBe(0);
  });

  it('waits for server capability before retrying obsolete validation failures', async () => {
    queue('old-server');
    const client = { pullChanges: async () => ({ items: [], nextCursor: '0', hasMore: false }) };
    const result = await executeReconnectProtocol(db, companyId, client);
    expect(result).toMatchObject({ recoveredLegacyPattaBatchCount: 0, pushed: { attempted: 0 } });
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get('old-server').status).toBe('CONFLICT');
  });

  function queueActivePartyConflict(operationId: string, partyOverrides: any = {}, storedOverrides: any = {}) {
    const party = { partyRecordId: `party-${operationId}`, partyNumber: operationId, modelId: 'model',
      pattaCount: 3, cumulativePattaCount: 53, ishSoniPerPatta: 10,
      sizes: { M: 3 }, sizeOrder: ['M'], printedAt: '2026-10-01T12:00:00.000Z', ...partyOverrides };
    db.prepare(`INSERT OR IGNORE INTO models(id,company_id,name,operations_json,created_at,updated_at)
      VALUES ('model',?,'Model','[]',?,?)`).run(companyId, party.printedAt, party.printedAt);
    const stored = { id: party.partyRecordId, number: party.partyNumber, model: 'model', count: 3,
      start: 51, end: 53, quantity: 10, sizes: '{"M":3}', order: '["M"]', revision: 1, ...storedOverrides };
    db.prepare(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id,patta_count,
      cumulative_patta_count,patta_start_number,patta_end_number,ish_soni_per_patta,sizes_json,size_order_json,
      server_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(stored.id, companyId, stored.number, stored.number, stored.model, stored.count, stored.end,
        stored.start, stored.end, stored.quantity, stored.sizes, stored.order, stored.revision, party.printedAt, party.printedAt);
    return queue(operationId, { parties: [party] }, { status: 'DEAD_LETTER',
      last_error: JSON.stringify({ code: 'ACTIVE_PARTY_EXISTS', message: 'Existing active party' }) });
  }

  it('retries an obsolete duplicate refusal only once, with unchanged issuance and payload', () => {
    const before = queueActivePartyConflict('same-paper');
    expect(recoverLegacyPattaBatches(db, companyId)).toBe(1);
    const after = db.prepare('SELECT * FROM local_outbox WHERE operation_id=?').get('same-paper');
    expect(after).toMatchObject({ status: 'PENDING', payload_json: before.payload_json,
      payload_hash: before.payload_hash, attempt_count: before.attempt_count });
    db.prepare(`UPDATE local_outbox SET status='DEAD_LETTER',last_error=? WHERE operation_id=?`)
      .run(before.last_error, before.operation_id);
    expect(recoverLegacyPattaBatches(db, companyId)).toBe(0);
  });

  it.each([
    ['different ID', {}, { id: 'other-party' }],
    ['local optimistic fact', {}, { revision: 0 }],
    ['different range', {}, { start: 61, end: 63 }],
    ['different quantity', {}, { quantity: 20 }],
    ['different sizes', {}, { sizes: '{"L":3}' }],
    ['different size order', {}, { order: '["L"]' }],
    ['different party number', { partyNumber: 'requested' }, { number: 'stored' }]
  ])('does not hide a real active-party conflict: %s', (_label, party, stored) => {
    queueActivePartyConflict('mismatch', party, stored);
    expect(recoverLegacyPattaBatches(db, companyId)).toBe(0);
  });

  it('resolves persisted company-scoped identity aliases, not party numbers', () => {
    queueActivePartyConflict('aliased', { modelId: 'old-model' }, { id: 'canonical-party' });
    db.prepare(`INSERT INTO party_id_aliases(company_id,legacy_party_id,canonical_party_id,created_at)
      VALUES (?, 'party-aliased', 'canonical-party', ?)`).run(companyId, new Date().toISOString());
    db.prepare(`INSERT INTO model_id_aliases(company_id,legacy_model_id,canonical_model_id,created_at)
      VALUES (?, 'old-model', 'model', ?)`).run(companyId, new Date().toISOString());
    expect(recoverLegacyPattaBatches(db, companyId)).toBe(1);
  });

  it('recovers over reconnect only with capability and preserves current settings on ACK', async () => {
    const before = queueActivePartyConflict('reconnect-paper');
    const timestamp = '2026-11-01T12:00:00.000Z';
    db.prepare(`INSERT INTO company_batch_settings(company_id,available_sizes_json,server_revision,updated_at)
      VALUES (?, '["XL"]', 7, ?)`).run(companyId, timestamp);
    let supportsReplay = false;
    let pushes = 0;
    const client = {
      pullChanges: async () => ({ items: [], nextCursor: '0', hasMore: false,
        capabilities: { legacyPattaBatchReplayV1: supportsReplay } }),
      pushOperations: async (operations: any[]) => {
        pushes++;
        expect(operations[0].payloadHash).toBe(before.payload_hash);
        expect(canonicalStringify(operations[0].payload)).toBe(before.payload_json);
        return { results: operations.map(op => ({ operationId: op.operationId, status: 'APPLIED', serverRevision: 1 })) };
      }
    };
    expect((await executeReconnectProtocol(db, companyId, client)).recoveredLegacyPattaBatchCount).toBe(0);
    expect(pushes).toBe(0);
    supportsReplay = true;
    expect(await executeReconnectProtocol(db, companyId, client)).toMatchObject({
      recoveredLegacyPattaBatchCount: 1, pushed: { synced: 1, conflict: 0, deadLetter: 0 }
    });
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id=?').get(before.operation_id).status).toBe('SYNCED');
    expect(db.prepare('SELECT available_sizes_json,server_revision,updated_at FROM company_batch_settings WHERE company_id=?').get(companyId))
      .toEqual({ available_sizes_json: '["XL"]', server_revision: 7, updated_at: timestamp });
    await executeReconnectProtocol(db, companyId, client);
    expect(pushes).toBe(1);
  });

  it('does not count legacy issuance as a future batch-settings revision', () => {
    queue('old-pending', {}, { status: 'PENDING' });
    queue('new-pending', { batchSettingsBaseRevision: 0 }, { status: 'PENDING' });
    expect(loadWorkbookProjectionFromSqlite(db, companyId).batchSettingsPrintRevision).toBe(1);
  });
});
