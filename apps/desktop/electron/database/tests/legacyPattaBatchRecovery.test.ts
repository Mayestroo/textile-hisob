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

  it('does not count legacy issuance as a future batch-settings revision', () => {
    queue('old-pending', {}, { status: 'PENDING' });
    queue('new-pending', { batchSettingsBaseRevision: 0 }, { status: 'PENDING' });
    expect(loadWorkbookProjectionFromSqlite(db, companyId).batchSettingsPrintRevision).toBe(1);
  });
});
