import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const manager = require('../../database/core/databaseManager.cjs');
const { insertOutboxOperation, getOperation } = require('../../database/outbox/outboxManager.cjs');
const { computePayloadHash } = require('../../database/core/canonicalPayload.cjs');
const { dispatchOutbox } = require('../outboxDispatcher.cjs');
const company = 'batch02-outbox';

describe('outbox eligible batch liveness (isolated SQLite, simulated network)', () => {
  let directory: string;
  let db: any;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-batch02-outbox-'));
    db = manager.getCompanyDatabase(directory, company);
  });
  afterEach(() => {
    manager.closeAllCompanyDatabases();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function add(id: string, sequence: number, dependency: string | null = null, status = 'PENDING', tenant = company) {
    insertOutboxOperation(db, { operation_id: id, company_id: tenant, command_type: 'ArchivePartyHistory',
      entity_type: 'party', entity_id: id, payload_json: '{}', payload_hash: computePayloadHash('{}'),
      causal_sequence: sequence, depends_on_operation_id: dependency, status, created_at: '2026-09-01T00:00:00.000Z' });
  }
  function network() {
    return { pushOperations: vi.fn(async (ops: any[]) => ({ results: ops.map(op => ({
      operationId: op.operationId, status: 'APPLIED', serverRevision: 1
    })) })) };
  }
  it('dispatches the independent 26th row with the default limit of 25', async () => {
    add('conflict', 0, null, 'CONFLICT');
    for (let i = 1; i <= 25; i++) add(`blocked-${i}`, i, 'conflict');
    add('independent-26', 26);
    const client = network();
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 1, synced: 1 });
    expect(client.pushOperations.mock.calls[0][0].map(op => op.operationId)).toEqual(['independent-26']);
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 0, blockedCount: 25 });
    expect(client.pushOperations).toHaveBeenCalledTimes(1);
  });
  it('does not starve independent rows behind 25 blocked children, and never skips overflow eligible rows', async () => {
    add('conflict', 0, null, 'CONFLICT');
    for (let i = 1; i <= 25; i++) add(`blocked-${i}`, i, 'conflict');
    for (let i = 26; i <= 56; i++) add(`independent-${i}`, i);
    const client = network();
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 25, synced: 25 });
    expect(client.pushOperations.mock.calls[0][0].map(op => op.operationId))
      .toEqual(Array.from({ length: 25 }, (_, i) => `independent-${26 + i}`));
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 6, synced: 6 });
    expect(client.pushOperations.mock.calls[1][0].map(op => op.operationId))
      .toEqual(Array.from({ length: 6 }, (_, i) => `independent-${51 + i}`));
    expect(getOperation(db, company, 'blocked-1').status).toBe('PENDING');
  });
  it('waits for persisted ACKs, not same-request parents, across multiple dependency levels', async () => {
    add('parent', 1); add('child', 2, 'parent'); add('grandchild', 3, 'child'); add('independent', 4);
    const client = network();
    for (const expected of [['parent', 'independent'], ['child'], ['grandchild']]) {
      await dispatchOutbox(db, company, client);
      expect(client.pushOperations.mock.lastCall![0].map(op => op.operationId)).toEqual(expected);
    }
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 0 });
  });
  it('is a no-op for blocked/missing/cyclic/cross-tenant dependencies, including non-SYNCED terminal parents', async () => {
    for (const status of ['CONFLICT', 'DEAD_LETTER', 'SUPERSEDED', 'SENDING']) {
      add(status, 0, null, status); add(`child-${status}`, 1, status);
    }
    add('foreign-parent', 0, null, 'SYNCED', 'other-company');
    add('foreign-child', 1, 'foreign-parent'); add('missing-child', 2, 'missing');
    add('cycle-a', 3, 'cycle-b'); add('cycle-b', 4, 'cycle-a');
    add('foreign-ready', 1, null, 'PENDING', 'other-company');
    const client = network();
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 0 });
    expect(client.pushOperations).not.toHaveBeenCalled();
    expect(getOperation(db, 'other-company', 'foreign-ready').status).toBe('PENDING');
  });
  it('retries transient failures without releasing children, and preserves ordering at a small limit', async () => {
    add('root', 1); add('child', 2, 'root'); add('independent', 3);
    const failed = { pushOperations: vi.fn(async () => { throw new Error('simulated offline'); }) };
    expect(await dispatchOutbox(db, company, failed, { batchSize: 1 })).toMatchObject({ attempted: 1, transientErrors: 1 });
    expect(getOperation(db, company, 'root').status).toBe('PENDING');
    const client = network();
    for (const id of ['root', 'child', 'independent']) {
      expect(await dispatchOutbox(db, company, client, { batchSize: 1 })).toMatchObject({ attempted: 1, synced: 1 });
      expect(client.pushOperations.mock.lastCall![0][0].operationId).toBe(id);
    }
  });
  it('caps oversized requests at the server maximum and leaves overflow eligible for the next dispatch', async () => {
    for (let i = 0; i < 101; i++) add(`operation-${i}`, i);
    const client = network();
    expect(await dispatchOutbox(db, company, client, { batchSize: 1000 })).toMatchObject({ attempted: 100, synced: 100 });
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 1, synced: 1 });
    expect(client.pushOperations.mock.lastCall![0][0].operationId).toBe('operation-100');
  });
});
