import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const databaseManager = require('../database/databaseManager.cjs');
const { insertOutboxOperation, getOperation } = require('../database/outboxManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../database/canonicalPayload.cjs');
const { isDependencySatisfied } = require('./outboxDispatcher.cjs');
const { reconcileAcceptedOutboxOperations } = require('./reconnectManager.cjs');

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
            { operationId: 'op-accepted', status: 'APPLIED', payloadHash: acceptedHash },
            { operationId: 'op-dependent', status: 'NOT_FOUND' },
            { operationId: 'op-hash-mismatch', status: 'APPLIED', payloadHash: '0'.repeat(64) }
          ]
        };
      }
    };

    await expect(reconcileAcceptedOutboxOperations(db, companyId, syncClient)).resolves.toBe(1);

    expect(getOperation(db, companyId, 'op-accepted').status).toBe('SYNCED');
    expect(getOperation(db, companyId, 'op-dependent').status).toBe('PENDING');
    expect(getOperation(db, companyId, 'op-hash-mismatch').status).toBe('PENDING');
    expect(isDependencySatisfied(db, companyId, { depends_on_operation_id: 'op-accepted' })).toBe(true);
    expect(requested).toEqual([[
      { operationId: 'op-accepted', payloadHash: acceptedHash },
      { operationId: 'op-dependent', payloadHash: getOperation(db, companyId, 'op-dependent').payload_hash },
      { operationId: 'op-hash-mismatch', payloadHash: mismatchHash }
    ]]);
  });
});
