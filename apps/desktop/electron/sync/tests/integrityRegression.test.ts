import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const manager = require('../../database/core/databaseManager.cjs');
const { applyChangesBatch, getLocalCursor } = require('../changeFeedApplier.cjs');
const { dispatchOutbox } = require('../outboxDispatcher.cjs');
const { insertOutboxOperation, getOperation } = require('../../database/outbox/outboxManager.cjs');
const { canonicalStringify, computePayloadHash } = require('../../../../server/modules/sync/canonicalPayload.cjs');
const { processSingleOperation } = require('../../../../server/modules/sync/handlers/operations.cjs');
const companyId = 'integrity-regression';
const createdAt = '2026-09-01T00:00:00.000Z';

describe('integrity batch 01 (SQLite and isolated server query doubles only)', () => {
  let directory: string;
  let db: any;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-integrity-'));
    db = manager.getCompanyDatabase(directory, companyId);
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-a', ?, 'Model', '[]', ?, ?)`).run(companyId, createdAt, createdAt);
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (71, ?, 'Worker', ?, ?)`).run(companyId, createdAt, createdAt);
  });
  afterEach(() => {
    manager.closeAllCompanyDatabases();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function adjustment(changeId: number, revision: number, status?: string, changeType = 'INSERT', extra = {}) {
    return { changeId: String(changeId), companyId, entityType: 'production_adjustment', entityId: 'adjustment-a',
      entityRevision: revision, changeType, committedAt: createdAt,
      payload: { modelId: 'model-a', workerId: 71, opName: 'Sew', deltaQty: 3, createdAt,
        ...(status === undefined ? {} : { status }), ...extra } };
  }
  function apply(item: any) { return applyChangesBatch(db, companyId, [item], item.changeId); }
  function fact() {
    return db.prepare(`SELECT status, server_revision, created_at FROM production_adjustments WHERE adjustment_id = 'adjustment-a'`).get();
  }

  it('retains review status, authoritative creation time and revision, including explicit UPDATE statuses', () => {
    apply(adjustment(1, 3, 'PENDING_REVIEW'));
    expect(fact()).toEqual({ status: 'PENDING_REVIEW', server_revision: 3, created_at: createdAt });
    apply(adjustment(2, 4, 'APPROVED', 'UPDATE'));
    expect(fact()).toEqual({ status: 'APPROVED', server_revision: 4, created_at: createdAt });
    apply(adjustment(3, 5, 'PENDING_REVIEW', 'UPDATE'));
    expect(fact().status).toBe('PENDING_REVIEW');
  });

  it('does not regress a newer adjustment on stale INSERT or UPDATE, or equal revision replay', () => {
    apply(adjustment(1, 5, 'REVERSED'));
    apply(adjustment(2, 4, 'APPROVED', 'UPDATE'));
    apply(adjustment(3, 3, 'PENDING_REVIEW'));
    apply(adjustment(4, 5, 'REVERSED', 'UPDATE'));
    expect(fact()).toEqual({ status: 'REVERSED', server_revision: 5, created_at: createdAt });
  });

  it.each(['INSERT', 'UPDATE'])('rejects unsupported adjustment status atomically on %s', (type) => {
    apply(adjustment(1, 1, 'APPROVED'));
    expect(() => apply(adjustment(2, 2, 'UNSUPPORTED', type))).toThrow();
    expect(getLocalCursor(db)).toBe(1);
    expect(fact().status).toBe('APPROVED');
  });

  it('reconciles an equal-revision optimistic adjustment with authoritative creation metadata', () => {
    apply(adjustment(1, 1, 'PENDING_REVIEW'));
    db.prepare(`UPDATE production_adjustments SET created_at = '2026-08-31T00:00:00.000Z', created_by = 'local'`).run();
    apply(adjustment(2, 1, 'PENDING_REVIEW', 'INSERT', { createdBy: 'trusted-operator' }));
    expect(fact()).toEqual({ status: 'PENDING_REVIEW', server_revision: 1, created_at: createdAt });
    expect(db.prepare('SELECT created_by FROM production_adjustments').get().created_by).toBe('trusted-operator');
  });

  it('does not interpret an unrecognized statusless UPDATE as a reversal', () => {
    apply(adjustment(1, 1));
    expect(() => apply(adjustment(2, 2, undefined, 'UPDATE'))).toThrow('INVALID_PRODUCTION_ADJUSTMENT_STATUS');
    expect(fact().status).toBe('APPROVED');
  });

  it('accepts legacy default-approved inserts and actual command-shaped reversal events', () => {
    apply(adjustment(1, 1));
    expect(fact().status).toBe('APPROVED');
    const payload = { reversalId: 'reversal-a', originalAdjustmentId: 'adjustment-a', reason: 'Correction',
      createdAt: '2026-09-02T00:00:00.000Z' };
    apply({ ...adjustment(2, 2), changeType: 'UPDATE', payload });
    apply({ ...adjustment(3, 1), entityId: 'reversal-a', payload });
    expect(fact()).toEqual({ status: 'REVERSED', server_revision: 2, created_at: createdAt });
    expect(db.prepare(`SELECT status, delta_qty, model_id, worker_id, original_adjustment_id, server_revision
      FROM production_adjustments WHERE adjustment_id = 'reversal-a'`).get()).toEqual({
      status: 'REVERSED', delta_qty: -3, model_id: 'model-a', worker_id: 71,
      original_adjustment_id: 'adjustment-a', server_revision: 1
    });
  });

  async function ack(commandType: string, entityType: string, entityId: string, payload = {}, revision = 4) {
    const operationId = 'operation-ack';
    const ackPeriod = commandType === 'SubmitTicket'
      ? db.prepare('SELECT period_id FROM tickets WHERE company_id = ? AND id = ?').get(companyId, entityId)?.period_id || null
      : 'old-period';
    const json = canonicalStringify(payload);
    insertOutboxOperation(db, { operation_id: operationId, company_id: companyId,
      command_type: commandType, entity_type: entityType, entity_id: entityId, base_revision: 3,
      payload_json: json, payload_hash: computePayloadHash(json), causal_sequence: 1, status: 'PENDING' });
    await dispatchOutbox(db, companyId, { pushOperations: async () => ({ results: [
      { operationId, status: 'APPLIED', serverRevision: revision, committedAt: createdAt, periodId: ackPeriod }
    ] }) });
    expect(getOperation(db, companyId, operationId).status).toBe('SYNCED');
  }
  function period(id: string, revision = 5, status = 'CLOSED') {
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, status, is_closed, closed_at, server_revision, created_at)
      VALUES (?, ?, 'Period', '2026-09-01', ?, ?, ?, ?, ?)`).run(id, companyId, status, status === 'CLOSED' ? 1 : 0,
        status === 'CLOSED' ? createdAt : null, revision, createdAt);
  }

  it('ACKs an old UpdatePeriod without reopening CLOSED/rev5 or reducing its revision', async () => {
    period('period-a');
    await ack('UpdatePeriod', 'period', 'period-a');
    expect(db.prepare(`SELECT status, is_closed, closed_at, server_revision FROM periods WHERE id = 'period-a'`).get())
      .toEqual({ status: 'CLOSED', is_closed: 1, closed_at: createdAt, server_revision: 5 });
  });
  it('does not reopen a subsequently closed next period on an old ClosePeriod ACK', async () => {
    period('period-a');
    period('period-next', 2);
    await ack('ClosePeriod', 'period', 'period-a', { nextPeriod: { id: 'period-next' } });
    expect(db.prepare(`SELECT status, is_closed, server_revision FROM periods WHERE id = 'period-next'`).get())
      .toEqual({ status: 'CLOSED', is_closed: 1, server_revision: 2 });
  });
  it('still accepts equal-revision optimistic period state', async () => {
    period('period-a', 4, 'CLOSING');
    await ack('ClosePeriod', 'period', 'period-a');
    expect(db.prepare(`SELECT status, is_closed, server_revision FROM periods WHERE id = 'period-a'`).get())
      .toEqual({ status: 'CLOSED', is_closed: 1, server_revision: 4 });
  });

  it.each([
    ['UpsertModel', 'model', 'models', 'model-a', 'INACTIVE'],
    ['DeactivateModel', 'model', 'models', 'model-a', 'ACTIVE'],
    ['UpsertWorker', 'worker', 'workers', 71, 'INACTIVE'],
    ['DeactivateWorker', 'worker', 'workers', 71, 'ACTIVE'],
    ['ActivateWorker', 'worker', 'workers', 71, 'INACTIVE']
  ])('preserves newer lifecycle facts on stale %s ACK', async (command, type, table, id, status) => {
    db.prepare(`UPDATE ${table} SET status = ?, server_revision = 5 WHERE id = ?`).run(status, id);
    await ack(String(command), String(type), String(id));
    expect(db.prepare(`SELECT status, server_revision FROM ${table} WHERE id = ?`).get(id))
      .toEqual({ status, server_revision: 5 });
  });
  it.each(['CreateParty', 'UpdateParty', 'CloseParty'])('preserves newer party state on %s ACK', async (command) => {
    const status = command === 'CloseParty' ? 'ACTIVE' : 'CLOSED';
    db.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, is_closed, server_revision, created_at, updated_at)
      VALUES ('party-a', ?, '1', '1', 'model-a', ?, ?, 5, ?, ?)`).run(companyId, status, status === 'CLOSED' ? 1 : 0, createdAt, createdAt);
    await ack(command, 'party', 'party-a', { partyRecordId: 'party-a' });
    expect(db.prepare(`SELECT status, server_revision FROM parties WHERE id = 'party-a'`).get())
      .toEqual({ status, server_revision: 5 });
  });
  it.each(['SubmitTicket', 'DeleteTicket', 'UpdateTicket'])('preserves newer ticket facts on %s ACK', async (command) => {
    const status = command === 'DeleteTicket' ? 'CONFIRMED' : 'VOIDED';
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, patta_number, qty, status, server_revision, submitted_at, created_at)
      VALUES ('ticket-a', ?, 'model-a', '1', 1, 1, ?, 5, ?, ?)`).run(companyId, status, createdAt, createdAt);
    await ack(command, 'ticket', 'ticket-a');
    expect(db.prepare(`SELECT status, server_revision, period_id FROM tickets WHERE id = 'ticket-a'`).get())
      .toEqual({ status, server_revision: 5, period_id: null });
  });

  it.each([
    ['UpsertModel', 'model', 'models', 'model-a', 'ACTIVE'],
    ['DeactivateWorker', 'worker', 'workers', '71', 'INACTIVE'],
    ['ActivateWorker', 'worker', 'workers', '71', 'ACTIVE']
  ])('accepts equal-revision %s ACKs', async (command, type, table, id, status) => {
    db.prepare(`UPDATE ${table} SET server_revision = 4 WHERE id = ?`).run(id);
    await ack(command, type, id);
    expect(db.prepare(`SELECT status, server_revision FROM ${table} WHERE id = ?`).get(id))
      .toEqual({ status, server_revision: 4 });
  });

  it('accepts equal-revision optimistic ticket submission', async () => {
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, patta_number, qty, status, server_revision, submitted_at, created_at)
      VALUES ('ticket-a', ?, 'model-a', '1', 1, 1, 'PENDING_SYNC', 4, ?, ?)`).run(companyId, createdAt, createdAt);
    await ack('SubmitTicket', 'ticket', 'ticket-a');
    expect(db.prepare(`SELECT status, server_revision FROM tickets WHERE id = 'ticket-a'`).get())
      .toEqual({ status: 'CONFIRMED', server_revision: 4 });
  });

  it('accepts equal-revision optimistic party closure', async () => {
    db.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, server_revision, created_at, updated_at)
      VALUES ('party-a', ?, '1', '1', 'model-a', 'CLOSE_PENDING', 4, ?, ?)`).run(companyId, createdAt, createdAt);
    await ack('CloseParty', 'party', 'party-a', { partyRecordId: 'party-a' });
    expect(db.prepare(`SELECT status, is_closed, server_revision FROM parties WHERE id = 'party-a'`).get())
      .toEqual({ status: 'CLOSED', is_closed: 1, server_revision: 4 });
  });

  function operation(commandType = 'ActivateWorker', entityType = 'worker', entityId = '71', extra = {}) {
    const payload = { commandId: 'command-dedup', operationId: 'operation-dedup', companyId, workerId: 71, ...extra };
    return { operationId: payload.operationId, companyId, commandType, entityType, entityId, baseRevision: 3,
      payload, payloadHash: computePayloadHash(canonicalStringify(payload)) };
  }
  async function replay(op: any, stored: any, aliases: Record<string, string> = {}) {
    const client = { release() {}, query: async (sql: string, values: any[] = []) => {
      if (/FROM operations_dedup/.test(sql)) {
        expect(values).toEqual([companyId, op.operationId]);
        return { rows: [stored] };
      }
      if (/FROM (model|party)_id_aliases/.test(sql)) {
        expect(values[0]).toBe(companyId);
        const type = sql.includes('model_id_aliases') ? 'model' : 'party';
        return { rows: aliases[values[1]] ? [{ [`canonical_${type}_id`]: aliases[values[1]] }] : [] };
      }
      if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) throw new Error('Replay must not mutate facts');
      return { rows: [] };
    } };
    return processSingleOperation({ connect: async () => client }, { auth: { companyId, deviceId: 'test' } }, op);
  }
  function stored(op: any, extra = {}) {
    return { company_id: companyId, operation_id: op.operationId, command_type: op.commandType,
      entity_type: op.entityType, entity_id: op.entityId, payload_hash: op.payloadHash,
      result_json: { cursor: '9' }, server_revision: 4, accepted_at: createdAt, ...extra };
  }
  it.each(['ActivateWorker', 'DeactivateWorker'])('rejects %s replay of the opposite command with identical valid payload/hash', async (command) => {
    const op = operation(command);
    expect(await replay(op, stored(op, { command_type: command === 'ActivateWorker' ? 'DeactivateWorker' : 'ActivateWorker' })))
      .toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
  it.each([{ entity_type: 'model' }, { entity_id: '72' }])('rejects same-hash replay for different stored identity %j', async (metadata) => {
    const op = operation();
    expect(await replay(op, stored(op, metadata))).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
  it('accepts the same worker operation with a numeric stored worker identity', async () => {
    const op = operation('ActivateWorker', 'worker', '0071', { workerId: '0071' });
    expect(await replay(op, stored(op, { entity_id: 71 }))).toMatchObject({ status: 'APPLIED', isReplay: true });
  });
  it.each(['model', 'party'])('accepts legacy %s requests whose dedup row stores the canonical target', async (type) => {
    const op = type === 'model'
      ? operation('UpsertModel', type, 'legacy-a', { modelId: 'legacy-a', name: 'Model', operations: [{ name: 'Sew', rate: 1 }] })
      : operation('CloseParty', type, 'legacy-a', { partyRecordId: 'legacy-a' });
    expect(await replay(op, stored(op, { entity_id: 'canonical-a' }), { 'legacy-a': 'canonical-a' }))
      .toMatchObject({ status: 'APPLIED', isReplay: true });
    expect(await replay(op, stored(op, { entity_id: 'older-legacy-a' }), {
      'legacy-a': 'canonical-a', 'older-legacy-a': 'canonical-a'
    })).toMatchObject({ status: 'APPLIED', isReplay: true });
    expect(await replay(op, stored(op, { entity_id: 'unrelated' }), { 'legacy-a': 'canonical-a' }))
      .toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
});
