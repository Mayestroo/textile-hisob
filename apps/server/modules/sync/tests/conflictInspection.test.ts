import { describe, expect, it, vi } from 'vitest';

const Fastify = require('fastify');
const { createConflictInspectionHandler } = require('../handlers/conflictInspection.cjs');
const { canonicalStringify, computePayloadHash } = require('../canonicalPayload.cjs');
const tenant = 'inspection-tenant';
const originalId = '00000000-0000-4000-8000-000000000101';
const canonicalId = '00000000-0000-4000-8000-000000000102';
const operations = [{ id: 'sew', name: 'Sew', rate: 5 }];

function descriptor(type = 'UpsertModel') {
  const payload = type === 'UpsertModel'
    ? { companyId: tenant, commandId: 'cmd-model', operationId: 'op-model', modelId: 'model', name: 'M', operations, pattaOpsOrder: ['Sew'] }
    : { companyId: tenant, commandId: 'cmd-ticket', operationId: 'op-ticket', ticketId: originalId, modelId: 'model',
      partyRecordId: 'party', partyNumber: '45', pattaNumber: 7, periodId: 'P', qty: 100,
      entries: [{ opName: 'Sew', workerId: 1, qty: 40, rateSnapshot: 5 }, { opName: 'Sew', workerId: 2, qty: 60, rateSnapshot: 5 }] };
  return { companyId: tenant, operationId: payload.operationId, commandType: type,
    entityType: type === 'UpsertModel' ? 'model' : 'ticket', entityId: type === 'UpsertModel' ? 'model' : originalId,
    baseRevision: type === 'UpsertModel' ? 30 : 0, payload, payloadHash: computePayloadHash(canonicalStringify(payload)) };
}

async function inspect(op: any, overrides: any = {}) {
  const operationsToInspect = Array.isArray(op) ? op : [op];
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    if (sql.includes('FROM operations_dedup')) return { rows: overrides.accepted ? [{}] : [] };
    if (sql.includes('FROM allocation_resolution_fences')) return { rows: overrides.cancelled ? [{}] : [] };
    if (sql.includes('FROM models')) {
      expect(params).toEqual([tenant, 'model']);
      return { rows: [{ id: 'model', name: 'M', hisob_sheet_name: 'M-hisob', title: 'Model- M', party: '', color: '', size: '',
        operations_json: overrides.modelOperations || operations, patta_ops_order_json: ['Sew'], server_revision: 31 }] };
    }
    if (sql.includes('FROM tickets t')) {
      expect(params).toEqual([tenant, 'party', 7]);
      expect(sql).toContain('period.is_closed=0');
      return { rows: [{ id: canonicalId, model_id: 'model', party_record_id: 'party', party_number: '45', patta_number: 7,
        period_id: overrides.periodId || 'P', qty: overrides.qty || '100', size: null, color: null, konveyer: null,
        submitted_at: '2026-11-01T12:00:00Z', server_revision: 1 }] };
    }
    if (sql.includes('FROM ticket_entries')) return { rows: [
      { id: 'server-entry-a', op_name: 'Sew', worker_id: 1, qty: '40', rate_snapshot: overrides.rate ?? '5' },
      { id: 'server-entry-b', op_name: 'Sew', worker_id: 2, qty: '60', rate_snapshot: '5' }
    ] };
    return { rows: [] };
  });
  const app = Fastify();
  app.addHook('preHandler', async (request: any) => { request.auth = { companyId: tenant }; });
  app.post('/inspect', createConflictInspectionHandler({ connect: async () => ({ query, release() {} }) }));
  try { return { response: await app.inject({ method: 'POST', url: '/inspect', payload: { operations: operationsToInspect } }), query }; }
  finally { await app.close(); }
}

describe('authenticated conflict inspection (real handler, query doubles)', () => {
  it('reports exact model equivalence without modifying the newer server revision', async () => {
    const { response, query } = await inspect(descriptor());
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({ companyId: tenant, status: 'EQUIVALENT', canonicalEntityId: 'model', entityRevision: 31 });
    expect(query.mock.calls.some(([sql]) => /\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });

  it('keeps changed tariffs distinct instead of overwriting them', async () => {
    const { response } = await inspect(descriptor(), { modelOperations: [{ id: 'sew', name: 'Sew', rate: 6 }] });
    expect(response.json().results[0]).toMatchObject({ status: 'DIFFERENT', differingFields: ['operations'] });
    expect(response.json().results[0].snapshot).toBeUndefined();
  });

  it('returns the canonical duplicate with exact per-worker allocations and entry IDs', async () => {
    const { response } = await inspect(descriptor('SubmitTicket'));
    expect(response.json().results[0]).toMatchObject({ status: 'EQUIVALENT', canonicalEntityId: canonicalId,
      snapshot: { ticketId: canonicalId, qty: 100, entries: [
        { entryId: 'server-entry-a', qty: 40 }, { entryId: 'server-entry-b', qty: 60 }
      ] } });
  });

  it.each([{ qty: '101' }, { rate: '6' }, { periodId: 'different-period' }])('never merges a materially different patta: %j', async (overrides) => {
    const { response } = await inspect(descriptor('SubmitTicket'), overrides);
    expect(response.json().results[0].status).toBe('DIFFERENT');
  });

  it.each([{ accepted: true }, { cancelled: true }])('does not supersede acceptance/cancellation authority: %j', async (overrides) => {
    const { response } = await inspect(descriptor(), overrides);
    expect(response.json().results[0].status).not.toBe('EQUIVALENT');
  });

  it('does not let one historical validation refusal hide other conflicts in the batch', async () => {
    const invalid: any = descriptor('SubmitTicket');
    invalid.payload.entries = [];
    invalid.payloadHash = computePayloadHash(canonicalStringify(invalid.payload));
    const { response } = await inspect([invalid, descriptor()]);
    expect(response.statusCode).toBe(200);
    expect(response.json().results.map((result: any) => result.status)).toEqual(['NOT_ELIGIBLE', 'EQUIVALENT']);
    expect(response.json().results[0]).toMatchObject({ operationId: invalid.operationId, reason: 'INVALID_ENTRIES' });
  });

  it('rejects cross-company and altered-payload requests without reading their facts', async () => {
    const op = descriptor();
    const cross = await inspect({ ...op, companyId: 'other' });
    expect(cross.response.statusCode).toBe(400);
    expect(cross.query.mock.calls.some(([sql]) => sql.includes('FROM models'))).toBe(false);
    const tampered = await inspect({ ...op, payloadHash: '0'.repeat(64) });
    expect(tampered.response.statusCode).toBe(400);
  });
});
