import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const databaseManager = require('./databaseManager.cjs');
const {
  acknowledgeOutboxOperation,
  insertOutboxOperation,
  listOutboxReconciliationCandidates
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

  function insertPending(db: any, operationId: string) {
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
});
