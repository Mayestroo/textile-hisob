import { describe, expect, it, vi } from 'vitest';

const { processSingleOperation } = require('../handlers/operations.cjs');
const { canonicalStringify, computePayloadHash } = require('../canonicalPayload.cjs');
const companyId = 'free-mode-test';
const ticketId = '00000000-0000-4000-8000-000000001901';

function submission(overrides: any = {}) {
  return { commandId: 'cmd-free', operationId: 'op-free', companyId, ticketId,
    modelId: 'model', periodId: 'open', partyNumber: "No'malum Partiya", partyRecordId: null,
    pattaNumber: 0, strictParty: false, strictPatta: false, allocationVersion: 1,
    qty: 5, effectiveDate: '2026-11-17', submittedAt: '2026-11-17T08:00:00Z',
    entries: [{ opName: 'Sew', workerId: 1, qty: 5 }], ...overrides };
}

// Real command validation/handler with a query double, not a PostgreSQL durability test.
function fixture(options: any = {}) {
  const receipts = new Map<string, any>();
  const tickets = new Map<string, any>();
  const entries: any[] = [];
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    if (sql.includes('FROM operations_dedup')) return { rows: receipts.has(params[1]) ? [receipts.get(params[1])] : [] };
    if (sql.includes('FROM periods') && sql.includes('is_closed = 1')) return { rows: options.closed ? [{ id: 'closed' }] : [] };
    if (sql.includes('FROM periods')) return { rows: options.noPeriod ? [] : [{ id: 'open', start_date: '2026-11-01', end_date: null }] };
    if (sql.includes('FROM activation_companies')) return { rows: [{ is_active: true, require_ticket_validation: options.defaultStrict !== false }] };
    if (sql.includes('FROM tickets')) return { rows: tickets.has(params[1]) ? [tickets.get(params[1])] : [] };
    if (sql.includes('FROM models')) return { rows: [{ id: 'model', operations_json: [{ name: 'Sew', rate: 7 }], status: 'ACTIVE' }] };
    if (sql.includes('FROM workers')) return { rows: [{ id: 1, name: 'Worker', status: options.inactiveWorker ? 'INACTIVE' : 'ACTIVE' }] };
    if (sql.includes('FROM parties p')) return { rows: [{ id: 'party', model_id: 'model', party_number: '1', ish_soni_per_patta: 10 }] };
    if (sql.includes('INSERT INTO tickets')) tickets.set(params[0], { id: params[0], model_id: params[2],
      period_id: params[3], party_number: params[4], party_record_id: params[5], patta_number: params[6],
      qty: params[7], status: 'CONFIRMED', is_closed: 0, server_revision: 1 });
    if (sql.includes('FROM ticket_entries')) return { rows: entries };
    if (sql.includes('INSERT INTO ticket_entries')) entries.push({ id: params[0], op_name: params[3],
      worker_id: params[4], rate_snapshot: params[6], qty: params[8] });
    if (sql.includes('INSERT INTO change_log')) return { rows: [{ change_id: 1, committed_at: '2026-11-17T08:00:00Z' }] };
    if (sql.includes('INSERT INTO operations_dedup')) receipts.set(params[1], { company_id: params[0], operation_id: params[1],
      command_type: params[2], entity_type: params[3], entity_id: params[4], payload_hash: params[5],
      result_json: params[6], server_revision: params[7], accepted_at: params[8] });
    return { rows: [] };
  });
  const pool = { connect: async () => ({ query, release: vi.fn() }) };
  const apply = (payload: any, commandType = 'SubmitTicket') => processSingleOperation(pool,
    { auth: { companyId, deviceId: 'device' } }, { operationId: payload.operationId, companyId,
      commandType, entityType: 'ticket', entityId: payload.ticketId,
      ...(commandType === 'UpdateTicket' ? { baseRevision: payload.baseRevision } : {}),
      payload, payloadHash: computePayloadHash(canonicalStringify(payload)) });
  return { apply, query, tickets, entries };
}

describe('free-mode work acceptance', () => {
  it('accepts unnumbered work in an open period without manufacturing a party and replays it once', async () => {
    const db = fixture();
    const payload = submission();
    expect(await db.apply(payload)).toMatchObject({ status: 'APPLIED', periodId: 'open', isReplay: false });
    expect(await db.apply(payload)).toMatchObject({ status: 'APPLIED', isReplay: true });
    expect(db.tickets.get(ticketId)).toMatchObject({ party_record_id: null, patta_number: 0, qty: 5 });
    expect(db.tickets.size).toBe(1);
    expect(db.entries).toHaveLength(1);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO parties'))).toBe(false);
  });

  it('honors free-mode company policy for older payloads without per-ticket switches', async () => {
    const db = fixture({ defaultStrict: false });
    const payload = submission();
    delete payload.strictParty;
    delete payload.strictPatta;
    expect(await db.apply(payload)).toMatchObject({ status: 'APPLIED' });
  });

  it.each([
    { changes: { strictParty: true }, code: 'PARTY_RECORD_REQUIRED' },
    { changes: { strictPatta: true }, code: 'PATTA_NUMBER_REQUIRED' },
    { changes: { entries: [{ opName: 'Sew', workerId: 1, qty: 6 }] }, code: 'PATTA_OPERATION_OVERALLOCATED' },
    { changes: { partyRecordId: 'party', partyNumber: '1', pattaNumber: 1 }, code: 'ALLOCATION_REVIEW_REQUIRED' }
  ])('retains strict and allocation checks: $code', async ({ changes, code }) => {
    const db = fixture();
    expect(await db.apply(submission(changes))).toMatchObject({ error: { code } });
    expect(db.tickets.size).toBe(0);
  });

  it.each([
    { options: { closed: true }, code: 'PERIOD_CLOSED' },
    { options: { inactiveWorker: true }, code: 'WORKER_INACTIVE' },
    { options: { noPeriod: true }, code: 'PERIOD_SCOPE_MISMATCH' }
  ])('does not bypass server authority: $code', async ({ options, code }) => {
    const db = fixture(options);
    expect(await db.apply(submission())).toMatchObject({ error: { code } });
    expect(db.tickets.size).toBe(0);
  });

  it('keeps legacy unlinked work in review when no accounting period can be verified', async () => {
    const db = fixture({ noPeriod: true });
    const payload = submission({ periodId: null });
    delete payload.allocationVersion;
    expect(await db.apply(payload)).toMatchObject({ status: 'CONFLICT', error: { code: 'ALLOCATION_REVIEW_REQUIRED' } });
  });

  it('permits worker allocation edits on an accepted free-mode ticket, but not after period close', async () => {
    const options = { noPeriod: false };
    const db = fixture(options);
    expect(await db.apply(submission())).toMatchObject({ status: 'APPLIED' });
    const edit = { commandId: 'cmd-edit', operationId: 'op-edit', companyId, ticketId, baseRevision: 1,
      entries: [{ entryId: `${ticketId}_entry_1`, opName: 'Sew', workerId: 1, qty: 3 }] };
    expect(await db.apply(edit, 'UpdateTicket')).toMatchObject({ status: 'APPLIED', serverRevision: 2 });
    options.noPeriod = true;
    expect(await db.apply({ ...edit, operationId: 'op-edit-closed' }, 'UpdateTicket'))
      .toMatchObject({ status: 'REJECTED', error: { code: 'TICKET_NOT_EDITABLE' } });
  });
});
