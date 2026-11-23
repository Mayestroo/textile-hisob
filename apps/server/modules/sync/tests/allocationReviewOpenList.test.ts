import { describe, expect, it } from 'vitest';

const { listOpenAllocationReviews } = require('../allocationResolution.cjs');
const { createOperationStatusHandler } = require('../handlers/operations.cjs');

const reviewer = { companyId: 'comp_novda', operator: { companyId: 'comp_novda', isActive: true, role: 'admin', operatorId: 'op-admin' } };

function replyStub() {
  const reply: any = { statusCode: 200, body: null };
  reply.code = (code: number) => { reply.statusCode = code; return reply; };
  reply.send = (body: any) => { reply.body = body; return reply; };
  return reply;
}

describe('company-wide allocation review list', () => {
  it('returns open reviews with the party issued quantity for a reviewer', async () => {
    const queries: any[] = [];
    const pool = { query: async (sql: string, params: any[]) => {
      queries.push({ sql, params });
      return { rows: [{ original_operation_id: 'op-409', command_type: 'SubmitTicket', entity_id: 'ticket-1',
        original_payload_hash: 'a'.repeat(64), original_payload_json: { qty: 409, partyRecordId: 'party-205' },
        review_reason: 'Ticket quantity does not match authoritative issuance', recorded_at: new Date('2026-11-23T07:34:29Z'),
        ish_soni_per_patta: 410, model_name: 'Kofta' }] };
    } };
    const reviews = await listOpenAllocationReviews(pool, { auth: reviewer });
    expect(reviews).toEqual([expect.objectContaining({ operationId: 'op-409', issuedQty: 410, payload: { qty: 409, partyRecordId: 'party-205' },
      recordedAt: '2026-11-23T07:34:29.000Z' })]);
    expect(queries[0].sql).toContain('allocation_resolution_fences');
    expect(queries[0].params).toEqual(['comp_novda']);
  });

  it('refuses a typer session', async () => {
    const pool = { query: async () => ({ rows: [] }) };
    await expect(listOpenAllocationReviews(pool, { auth: { ...reviewer, operator: { ...reviewer.operator, role: 'typer' } } }))
      .rejects.toMatchObject({ code: 'ALLOCATION_REVIEW_UNAUTHORIZED' });
  });
});

describe('operation status reports reviewer cancellations', () => {
  it('returns CANCELLED for a fenced operation with the same payload hash', async () => {
    const hash = 'b'.repeat(64);
    const pool = { query: async (sql: string) => sql.includes('operations_dedup')
      ? { rows: [] }
      : { rows: [{ original_operation_id: 'op-409', original_payload_hash: hash, resolution_operation_id: 'res-1',
        reason: '409 o‘rniga 410', created_at: new Date('2026-11-23T08:00:00Z') }] } };
    const reply = replyStub();
    await createOperationStatusHandler(pool)({ auth: { companyId: 'comp_novda' }, body: { operations: [
      { operationId: 'op-409', payloadHash: hash }, { operationId: 'op-other', payloadHash: 'c'.repeat(64) }
    ] } }, reply);
    expect(reply.body.results).toEqual([
      { operationId: 'op-409', payloadHash: hash, status: 'CANCELLED', resolutionOperationId: 'res-1',
        reason: '409 o‘rniga 410', cancelledAt: '2026-11-23T08:00:00.000Z' },
      { operationId: 'op-other', status: 'NOT_FOUND' }
    ]);
  });
});
