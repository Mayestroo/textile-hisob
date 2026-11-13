import { describe, expect, it } from 'vitest';
import { canonicalStringify, computePayloadHash } from '../canonicalPayload.cjs';

const {
  MAX_OPERATIONS,
  MAX_PAYLOAD_BYTES,
  createValidationError,
  validateCommandPayload,
  validateOperationEnvelope
} = require('../payloadValidation.cjs');
const {
  processSingleOperation,
  resolveTrustedAuditActor,
  resolveTicketValidationMode,
  executeUpdateTicket,
  resolveTicketPeriodForDate
} = require('../handlers/operations.cjs');

const COMPANY = 'company-validation';
const TICKET_ID = '00000000-0000-4000-8000-000000000501';
const OPERATOR = {
  operatorId: 'operator-1',
  companyId: COMPANY,
  deviceId: 'device-1',
  role: 'admin',
  isActive: true
};

function ticketPayload(overrides: Record<string, unknown> = {}) {
  return {
    commandId: 'command-1',
    operationId: 'operation-1',
    companyId: COMPANY,
    ticketId: TICKET_ID,
    modelId: 'model-1',
    partyNumber: '2',
    partyRecordId: 'rec_1788774889449_vrbkv',
    pattaNumber: 1,
    qty: 10,
    entries: [{ opName: 'Bichish', workerId: 1, qty: 10 }],
    effectiveDate: '2026-09-22',
    ...overrides
  };
}

function envelope(commandType: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    operationId: payload.operationId,
    companyId: COMPANY,
    commandType,
    entityType: commandType === 'SubmitTicket' || commandType === 'UpdateTicket' || commandType === 'DeleteTicket' ? 'ticket' : commandType === 'CreateParty' || commandType === 'UpdateParty' || commandType === 'CloseParty' ? 'party' : commandType === 'ResolveMigrationReconciliationCandidate' ? 'reconciliation_candidate' : 'production_adjustment',
    entityId: payload.ticketId || payload.adjustmentId || payload.reversalId || payload.partyRecordId || payload.candidateId,
    payloadHash: computePayloadHash(canonicalStringify(payload)),
    payload,
    ...overrides
  };
}

function workbookEnvelope(commandType: string, entityType: string, entityId: string, payload: Record<string, unknown>, baseRevision = 0) {
  return {
    operationId: payload.operationId,
    companyId: COMPANY,
    commandType,
    entityType,
    entityId,
    baseRevision,
    payloadHash: computePayloadHash(canonicalStringify(payload)),
    payload
  };
}

function context(operation: any = undefined) {
  return { companyId: COMPANY, operation, auth: { companyId: COMPANY, deviceId: 'device-1', operator: OPERATOR } };
}

function expectCode(action: () => unknown, code: string) {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

describe(' payload and authority validation', () => {
  it.each(['RegisterStajDebt', 'AllocateStajDebt', 'ReverseStajDebtAllocation'])(
    'fails closed on new %s writes until evidence verification policy is approved', async (commandType) => {
      const queries: string[] = [];
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.includes('FROM operations_dedup')) return { rows: [] };
          return { rows: [] };
        },
        release: () => undefined
      };
      const pool = { connect: async () => client } as any;
      const payload = { commandId: `cmd-${commandType}`, operationId: `op-${commandType}`,
        companyId: COMPANY, debtId: 'debt-test-1' };
      const operation = {
        operationId: payload.operationId, companyId: COMPANY, commandType,
        entityType: 'staj_debt', entityId: payload.debtId,
        payloadHash: computePayloadHash(canonicalStringify(payload)), payload
      };

      await expect(processSingleOperation(pool, { auth: { companyId: COMPANY, deviceId: 'device-1', operator: OPERATOR } }, operation))
        .resolves.toMatchObject({ status: 'REJECTED', error: { code: 'STAJ_DEBT_OPERATIONS_DISABLED' } });
      expect(queries.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
      expect(queries).toContain('ROLLBACK');
    }
  );

  it('refuses to replace a captured period with the current open period', async () => {
    const client = {
      query: async () => ({ rows: [
        { id: 'period-current', start_date: '2026-09-01', end_date: null }
      ] })
    };

    await expect(resolveTicketPeriodForDate(client, COMPANY, '2026-09-22', 'period-old'))
      .rejects.toMatchObject({ code: 'PERIOD_SCOPE_MISMATCH' });
  });

  it('carries an old-dated printed patta into its explicitly captured current open period', async () => {
    const client = { query: async () => ({ rows: [
      { id: 'period-november', start_date: '2026-11-05', end_date: null }
    ] }) };

    await expect(resolveTicketPeriodForDate(client, COMPANY, '2026-09-25', 'period-november', true))
      .resolves.toBe('period-november');
  });

  it.each([5, 0, 9])('accepts captured rate %s without turning it into current tariff 9', async (rate) => {
    const insertedRates: unknown[] = [];
    const pool = { connect: async () => ({
      query: async (sql: string, args: unknown[] = []) => {
        if (sql.includes('FROM periods') && sql.includes('is_closed = 0')) return { rows: [{ id: 'period-original', start_date: '2026-09-01', end_date: null }] };
        if (sql.includes('FROM models WHERE')) return { rows: [{ id: 'model-1', status: 'ACTIVE', operations_json: [{ name: 'Bichish', rate: 9 }] }] };
        if (sql.includes('FROM workers WHERE')) return { rows: [{ id: 1, status: 'ACTIVE' }] };
        if (sql.includes('FROM parties p')) return { rows: [{ id: 'rec_1788774889449_vrbkv', party_number: '2', model_id: 'model-1', ish_soni_per_patta: 10, patta_start_number: null, patta_end_number: null }] };
        if (sql.includes('INSERT INTO ticket_entries')) insertedRates.push(args[6]);
        if (sql.includes('INSERT INTO change_log')) return { rows: [{ change_id: 7, committed_at: '2026-09-22T10:00:00.000Z' }] };
        return { rows: [] };
      }, release: () => undefined
    }) } as any;
    const payload = ticketPayload({ periodId: 'period-original', strictParty: false, strictPatta: false,
      entries: [{ opName: 'Bichish', workerId: 1, rateSnapshot: rate }] });
    const result = await processSingleOperation(pool, { auth: { companyId: COMPANY, deviceId: 'device-1' } }, envelope('SubmitTicket', payload));
    expect(result).toMatchObject({ status: 'APPLIED', periodId: 'period-original' });
    expect(insertedRates).toEqual([rate]);
  });

  it('accepts operator-session positive capture with a legacy omitted period resolved from the work date', async () => {
    const writes: unknown[] = [];
    const pool = { connect: async () => ({
      query: async (sql: string, args: unknown[] = []) => {
        if (sql.includes('FROM periods') && sql.includes('is_closed = 0')) return { rows: [
          { id: 'period-october', start_date: '2026-10-01', end_date: null },
          { id: 'period-september', start_date: '2026-09-01', end_date: '2026-09-30' }
        ] };
        if (sql.includes('FROM models WHERE')) return { rows: [{ id: 'model-1', status: 'ACTIVE', operations_json: [{ name: 'Bichish', rate: 9 }] }] };
        if (sql.includes('FROM workers WHERE')) return { rows: [{ id: 1, status: 'ACTIVE' }] };
        if (sql.includes('FROM parties p')) return { rows: [{ id: 'rec_1788774889449_vrbkv', party_number: '2', model_id: 'model-1', ish_soni_per_patta: 10, patta_start_number: null, patta_end_number: null }] };
        if (sql.includes('INSERT INTO ticket_entries')) writes.push(args[6]);
        if (sql.includes('INSERT INTO change_log')) return { rows: [{ change_id: 8, committed_at: '2026-09-22T10:00:00.000Z' }] };
        return { rows: [] };
      }, release: () => undefined
    }) } as any;
    const payload = ticketPayload({ strictParty: false, strictPatta: false,
      entries: [{ opName: 'Bichish', workerId: 1, rateSnapshot: 5 }] });
    const result = await processSingleOperation(pool, { auth: { companyId: COMPANY, deviceId: 'device-1', operator: OPERATOR } },
      envelope('SubmitTicket', payload));
    expect(result).toMatchObject({ status: 'APPLIED', periodId: 'period-september' });
    expect(writes).toEqual([5]);
  });

  it('accepts an explicitly unknown legacy rate as null, never the model tariff', async () => {
    const insertedRates: unknown[] = [];
    const pool = { connect: async () => ({
      query: async (sql: string, args: unknown[] = []) => {
        if (sql.includes('FROM periods') && sql.includes('is_closed = 0')) return { rows: [{ id: 'period-original', start_date: '2026-09-01', end_date: null }] };
        if (sql.includes('FROM models WHERE')) return { rows: [{ id: 'model-1', status: 'ACTIVE', operations_json: [{ name: 'Bichish', rate: 9 }] }] };
        if (sql.includes('FROM workers WHERE')) return { rows: [{ id: 1, status: 'ACTIVE' }] };
        if (sql.includes('FROM parties p')) return { rows: [{ id: 'rec_1788774889449_vrbkv', party_number: '2', model_id: 'model-1', ish_soni_per_patta: 10, patta_start_number: null, patta_end_number: null }] };
        if (sql.includes('INSERT INTO ticket_entries')) insertedRates.push(args[6]);
        if (sql.includes('INSERT INTO change_log')) return { rows: [{ change_id: 7, committed_at: '2026-09-22T10:00:00.000Z' }] };
        return { rows: [] };
      }, release: () => undefined
    }) } as any;
    const payload = ticketPayload({ periodId: 'period-original', strictParty: false, strictPatta: false,
      entries: [{ opName: 'Bichish', workerId: 1, rateSnapshot: null }] });
    const result = await processSingleOperation(pool, { auth: { companyId: COMPANY, deviceId: 'device-1' } }, envelope('SubmitTicket', payload));
    expect(result).toMatchObject({ status: 'APPLIED', periodId: 'period-original' });
    expect(insertedRates).toEqual([null]);
  });

  it('resolves a legacy missing period by recorded work date, retaining unknown for companies without periods', async () => {
    const client = { query: async () => ({ rows: [{ id: 'period-new', start_date: '2026-09-01', end_date: null }] }) };
    await expect(resolveTicketPeriodForDate(client, COMPANY, '2026-09-22'))
      .resolves.toBe('period-new');
    await expect(resolveTicketPeriodForDate({ query: async () => ({ rows: [] }) }, COMPANY, '2026-09-22'))
      .resolves.toBeNull();
  });

  it('rejects ticket dates that are outside every open period without changing the date', async () => {
    const client = {
      query: async () => ({ rows: [
        { id: 'period-current', start_date: '2026-10-01', end_date: null }
      ] })
    };

    await expect(resolveTicketPeriodForDate(client, COMPANY, '2026-09-22', 'period-current'))
      .rejects.toMatchObject({
        code: 'PERIOD_SCOPE_MISMATCH',
        details: { effectiveDate: '2026-09-22', requestedPeriodId: 'period-current' }
      });
  });

  it('validates canonical ticket deletion identity and company scope', () => {
    const payload = { commandId: 'delete-cmd', operationId: 'delete-op', companyId: COMPANY, ticketId: TICKET_ID };
    const operation = envelope('DeleteTicket', payload);
    expect(validateCommandPayload('DeleteTicket', payload, context(operation))).toMatchObject({ ticketId: TICKET_ID, companyId: COMPANY });
    expectCode(() => validateCommandPayload('DeleteTicket', payload, context({ ...operation, entityId: 'other-ticket' })), 'ENTITY_ID_MISMATCH');
  });

  it('validates ticket entry edits against ticket identity and base revision', () => {
    const payload = {
      commandId: 'edit-command', operationId: 'edit-operation', companyId: COMPANY,
      ticketId: TICKET_ID, entries: [{ opName: 'Sew', workerId: 71 }]
    };
    const operation = envelope('UpdateTicket', payload, { baseRevision: 4 });
    expect(validateCommandPayload('UpdateTicket', payload, context(operation))).toMatchObject({
      ticketId: TICKET_ID, baseRevision: 4, entries: [{ opName: 'Sew', workerId: 71 }]
    });
    expectCode(() => validateCommandPayload('UpdateTicket', payload, context({ ...operation, entityId: 'other-ticket' })), 'ENTITY_ID_MISMATCH');
    expectCode(() => validateCommandPayload('UpdateTicket', payload, context({ ...operation, baseRevision: undefined })), 'MISSING_BASE_REVISION');
    expect(validateCommandPayload('UpdateTicket', { ...payload, entries: [{ ...payload.entries[0], entryId: 'old-sew' }] }, context(operation)).entries[0].entryId).toBe('old-sew');
  });

  it('preserves explicit per-ticket strict/free switches and rejects non-boolean values', () => {
    const freeTicket = ticketPayload({
      partyNumber: "No'malum Partiya",
      partyRecordId: null,
      pattaNumber: 0,
      strictParty: false,
      strictPatta: false
    });
    expect(validateCommandPayload('SubmitTicket', freeTicket, context(envelope('SubmitTicket', freeTicket))))
      .toMatchObject({ partyRecordId: null, pattaNumber: 0, strictParty: false, strictPatta: false });
    const invalidMode = { ...freeTicket, strictParty: 'false' };
    expectCode(() => validateCommandPayload('SubmitTicket', invalidMode, context(envelope('SubmitTicket', invalidMode))), 'INVALID_TICKET_VALIDATION_MODE');
  });

  it('uses the company setting as the default while honoring the selected per-ticket switches', () => {
    expect(resolveTicketValidationMode({}, { require_ticket_validation: true }))
      .toEqual({ strictParty: true, strictPatta: true });
    expect(resolveTicketValidationMode({}, { require_ticket_validation: false }))
      .toEqual({ strictParty: false, strictPatta: false });
    expect(resolveTicketValidationMode({ strictParty: false, strictPatta: false }, { require_ticket_validation: true }))
      .toEqual({ strictParty: false, strictPatta: false });
    expect(resolveTicketValidationMode({ strictParty: true, strictPatta: false }, { require_ticket_validation: false }))
      .toEqual({ strictParty: true, strictPatta: false });
  });

  it('updates an open ticket from canonical model and worker facts and appends a change event', async () => {
    const calls: Array<{ sql: string; values: any[] }> = [];
    const client = {
      query: async (sql: string, values: any[] = []) => {
        calls.push({ sql, values });
        if (sql.includes('FROM parties WHERE')) return { rows: [{ ish_soni_per_patta: 5 }] };
        if (sql.includes('FROM tickets WHERE company_id')) {
          return { rows: [{ id: TICKET_ID, model_id: 'model-a', qty: 5, status: 'CONFIRMED', is_closed: false, server_revision: 3, party_record_id: 'party-test' }] };
        }
        if (sql.includes('FROM models')) {
          return { rows: [{ operations_json: [{ name: 'Sew', rate: 7 }], status: 'ACTIVE' }] };
        }
        if (sql.includes('FROM ticket_entries')) return { rows: [{ id: 'original-sew', op_name: 'Sew', rate_snapshot: 5, brak: null }] };
        if (sql.includes('FROM workers')) {
          return { rows: [{ id: 71, name: 'Worker 71', status: 'ACTIVE' }] };
        }
        if (sql.includes('INSERT INTO change_log')) return { rows: [{ change_id: '19' }] };
        return { rows: [] };
      }
    };
    const result = await executeUpdateTicket(client, COMPANY, 'edit-operation', {
      ticketId: TICKET_ID,
      baseRevision: 3,
      entries: [{ opName: 'Sew', workerId: 71 }]
    });

    expect(result).toMatchObject({ entityId: TICKET_ID, serverRevision: 4, changeId: 19 });
    const insertedEntry = calls.find(({ sql }) => sql.includes('INSERT INTO ticket_entries'));
    expect(insertedEntry?.values.slice(0, 9)).toEqual(['original-sew', TICKET_ID, COMPANY, 'Sew', 71, 'Worker 71', 5, null, 5]);
    const change = calls.find(({ sql }) => sql.includes('INSERT INTO change_log'));
    expect(JSON.parse(change!.values[6])).toMatchObject({ ticketId: TICKET_ID, entries: [{ opName: 'Sew', workerId: 71, qty: 5 }] });
  });

  it('keeps original rates and identities across reorder, ignores spoofed rates, and leaves new work unknown', async () => {
    const inserts: any[][] = [];
    const client = { query: async (sql: string, values: any[] = []) => {
      if (sql.includes('FROM parties WHERE')) return { rows: [{ ish_soni_per_patta: 4 }] };
      if (sql.includes('FROM tickets WHERE')) return { rows: [{ id: TICKET_ID, model_id: 'model-a', qty: 4, status: 'CONFIRMED', is_closed: false, server_revision: 2, party_record_id: 'party-test' }] };
      if (sql.includes('FROM models')) return { rows: [{ operations_json: [{ name: 'A', rate: 9 }, { name: 'B', rate: 9 }, { name: 'New', rate: 9 }], status: 'ACTIVE' }] };
      if (sql.includes('FROM ticket_entries')) return { rows: [
        { id: 'old-a', op_name: 'A', rate_snapshot: 5, brak: 'old' },
        { id: 'old-b', op_name: 'B', rate_snapshot: 0, brak: null }
      ] };
      if (sql.includes('FROM workers')) return { rows: [{ id: 71, name: 'Worker 71', status: 'ACTIVE' }] };
      if (sql.includes('INSERT INTO ticket_entries')) inserts.push(values);
      if (sql.includes('INSERT INTO change_log')) return { rows: [{ change_id: '20' }] };
      return { rows: [] };
    } };
    await executeUpdateTicket(client, COMPANY, 'edit-operation', { ticketId: TICKET_ID, baseRevision: 2,
      entries: [{ opName: 'B', workerId: 71, rateSnapshot: 999 }, { opName: 'A', workerId: 71, rateSnapshot: 999 }, { opName: 'New', workerId: 71, rateSnapshot: 999 }] });
    expect(inserts.map((values) => [values[0], values[6], values[7]])).toEqual([
      ['old-b', 0, null], ['old-a', 5, 'old'], [`${TICKET_ID}_edit_edit-operation_entry_3`, null, null]
    ]);
  });

  it('does not reuse deleted IDs or attach old snapshots to re-added work across server revisions', async () => {
    let revision = 1;
    let rows = [
      { id: `${TICKET_ID}_entry_1`, op_name: 'Cut', rate_snapshot: 5, brak: 'original' },
      { id: `${TICKET_ID}_entry_2`, op_name: 'Sew', rate_snapshot: 7, brak: null }
    ];
    const changes: any[] = [];
    const client = { query: async (sql: string, values: any[] = []) => {
      if (sql.includes('FROM parties WHERE')) return { rows: [{ ish_soni_per_patta: 4 }] };
      if (sql.includes('FROM tickets WHERE')) return { rows: [{ id: TICKET_ID, model_id: 'model-a', qty: 4, status: 'CONFIRMED', is_closed: false, server_revision: revision, party_record_id: 'party-test' }] };
      if (sql.includes('FROM models')) return { rows: [{ operations_json: ['Cut', 'Sew', 'Pack'], status: 'ACTIVE' }] };
      if (sql.startsWith('DELETE FROM ticket_entries')) { rows = []; return { rows: [] }; }
      if (sql.includes('FROM ticket_entries')) return { rows: rows.map((row) => ({ ...row })) };
      if (sql.includes('FROM workers')) return { rows: [{ id: 71, name: 'Worker 71', status: 'ACTIVE' }] };
      if (sql.startsWith('INSERT INTO ticket_entries')) rows.push({ id: values[0], op_name: values[3], rate_snapshot: values[6], brak: values[7] });
      if (sql.startsWith('UPDATE tickets SET server_revision')) revision = values[2];
      if (sql.includes('INSERT INTO change_log')) { changes.push(JSON.parse(values[6])); return { rows: [{ change_id: String(changes.length) }] }; }
      return { rows: [] };
    } };
    const edit = async (operationId: string, names: string[]) => executeUpdateTicket(client, COMPANY, operationId, {
      ticketId: TICKET_ID, baseRevision: revision,
      entries: names.map((opName) => ({ opName, workerId: 71, rateSnapshot: 999 }))
    });
    await edit('remove_sew', ['Cut']);
    await edit('add_pack', ['Pack', 'Cut']);
    expect(rows.find((row) => row.op_name === 'Pack')).toMatchObject({ id: `${TICKET_ID}_edit_add_pack_entry_1`, rate_snapshot: null });
    await edit('replace_pack', ['Cut']);
    await edit('readd_sew', ['Sew', 'Cut', 'Pack']);
    expect(rows).toEqual([
      { id: `${TICKET_ID}_edit_readd_sew_entry_1`, op_name: 'Sew', rate_snapshot: null, brak: null },
      { id: `${TICKET_ID}_entry_1`, op_name: 'Cut', rate_snapshot: 5, brak: 'original' },
      { id: `${TICKET_ID}_edit_readd_sew_entry_3`, op_name: 'Pack', rate_snapshot: null, brak: null }
    ]);
    expect(changes[0].entries.find((entry: any) => entry.opName === 'Cut').entryId).toBe(`${TICKET_ID}_entry_1`);
    expect(changes[1].entries.find((entry: any) => entry.opName === 'Pack').entryId).not.toBe(`${TICKET_ID}_entry_2`);
  });

  it('does not replace a missing historical rate with a current tariff or a client claim', async () => {
    const inserts: any[][] = [];
    const client = { query: async (sql: string, values: any[] = []) => {
      if (sql.includes('FROM parties WHERE')) return { rows: [{ ish_soni_per_patta: 3 }] };
      if (sql.includes('FROM tickets WHERE')) return { rows: [{ id: TICKET_ID, model_id: 'model-a', qty: 3, status: 'CONFIRMED', is_closed: false, server_revision: 1, party_record_id: 'party-test' }] };
      if (sql.includes('FROM models')) return { rows: [{ operations_json: [{ name: 'A', rate: 9 }], status: 'ACTIVE' }] };
      if (sql.includes('FROM ticket_entries')) return { rows: [{ id: 'old-unknown', op_name: 'A', rate_snapshot: null, brak: null }] };
      if (sql.includes('FROM workers')) return { rows: [{ id: 71, name: 'Worker 71', status: 'ACTIVE' }] };
      if (sql.includes('INSERT INTO ticket_entries')) inserts.push(values);
      if (sql.includes('INSERT INTO change_log')) return { rows: [{ change_id: '21' }] };
      return { rows: [] };
    } };
    await executeUpdateTicket(client, COMPANY, 'edit-operation', { ticketId: TICKET_ID, baseRevision: 1,
      entries: [{ opName: 'A', workerId: 71, rateSnapshot: 5 }] });
    expect(inserts[0][6]).toBeNull();
  });

  it('exposes stable validation errors', () => {
    const error = createValidationError('INVALID_FIELD', 'field is invalid', { field: 'x' });
    expect(error).toMatchObject({ name: 'ValidationError', code: 'INVALID_FIELD', details: { field: 'x' }, statusCode: 400 });
  });

  it('validates workbook model, worker, period, and batch commands against bounded entity contracts', () => {
    const model = {
      commandId: 'command-model', operationId: 'operation-model', companyId: COMPANY,
      modelId: 'Futbolka Erkaklar', name: 'Futbolka Erkaklar',
      operations: [{ id: 'op-cut', name: 'Cut', rate: 12 }], pattaOpsOrder: ['Cut']
    };
    expect(validateCommandPayload('UpsertModel', model, context(workbookEnvelope('UpsertModel', 'model', model.modelId, model))))
      .toMatchObject({ modelId: model.modelId, operations: [{ name: 'Cut', rate: 12 }] });
    expect(validateCommandPayload('UpsertModel', { ...model, party: '' }, context(workbookEnvelope('UpsertModel', 'model', model.modelId, { ...model, party: '' }))))
      .toMatchObject({ modelId: model.modelId, party: '' });
    expect(() => validateOperationEnvelope(workbookEnvelope('UpsertModel', 'model', model.modelId, model))).not.toThrow();
    expectCode(() => validateCommandPayload('UpsertModel', { ...model, status: 'DELETED' }, context(workbookEnvelope('UpsertModel', 'model', model.modelId, { ...model, status: 'DELETED' }))), 'FORBIDDEN_AUTHORITY_FIELD');

    const worker = {
      commandId: 'command-worker', operationId: 'operation-worker', companyId: COMPANY,
      workerId: 71, name: 'Ali', staj: 4, role: 'Bichuvchi', status: 'ACTIVE',
      balanceAdjustments: [{ adjustmentId: 'worker-adjustment-1', type: 'AVANS', amountDelta: 50, periodId: 'period-1' }]
    };
    expect(validateCommandPayload('UpsertWorker', worker, context(workbookEnvelope('UpsertWorker', 'worker', '71', worker))))
      .toMatchObject({ workerId: 71, role: 'Bichuvchi', balanceAdjustments: [{ type: 'AVANS', amountDelta: 50 }] });
    const fourBalances = { ...worker, balanceAdjustments: [
      { adjustmentId: 'av-1', type: 'AVANS', amountDelta: 200000, periodId: 'period-current' },
      { adjustmentId: 'ja-1', type: 'JARIMA', amountDelta: 50000, periodId: 'period-current' },
      { adjustmentId: 'ok-1', type: 'OKLAD', amountDelta: 2000000, periodId: 'period-current' },
      { adjustmentId: 'mg-1', type: 'MAGAZIN', amountDelta: -100000, periodId: 'period-current' }
    ] };
    expect(validateCommandPayload('UpsertWorker', fourBalances,
      context(workbookEnvelope('UpsertWorker', 'worker', '71', fourBalances)))).toMatchObject({
      balanceAdjustments: [{ type: 'AVANS' }, { type: 'JARIMA' }, { type: 'OKLAD' }, { type: 'MAGAZIN', amountDelta: -100000 }]
    });
    const duplicateKind = { ...fourBalances, balanceAdjustments: [fourBalances.balanceAdjustments[0],
      { ...fourBalances.balanceAdjustments[1], adjustmentId: 'av-2', type: 'AVANS' }] };
    expectCode(() => validateCommandPayload('UpsertWorker', duplicateKind,
      context(workbookEnvelope('UpsertWorker', 'worker', '71', duplicateKind))), 'DUPLICATE_WORKER_ADJUSTMENT');
    const duplicateId = { ...fourBalances, balanceAdjustments: [fourBalances.balanceAdjustments[0],
      { ...fourBalances.balanceAdjustments[1], adjustmentId: fourBalances.balanceAdjustments[0].adjustmentId }] };
    expectCode(() => validateCommandPayload('UpsertWorker', duplicateId,
      context(workbookEnvelope('UpsertWorker', 'worker', '71', duplicateId))), 'DUPLICATE_WORKER_ADJUSTMENT');
    const missingManualPeriod = { ...worker, balanceAdjustments: [{ adjustmentId: 'ok-2', type: 'OKLAD', amountDelta: 200, periodId: null }] };
    expectCode(() => validateCommandPayload('UpsertWorker', missingManualPeriod,
      context(workbookEnvelope('UpsertWorker', 'worker', '71', missingManualPeriod))), 'INVALID_FIELD_TYPE');
    const unsafeManualMoney = { ...worker, balanceAdjustments: [{ adjustmentId: 'ok-3', type: 'OKLAD', amountDelta: 1.5, periodId: 'period-current' }] };
    expectCode(() => validateCommandPayload('UpsertWorker', unsafeManualMoney,
      context(workbookEnvelope('UpsertWorker', 'worker', '71', unsafeManualMoney))), 'INVALID_NUMBER');

    const activation = {
      commandId: 'command-activate-worker', operationId: 'operation-activate-worker', companyId: COMPANY,
      workerId: 71, baseRevision: 3
    };
    expect(validateCommandPayload('ActivateWorker', activation,
      context(workbookEnvelope('ActivateWorker', 'worker', '71', activation, 3))))
      .toMatchObject({ workerId: 71, baseRevision: 3 });

    const period = {
      commandId: 'command-period', operationId: 'operation-period', companyId: COMPANY,
      periodId: 'period-current', endDate: '2026-09-30',
      nextPeriod: { id: 'period-next', name: 'October', startDate: '2026-10-01' }
    };
    expect(validateCommandPayload('ClosePeriod', period, context(workbookEnvelope('ClosePeriod', 'period', 'period-current', period, 2))))
      .toMatchObject({ periodId: 'period-current', nextPeriod: { id: 'period-next' } });
    const clientDerivedPeriod = { ...period, completedPartyIds: ['party-complete'] };
    expectCode(() => validateCommandPayload('ClosePeriod', clientDerivedPeriod,
      context(workbookEnvelope('ClosePeriod', 'period', 'period-current', clientDerivedPeriod, 2))), 'FORBIDDEN_AUTHORITY_FIELD');

    const settings = {
      commandId: 'command-batch-settings', operationId: 'operation-batch-settings', companyId: COMPANY,
      availableSizes: ['M', 'L'], configs: [{ modelId: 'model-a', partyNumber: '12', isCustomParty: true, sizes: { M: '2' } }]
    };
    expect(validateCommandPayload('UpdateBatchSettings', settings, context(workbookEnvelope('UpdateBatchSettings', 'batch_settings', COMPANY, settings))))
      .toMatchObject({ availableSizes: ['M', 'L'], configs: [{ modelId: 'model-a', sizes: { M: '2' } }] });
  });

  it('rejects invalid batch party collisions and revision alias mismatches before mutation', () => {
    const batch = {
      commandId: 'command-batch', operationId: 'operation-batch', companyId: COMPANY,
      batchId: 'batch-1',
      batchSettingsBaseRevision: 0,
      parties: [
        { commandId: 'command-batch', operationId: 'operation-batch', companyId: COMPANY, partyRecordId: 'party-a', partyNumber: '12', modelId: 'model-a', pattaCount: 1, sizes: { M: 1 } },
        { commandId: 'command-batch', operationId: 'operation-batch', companyId: COMPANY, partyRecordId: 'party-b', partyNumber: '12', modelId: 'model-b', pattaCount: 1, sizes: { M: 1 } }
      ]
    };
    expectCode(() => validateCommandPayload('CompletePattaBatch', batch, context(workbookEnvelope('CompletePattaBatch', 'patta_batch', 'batch-1', batch))), 'ACTIVE_PARTY_EXISTS');

    const update = {
      commandId: 'command-model-update', operationId: 'operation-model-update', companyId: COMPANY,
      modelId: 'model-a', name: 'Model A', operations: [], pattaOpsOrder: [], baseRevision: 4
    };
    expectCode(() => validateCommandPayload('UpsertModel', update, context(workbookEnvelope('UpsertModel', 'model', 'model-a', update, 3))), 'FIELD_CONFLICT');
  });

  it('accepts all supported command contracts and preserves opaque historical IDs', () => {
    const submit = ticketPayload();
    expect(validateCommandPayload('SubmitTicket', submit, context(envelope('SubmitTicket', submit)))).toMatchObject({
      ticketId: TICKET_ID,
      partyRecordId: 'rec_1788774889449_vrbkv'
    });

    const split = ticketPayload({
      qty: 100,
      entries: [
        { opName: 'Bichish', workerId: 7, qty: 40 },
        { opName: 'Bichish', workerId: 8, qty: 60 }
      ]
    });
    expect(validateCommandPayload('SubmitTicket', split, context(envelope('SubmitTicket', split))).entries.map((entry: any) => entry.qty))
      .toEqual([40, 60]);

    const adjustment = {
      commandId: 'command-adjust', operationId: 'operation-adjust', companyId: COMPANY,
      adjustmentId: 'adjustment-1', modelId: 'model-1', workerId: '7',
      opName: 'Bichish', deltaQty: -2.5, reason: 'Recount', createdBy: 'operator-1'
    };
    expect(validateCommandPayload('RecordProductionAdjustment', adjustment, context(envelope('RecordProductionAdjustment', adjustment)))).toMatchObject({
      adjustmentId: 'adjustment-1', workerId: '7', deltaQty: -2.5, status: 'APPROVED'
    });

    const reversal = {
      commandId: 'command-reverse', operationId: 'operation-reverse', companyId: COMPANY,
      adjustmentId: 'reversal-1', originalAdjustmentId: 'adjustment-1', effectiveDate: '2026-09-22'
    };
    expect(validateCommandPayload('ReverseProductionAdjustment', reversal, context(envelope('ReverseProductionAdjustment', reversal)))).toMatchObject({
      adjustmentId: 'reversal-1', reversalId: 'reversal-1'
    });

    const createParty = {
      commandId: 'command-party', operationId: 'operation-party', companyId: COMPANY,
      partyRecordId: 'rec_1788930871307_cg1iv', partyNumber: '2', modelId: 'model-1', sizes: { M: 4 }
    };
    expect(validateCommandPayload('CreateParty', createParty, context(envelope('CreateParty', createParty)))).toMatchObject({
      partyRecordId: 'rec_1788930871307_cg1iv'
    });

    const closeParty = { commandId: 'command-close', operationId: 'operation-close', companyId: COMPANY, partyRecordId: 'party-1' };
    expect(validateCommandPayload('CloseParty', closeParty, context(envelope('CloseParty', closeParty)))).toMatchObject({ partyRecordId: 'party-1' });

    const reconciliation = {
      commandId: 'command-reconcile', operationId: 'operation-reconcile', companyId: COMPANY,
      candidateId: 'candidate-1', decision: 'DEFER_REVIEW', reason: 'Needs review', operatorId: 'operator-1', operatorRole: 'admin'
    };
    expect(validateCommandPayload('ResolveMigrationReconciliationCandidate', reconciliation, context(envelope('ResolveMigrationReconciliationCandidate', reconciliation)))).toMatchObject({
      candidateId: 'candidate-1', operatorId: 'operator-1', operatorRole: 'admin'
    });
  });

  it('rejects every Party authority field instead of ignoring client claims', () => {
    const authorityFields = ['grandfathered', 'legacyException', 'exceptionGroupId', 'approvedBy', 'status'];
    const partyPayload = {
      commandId: 'command-party-authority', operationId: 'operation-party-authority', companyId: COMPANY,
      partyRecordId: 'party-authority', partyNumber: '2', modelId: 'model-1'
    };

    for (const field of authorityFields) {
      expectCode(() => validateCommandPayload('CreateParty', { ...partyPayload, [field]: 'client-claim' }, context(envelope('CreateParty', partyPayload))), 'FORBIDDEN_AUTHORITY_FIELD');
      expectCode(() => validateCommandPayload('CloseParty', {
        commandId: 'command-close-authority', operationId: 'operation-close-authority', companyId: COMPANY,
        partyRecordId: 'party-authority', [field]: 'client-claim'
      }, context()), 'FORBIDDEN_AUTHORITY_FIELD');
    }
  });

  it('rejects malformed envelopes, unsupported versions, hashes, commands, and entity mismatches', () => {
    expectCode(() => validateOperationEnvelope({}), 'INVALID_OPERATION_ID');
    expectCode(() => validateOperationEnvelope({ ...envelope('SubmitTicket', ticketPayload()), operationId: 1 }), 'INVALID_OPERATION_ID');
    expectCode(() => validateOperationEnvelope({ ...envelope('SubmitTicket', ticketPayload()), payloadHash: 'A'.repeat(64) }), 'INVALID_PAYLOAD_HASH');
    expectCode(() => validateOperationEnvelope({ ...envelope('SubmitTicket', ticketPayload()), commandType: 'NotSupported' }), 'UNKNOWN_COMMAND');
    expectCode(() => validateOperationEnvelope({ ...envelope('SubmitTicket', ticketPayload()), commandType: ' SubmitTicket ' }), 'INVALID_FIELD');
    expectCode(() => validateOperationEnvelope({ ...envelope('SubmitTicket', ticketPayload()), entityType: ' ticket ' }), 'INVALID_FIELD');
    expectCode(() => validateOperationEnvelope({ ...envelope('SubmitTicket', ticketPayload()), version: 2 }), 'UNSUPPORTED_VERSION');
    expectCode(() => validateOperationEnvelope({ ...envelope('SubmitTicket', ticketPayload()), entityType: 'party' }), 'ENTITY_TYPE_MISMATCH');
    expectCode(() => validateCommandPayload('SubmitTicket', ticketPayload({ ticketId: 'ticket-not-a-uuid' }), context(envelope('SubmitTicket', ticketPayload({ ticketId: 'ticket-not-a-uuid' })))), 'INVALID_TICKET_UUID');
  });

  it('rejects whitespace around strict command status, reconciliation decision, and operator role claims', () => {
    const adjustment = {
      commandId: 'command-strict-status', operationId: 'operation-strict-status', companyId: COMPANY,
      adjustmentId: 'adjustment-strict-status', modelId: 'model-1', workerId: 7, opName: 'Bichish', deltaQty: 1,
      status: ' APPROVED '
    };
    expectCode(() => validateCommandPayload('RecordProductionAdjustment', adjustment, context()), 'INVALID_ADJUSTMENT_STATUS');

    const reconciliation = {
      commandId: 'command-strict-reconciliation', operationId: 'operation-strict-reconciliation', companyId: COMPANY,
      candidateId: 'candidate-strict', decision: ' DEFER_REVIEW ', reason: 'review', operatorId: 'operator-1', operatorRole: 'admin'
    };
    expectCode(() => validateCommandPayload(
      'ResolveMigrationReconciliationCandidate',
      reconciliation,
      context(envelope('ResolveMigrationReconciliationCandidate', reconciliation))
    ), 'INVALID_DECISION');
    expectCode(() => validateCommandPayload(
      'ResolveMigrationReconciliationCandidate',
      { ...reconciliation, decision: 'DEFER_REVIEW', operatorRole: ' admin ' },
      context(envelope('ResolveMigrationReconciliationCandidate', reconciliation))
    ), 'OPERATOR_INTENT_MISMATCH');
    expectCode(() => validateCommandPayload(
      'ResolveMigrationReconciliationCandidate',
      { ...reconciliation, decision: 'DEFER_REVIEW', operatorId: ' operator-1 ' },
      context(envelope('ResolveMigrationReconciliationCandidate', reconciliation))
    ), 'OPERATOR_INTENT_MISMATCH');
  });

  it('rejects conflicting envelope aliases and mismatched dual payload representations', () => {
    const payload = ticketPayload();
    const operation = envelope('SubmitTicket', payload);

    expectCode(() => validateOperationEnvelope({ ...operation, command_type: 'CloseParty' }), 'FIELD_CONFLICT');
    expectCode(() => validateOperationEnvelope({ ...operation, entity_id: 'other-entity' }), 'FIELD_CONFLICT');
    expectCode(() => validateOperationEnvelope({ ...operation, payload_hash: '0'.repeat(64) }), 'FIELD_CONFLICT');
    expectCode(() => validateOperationEnvelope({ ...operation, protocolVersion: 1, protocol_version: 2 }), 'FIELD_CONFLICT');

    const bothPayloads = validateOperationEnvelope({
      ...operation,
      payload_json: JSON.stringify({ ...payload })
    });
    expect(bothPayloads.payload).toEqual(payload);

    expectCode(() => validateOperationEnvelope({
      ...operation,
      payload_json: JSON.stringify({ ...payload, qty: 11 })
    }), 'PAYLOAD_CONFLICT');
    expectCode(() => validateOperationEnvelope({ ...operation, payload_json: '{' }), 'MALFORMED_PAYLOAD_JSON');
  });

  it('carries envelope baseRevision into reversal CAS and rejects conflicting payload revisions', async () => {
    const payload = {
      commandId: 'command-reverse-envelope-revision',
      operationId: 'operation-reverse-envelope-revision',
      companyId: COMPANY,
      reversalId: 'reversal-envelope-revision',
      originalAdjustmentId: 'adjustment-envelope-revision',
      effectiveDate: '2026-09-22'
    };
    const operation = envelope('ReverseProductionAdjustment', payload, { baseRevision: 99 });

    expect(validateOperationEnvelope(operation).baseRevision).toBe(99);
    expect(validateCommandPayload('ReverseProductionAdjustment', payload, context(operation))).toMatchObject({
      baseRevision: 99
    });
    expect(validateCommandPayload(
      'ReverseProductionAdjustment',
      { ...payload, baseRevision: 99 },
      context(operation)
    )).toMatchObject({ baseRevision: 99 });
    expectCode(() => validateCommandPayload(
      'ReverseProductionAdjustment',
      { ...payload, baseRevision: 98 },
      context(operation)
    ), 'FIELD_CONFLICT');

    const pool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (/FROM production_adjustments/i.test(sql)) {
            return { rows: [{
              adjustment_id: payload.originalAdjustmentId,
              model_id: 'model-1',
              worker_id: 7,
              op_name: 'Bichish',
              delta_qty: 1,
              status: 'APPROVED',
              server_revision: 1
            }] };
          }
          return { rows: [] };
        },
        release: () => undefined
      })
    } as any;
    const result = await processSingleOperation(
      pool,
      { auth: { companyId: COMPANY, deviceId: 'device-1' } },
      operation
    );
    expect(result.status).toBe('CONFLICT');
    expect(result.error.code).toBe('REVISION_CONFLICT');
  });

  it('accepts snake_case envelope aliases when they are the only representation', () => {
    const payload = ticketPayload();
    const operation = envelope('SubmitTicket', payload);
    const snakeCaseOperation = {
      operation_id: operation.operationId,
      company_id: operation.companyId,
      command_type: operation.commandType,
      entity_type: operation.entityType,
      entity_id: operation.entityId,
      payload_hash: operation.payloadHash,
      payload: operation.payload
    };

    expect(validateOperationEnvelope(snakeCaseOperation)).toMatchObject({
      operationId: operation.operationId,
      companyId: operation.companyId,
      commandType: 'SubmitTicket',
      entityId: operation.entityId,
      payloadHash: operation.payloadHash
    });
  });

  it('rejects impossible timestamp calendar dates for every authoritative timestamp field', () => {
    const invalidTimestamp = '2026-02-30T00:00:00.000Z';
    const adjustment = {
      commandId: 'command-adjust-date', operationId: 'operation-adjust-date', companyId: COMPANY,
      adjustmentId: 'adjustment-date', modelId: 'model-1', workerId: 7, opName: 'Bichish', deltaQty: 1,
      createdAt: invalidTimestamp
    };
    const reversal = {
      commandId: 'command-reverse-date', operationId: 'operation-reverse-date', companyId: COMPANY,
      adjustmentId: 'reversal-date', originalAdjustmentId: 'adjustment-date', createdAt: invalidTimestamp
    };
    const party = {
      commandId: 'command-party-date', operationId: 'operation-party-date', companyId: COMPANY,
      partyRecordId: 'party-date', partyNumber: '2', modelId: 'model-1', printedAt: invalidTimestamp
    };

    expectCode(() => validateCommandPayload('SubmitTicket', ticketPayload({ submittedAt: invalidTimestamp }), context()), 'INVALID_DATE');
    expectCode(() => validateCommandPayload('RecordProductionAdjustment', adjustment, context()), 'INVALID_DATE');
    expectCode(() => validateCommandPayload('ReverseProductionAdjustment', reversal, context()), 'INVALID_DATE');
    expectCode(() => validateCommandPayload('CreateParty', party, context()), 'INVALID_DATE');
  });

  it('derives Party command identity from the envelope and checks duplicate payload fields', () => {
    const payload = {
      partyRecordId: 'rec_1788774889449_vrbkv', partyNumber: '2', modelId: 'model-1'
    };
    const operation = {
      ...envelope('CreateParty', payload),
      operationId: 'operation-party-envelope',
      commandId: 'command-party-envelope'
    };
    expect(validateCommandPayload('CreateParty', payload, context(operation))).toMatchObject({
      commandId: 'command-party-envelope',
      operationId: operation.operationId,
      companyId: COMPANY,
      partyRecordId: payload.partyRecordId
    });

    expectCode(() => validateCommandPayload('CreateParty', {
      ...payload,
      operationId: 'other-operation'
    }, context(operation)), 'OPERATION_ID_MISMATCH');
    expectCode(() => validateCommandPayload('CreateParty', {
      ...payload,
      companyId: 42
    }, context(operation)), 'INVALID_FIELD_TYPE');
    expectCode(() => validateCommandPayload('CreateParty', {
      ...payload,
      commandId: 'other-command'
    }, context(operation)), 'COMMAND_ID_MISMATCH');
  });

  it('validates causal ordering consistently without requiring optional causal fields', () => {
    const adjustment = {
      commandId: 'command-causal', operationId: 'operation-causal', companyId: COMPANY,
      adjustmentId: 'adjustment-causal', modelId: 'model-1', workerId: 7, opName: 'Bichish', deltaQty: 1
    };
    expect(validateCommandPayload('RecordProductionAdjustment', adjustment, context())).toMatchObject({
      causalSequence: 0
    });
    expect(validateCommandPayload('RecordProductionAdjustment', {
      ...adjustment,
      dependsOnOperationId: 'parent-operation'
    }, context())).toMatchObject({
      dependsOnOperationId: 'parent-operation', causalSequence: 1
    });
    expectCode(() => validateCommandPayload('RecordProductionAdjustment', {
      ...adjustment,
      dependsOnOperationId: adjustment.operationId
    }, context()), 'SELF_CAUSAL_DEPENDENCY');
    expectCode(() => validateCommandPayload('RecordProductionAdjustment', {
      ...adjustment,
      causalSequence: 1
    }, context()), 'INVALID_CAUSAL_SEQUENCE');
    expectCode(() => validateCommandPayload('RecordProductionAdjustment', {
      ...adjustment,
      dependsOnOperationId: 'parent-operation', causalSequence: 0
    }, context()), 'INVALID_CAUSAL_SEQUENCE');

    const partyPayload = { partyRecordId: 'party-causal', partyNumber: '3', modelId: 'model-1' };
    const partyOperation = {
      ...envelope('CreateParty', partyPayload),
      operationId: 'operation-party-causal',
      commandId: 'command-party-causal'
    };
    expectCode(() => validateCommandPayload('CreateParty', {
      ...partyPayload,
      dependsOnOperationId: partyOperation.operationId
    }, context(partyOperation)), 'SELF_CAUSAL_DEPENDENCY');
  });

  it('rejects raw type coercion attempts and invalid dates or quantities', () => {
    expectCode(() => validateCommandPayload('SubmitTicket', ticketPayload({ qty: '10' }), context()), 'INVALID_NUMBER');
    expectCode(() => validateCommandPayload('SubmitTicket', ticketPayload({ qty: -1 }), context()), 'INVALID_QUANTITY');
    expectCode(() => validateCommandPayload('SubmitTicket', ticketPayload({ qty: Number.NaN }), context()), 'INVALID_NUMBER');
    expectCode(() => validateCommandPayload('SubmitTicket', ticketPayload({ qty: Number.POSITIVE_INFINITY }), context()), 'INVALID_NUMBER');
    expectCode(() => validateCommandPayload('SubmitTicket', ticketPayload({ effectiveDate: '2026-02-30' }), context()), 'INVALID_DATE');
    expectCode(() => validateCommandPayload('SubmitTicket', ticketPayload({ entries: [{ opName: 'Bichish', workerId: {} }] }), context()), 'INVALID_WORKER_ID');
    expectCode(() => validateCommandPayload('CreateParty', {
      commandId: 'party-command', operationId: 'party-operation', companyId: COMPANY,
      partyRecordId: 'party-1', partyNumber: '2', modelId: 'model-1', sizes: { M: '4' }
    }, context()), 'INVALID_NUMBER');
    expectCode(() => validateCommandPayload('RecordProductionAdjustment', {
      commandId: 'adjust-command', operationId: 'adjust-operation', companyId: COMPANY,
      adjustmentId: 'adjust-1', modelId: 'model-1', workerId: 1, opName: 'Bichish', deltaQty: 0
    }, context()), 'INVALID_QUANTITY');
    expectCode(() => validateCommandPayload('RecordProductionAdjustment', {
      commandId: 'adjust-command', operationId: 'adjust-operation', companyId: COMPANY,
      adjustmentId: 'adjust-1', modelId: 'model-1', workerId: 1, opName: 'Bichish', deltaQty: 1, status: null
    }, context()), 'INVALID_FIELD_TYPE');
  });

  it('rejects forged authority fields at top-level and nested command locations', () => {
    expectCode(() => validateCommandPayload('CreateParty', {
      commandId: 'party-command', operationId: 'party-operation', companyId: COMPANY,
      partyRecordId: 'party-1', partyNumber: '2', modelId: 'model-1', grandfathered: true
    }, context()), 'FORBIDDEN_AUTHORITY_FIELD');
    expectCode(() => validateCommandPayload('CreateParty', {
      commandId: 'party-command', operationId: 'party-operation', companyId: COMPANY,
      partyRecordId: 'party-1', partyNumber: '2', modelId: 'model-1', status: 'ACTIVE'
    }, context()), 'FORBIDDEN_AUTHORITY_FIELD');
    expectCode(() => validateCommandPayload('SubmitTicket', ticketPayload({ entries: [{ opName: 'Bichish', workerId: 1, role: 'admin' }] }), context()), 'FORBIDDEN_AUTHORITY_FIELD');
    expectCode(() => validateCommandPayload('RecordProductionAdjustment', {
      commandId: 'adjust-command', operationId: 'adjust-operation', companyId: COMPANY,
      adjustmentId: 'adjust-1', modelId: 'model-1', workerId: 1, opName: 'Bichish', deltaQty: 1, serverRevision: 2
    }, context()), 'FORBIDDEN_AUTHORITY_FIELD');
    expectCode(() => validateCommandPayload('ResolveMigrationReconciliationCandidate', {
      commandId: 'reconcile-command', operationId: 'reconcile-operation', companyId: COMPANY,
      candidateId: 'candidate-1', decision: 'DEFER_REVIEW', reason: 'review', operatorId: 'attacker'
    }, context()), 'OPERATOR_INTENT_MISMATCH');
  });

  it('rejects reverse status before any authoritative DML', async () => {
    const queries: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        },
        release: () => undefined
      })
    } as any;
    const payload = {
      commandId: 'command-reverse-status', operationId: 'operation-reverse-status', companyId: COMPANY,
      reversalId: 'reversal-status', originalAdjustmentId: 'adjustment-status', status: 'REVERSED'
    };
    const result = await processSingleOperation(
      pool,
      { auth: { companyId: COMPANY, deviceId: 'device-1' } },
      envelope('ReverseProductionAdjustment', payload)
    );

    expect(result.status).toBe('REJECTED');
    expect(result.error.code).toBe('FORBIDDEN_AUTHORITY_FIELD');
    expect(queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
  });

  it('rejects a PENDING_REVIEW original before DML, change-log, or dedup mutation', async () => {
    const queries: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          if (/FROM production_adjustments/i.test(sql)) {
            return { rows: [{
              adjustment_id: 'adjustment-pending-review',
              model_id: 'model-1',
              worker_id: 7,
              op_name: 'Bichish',
              delta_qty: 1,
              status: 'PENDING_REVIEW',
              server_revision: 1
            }] };
          }
          return { rows: [] };
        },
        release: () => undefined
      })
    } as any;
    const payload = {
      commandId: 'command-reverse-pending-review',
      operationId: 'operation-reverse-pending-review',
      companyId: COMPANY,
      reversalId: 'reversal-pending-review',
      originalAdjustmentId: 'adjustment-pending-review',
      effectiveDate: '2026-09-22'
    };

    const result = await processSingleOperation(
      pool,
      { auth: { companyId: COMPANY, deviceId: 'device-1' } },
      envelope('ReverseProductionAdjustment', payload, { baseRevision: 1 })
    );

    expect(result.status).toBe('REJECTED');
    expect(result.error.code).toBe('CANNOT_REVERSE_UNAPPROVED');
    expect(result.error.message).toBe(
      'Cannot reverse adjustment "adjustment-pending-review" with status "PENDING_REVIEW". Only APPROVED adjustments can be reversed.'
    );
    expect(queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
    expect(queries.some((query) => /operations_dedup|change_log/i.test(query) && /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
  });

  it('rejects company, operation, entity, and reconciliation authority mismatches', () => {
    const payload = ticketPayload();
    expectCode(() => validateCommandPayload('SubmitTicket', { ...payload, companyId: 'company-other' }, context()), 'COMPANY_SCOPE_MISMATCH');
    expectCode(() => validateCommandPayload('SubmitTicket', payload, context({ ...envelope('SubmitTicket', payload), operationId: 'other-operation' })), 'OPERATION_ID_MISMATCH');
    expectCode(() => validateCommandPayload('SubmitTicket', payload, context({ ...envelope('SubmitTicket', payload), entityId: 'other-ticket' })), 'ENTITY_ID_MISMATCH');
    expectCode(() => validateCommandPayload('ResolveMigrationReconciliationCandidate', {
      commandId: 'reconcile-command', operationId: 'reconcile-operation', companyId: COMPANY,
      candidateId: 'candidate-1', decision: 'DEFER_REVIEW', reason: 'review'
    }, { companyId: COMPANY, operation: undefined, auth: { companyId: COMPANY, deviceId: 'device-1' } }), 'RECONCILIATION_RBAC_BLOCKED');
  });

  it('rejects oversized payloads and arrays before command execution', () => {
    const oversized = ticketPayload({ blob: Array.from({ length: 1000 }, () => 'x'.repeat(100)) });
    expectCode(() => validateCommandPayload('SubmitTicket', oversized, context()), 'PAYLOAD_TOO_LARGE');
    expectCode(() => validateCommandPayload('SubmitTicket', ticketPayload({ entries: Array.from({ length: 1001 }, () => ({ opName: 'Bichish', workerId: 1 })) }), context()), 'ARRAY_TOO_LARGE');
    expect(MAX_OPERATIONS).toBe(100);
  });

  it('rejects a command before any authoritative INSERT, UPDATE, or DELETE', async () => {
    const queries: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        },
        release: () => undefined
      })
    } as any;
    const payload = ticketPayload({ status: 'CLIENT_FORGED' });
    const result = await processSingleOperation(pool, { auth: { companyId: COMPANY, deviceId: 'device-1' } }, envelope('SubmitTicket', payload));
    expect(result.status).toBe('REJECTED');
    expect(result.error.code).toBe('FORBIDDEN_AUTHORITY_FIELD');
    expect(queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
  });

  it('rejects an impossible timestamp before any authoritative mutation', async () => {
    const queries: string[] = [];
    let connected = false;
    const pool = {
      connect: async () => {
        connected = true;
        return {
          query: async (sql: string) => {
            queries.push(sql);
            return { rows: [] };
          },
          release: () => undefined
        };
      }
    } as any;
    const payload = ticketPayload({ submittedAt: '2026-02-30T00:00:00.000Z' });
    const result = await processSingleOperation(pool, { auth: { companyId: COMPANY, deviceId: 'device-1' } }, envelope('SubmitTicket', payload));

    expect(result.status).toBe('REJECTED');
    expect(result.error.code).toBe('INVALID_DATE');
    expect(connected).toBe(true);
    expect(queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
    expect(queries.some((query) => /operations_dedup|change_log/i.test(query) && /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
  });

  it('rejects party identity and causal conflicts before any authoritative mutation', async () => {
    const queries: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        },
        release: () => undefined
      })
    } as any;
    const partyPayload = {
      partyRecordId: 'party-rejection', partyNumber: '3', modelId: 'model-1', operationId: 'payload-operation'
    };
    const partyOperation = {
      ...envelope('CreateParty', partyPayload),
      operationId: 'envelope-operation',
      commandId: 'command-party-rejection'
    };
    const causalPayload = {
      commandId: 'command-causal-rejection', operationId: 'causal-operation', companyId: COMPANY,
      adjustmentId: 'adjustment-causal-rejection', modelId: 'model-1', workerId: 7, opName: 'Bichish', deltaQty: 1,
      causalSequence: 1
    };

    const partyResult = await processSingleOperation(
      pool,
      { auth: { companyId: COMPANY, deviceId: 'device-1' } },
      partyOperation
    );
    const causalResult = await processSingleOperation(
      pool,
      { auth: { companyId: COMPANY, deviceId: 'device-1' } },
      envelope('RecordProductionAdjustment', causalPayload)
    );

    expect(partyResult.error.code).toBe('OPERATION_ID_MISMATCH');
    expect(causalResult.error.code).toBe('INVALID_CAUSAL_SEQUENCE');
    expect(queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
    expect(queries.some((query) => /operations_dedup|change_log/i.test(query) && /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
  });

  it('persists PENDING_REVIEW and defaults omitted adjustment status to APPROVED', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (/FROM models/i.test(sql) || /FROM workers/i.test(sql)) return { rows: [{ id: 'model-1' }] };
          if (/operations_dedup/i.test(sql)) return { rows: [] };
          if (/INSERT INTO production_adjustments/i.test(sql)) return { rows: [{ created_at: '2026-09-22T00:00:00.000Z' }] };
          if (/INSERT INTO change_log/i.test(sql)) return { rows: [{ change_id: 1, committed_at: '2026-09-22T00:00:00.000Z' }] };
          return { rows: [] };
        },
        release: () => undefined
      })
    } as any;
    const pendingPayload = {
      commandId: 'command-pending', operationId: 'operation-pending', companyId: COMPANY,
      adjustmentId: 'adjustment-pending', modelId: 'model-1', workerId: 7, opName: 'Bichish', deltaQty: 1,
      status: 'PENDING_REVIEW', effectiveDate: '2026-09-22', createdBy: 'client-forged-actor'
    };
    const pendingResult = await processSingleOperation(
      pool,
      {
        auth: {
          companyId: COMPANY,
          deviceId: 'device-1',
          operator: { operatorId: 'trusted-operator' }
        }
      },
      envelope('RecordProductionAdjustment', pendingPayload)
    );
    expect(pendingResult.status).toBe('APPLIED');
    const adjustmentInsert = queries.find((entry) => /INSERT INTO production_adjustments/i.test(entry.sql));
    expect(adjustmentInsert?.params?.[7]).toBe('PENDING_REVIEW');
    expect(adjustmentInsert?.params?.[9]).toBe('trusted-operator');
    const pendingChange = queries.find((entry) => /INSERT INTO change_log/i.test(entry.sql));
    expect(JSON.parse(String(pendingChange?.params?.[4]))).toMatchObject({
      status: 'PENDING_REVIEW', createdAt: '2026-09-22T00:00:00.000Z', createdBy: 'trusted-operator'
    });

    const omittedPayload = { ...pendingPayload, operationId: 'operation-default', adjustmentId: 'adjustment-default' };
    delete omittedPayload.status;
    queries.length = 0;
    const omittedValidated = validateCommandPayload('RecordProductionAdjustment', omittedPayload, context());
    expect(omittedValidated.status).toBe('APPROVED');
  });

  it('uses trusted context for reversal adjustment audit attribution', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (/FROM production_adjustments/i.test(sql)) {
            return { rows: [{
              adjustment_id: 'adjustment-reversal-audit',
              model_id: 'model-1',
              worker_id: 7,
              op_name: 'Bichish',
               delta_qty: 2,
               status: 'APPROVED',
               server_revision: 1,
               original_ticket_id: 'ticket-frozen', original_entry_id: 'entry-frozen',
               original_period_id: 'period-september', original_rate_snapshot: 5,
               attribution_status: 'RESOLVED'
            }] };
          }
          if (/INSERT INTO change_log/i.test(sql)) {
            return { rows: [{ change_id: 1, committed_at: '2026-09-22T00:00:00.000Z' }] };
          }
          if (/INSERT INTO production_adjustments/i.test(sql)) return { rows: [{ created_at: '2026-09-22T00:00:00.000Z' }] };
          return { rows: [] };
        },
        release: () => undefined
      })
    } as any;
    const payload = {
      commandId: 'command-reversal-audit',
      operationId: 'operation-reversal-audit',
      companyId: COMPANY,
      reversalId: 'reversal-audit',
      originalAdjustmentId: 'adjustment-reversal-audit',
      effectiveDate: '2026-09-22',
      createdBy: 'client-forged-actor'
    };
    const result = await processSingleOperation(
      pool,
      {
        auth: {
          companyId: COMPANY,
          deviceId: 'device-1',
          operator: { operatorId: 'trusted-operator' }
        }
      },
      envelope('ReverseProductionAdjustment', payload, { baseRevision: 1 })
    );

    expect(result.status).toBe('APPLIED');
    const reversalInsert = queries.find((entry) => /INSERT INTO production_adjustments/i.test(entry.sql));
    expect(reversalInsert?.params?.[7]).toBe('trusted-operator');
    expect(reversalInsert?.params?.slice(-5)).toEqual(['ticket-frozen', 'entry-frozen', 'period-september', 5, 'RESOLVED']);
    const changes = queries.filter((entry) => /INSERT INTO change_log/i.test(entry.sql));
    expect(JSON.parse(String(changes[0].params?.[4]))).toMatchObject({ status: 'REVERSED' });
    expect(JSON.parse(String(changes[1].params?.[3]))).toMatchObject({
      adjustmentId: 'reversal-audit', originalAdjustmentId: 'adjustment-reversal-audit',
      modelId: 'model-1', workerId: 7, opName: 'Bichish', deltaQty: -2, status: 'REVERSED',
      originalTicketId: 'ticket-frozen', originalPeriodId: 'period-september', originalRateSnapshot: 5,
      attributionStatus: 'RESOLVED',
      createdAt: '2026-09-22T00:00:00.000Z', createdBy: 'trusted-operator'
    });
  });

  it('validates optional immutable party size order while preserving old payload omission', () => {
    const payload = { commandId: 'cmd_order', operationId: 'op_order', companyId: COMPANY,
      partyRecordId: 'party_order', partyNumber: '4', modelId: 'model-1', pattaCount: 2, cumulativePattaCount: 2,
      ishSoniPerPatta: 25, totalIshSoni: 50, ishSoni: 50, cumulativeIshSoni: 50,
      sizes: { XXL: 1, M: 1 }, sizeOrder: [' XXL ', 'M'] };
    expect(validateCommandPayload('CreateParty', payload, context(envelope('CreateParty', payload))).sizeOrder)
      .toEqual(['XXL', 'M']);
    const legacy = { ...payload } as any;
    delete legacy.sizeOrder;
    expect(validateCommandPayload('UpdateParty', legacy, context(envelope('UpdateParty', legacy))).sizeOrder).toBeUndefined();
    expectCode(() => validateCommandPayload('CreateParty', { ...payload, sizeOrder: ['M', ' m '] }, context(envelope('CreateParty', payload))), 'DUPLICATE_PARTY_SIZE_ORDER');
  });

  it('derives linked original period and saved rate under tenant/entry identity, rejecting forged inputs', async () => {
    const ticketId = '00000000-0000-4000-8000-000000000098';
    const base = { commandId: 'cmd-linked', operationId: 'op-linked', companyId: COMPANY,
      adjustmentId: 'adj-linked', modelId: 'model-1', workerId: 7, opName: 'Bichish',
      deltaQty: 2, reason: 'Correction', effectiveDate: '2026-10-05',
      originalTicketId: ticketId, originalEntryId: 'entry-linked' };
    for (const fields of [{ originalEntryId: undefined }, { originalPeriodId: 'forged' },
      { originalRateSnapshot: 9 }, { attributionStatus: 'RESOLVED' }]) {
      expect(() => validateCommandPayload('RecordProductionAdjustment', { ...base, ...fields }, context())).toThrow();
    }
    let sourceRows: any[] = [{ period_id: 'period-september', rate_snapshot: 5 }];
    const queries: Array<{ sql: string; params?: any[] }> = [];
    const pool = { connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        queries.push({ sql, params });
        if (/FROM ticket_entries e/i.test(sql)) return { rows: sourceRows };
        if (/SELECT id FROM periods WHERE/i.test(sql)) return { rows: /is_closed = 1/i.test(sql) ? [] : [{ id: 'period-september' }] };
        if (/FROM models WHERE|FROM workers WHERE/i.test(sql)) return { rows: [{ id: 7 }] };
        if (/INSERT INTO production_adjustments/i.test(sql)) return { rows: [{ created_at: '2026-10-05T00:00:00.000Z' }] };
        if (/INSERT INTO change_log/i.test(sql)) return { rows: [{ change_id: 1, committed_at: '2026-10-05T00:00:00.000Z' }] };
        return { rows: [] };
      }, release: () => undefined
    }) } as any;
    const req = { auth: { companyId: COMPANY, deviceId: 'device-1', operator: { operatorId: 'trusted' } } };
    const firstResult = await processSingleOperation(pool, req, envelope('RecordProductionAdjustment', base));
    expect(firstResult.status, JSON.stringify(firstResult)).toBe('APPLIED');
    const insert = queries.find((entry) => /INSERT INTO production_adjustments/i.test(entry.sql));
    expect(insert?.params?.slice(-5)).toEqual([ticketId, 'entry-linked', 'period-september', 5, 'RESOLVED']);
    expect(JSON.parse(String(queries.find((entry) => /INSERT INTO change_log/i.test(entry.sql))?.params?.[4])))
      .toMatchObject({ originalPeriodId: 'period-september', originalRateSnapshot: 5, attributionStatus: 'RESOLVED' });
    expect(queries.find((entry) => /FROM ticket_entries e/i.test(entry.sql))?.params)
      .toEqual([COMPANY, ticketId, 'entry-linked', 'model-1', 7, 'Bichish']);
    for (const rate of [0, null]) {
      queries.length = 0;
      sourceRows = [{ period_id: 'period-september', rate_snapshot: rate }];
      await processSingleOperation(pool, req, envelope('RecordProductionAdjustment',
        { ...base, operationId: `op-${rate}`, adjustmentId: `adj-${rate}` }));
      const nullRateInsert = queries.find((entry) => /INSERT INTO production_adjustments/i.test(entry.sql));
      expect(nullRateInsert?.params?.at(-2)).toBe(rate);
      expect(nullRateInsert?.params?.at(-1)).toBe('RESOLVED');
      expect(JSON.parse(String(queries.find((entry) => /INSERT INTO change_log/i.test(entry.sql))?.params?.[4])))
        .toMatchObject({ originalRateSnapshot: rate, attributionStatus: 'RESOLVED' });
    }
    queries.length = 0;
    sourceRows = [{ period_id: null, rate_snapshot: null }];
    await processSingleOperation(pool, req, envelope('RecordProductionAdjustment',
      { ...base, operationId: 'op-no-period', adjustmentId: 'adj-no-period' }));
    const noPeriodInsert = queries.find((entry) => /INSERT INTO production_adjustments/i.test(entry.sql));
    expect(noPeriodInsert?.params?.slice(-2)).toEqual([null, 'UNRESOLVED']);
    sourceRows = [];
    expect((await processSingleOperation(pool, req, envelope('RecordProductionAdjustment',
      { ...base, operationId: 'op-wrong', adjustmentId: 'adj-wrong' }))).status).not.toBe('APPLIED');
  });

  it('falls back from trusted operator to device and then SYSTEM for adjustment audit attribution', () => {
    expect(resolveTrustedAuditActor({ auth: { operator: { operatorId: 'trusted-operator' }, deviceId: 'device-1' } })).toBe('trusted-operator');
    expect(resolveTrustedAuditActor({ auth: { deviceId: 'device-1' } })).toBe('device-1');
    expect(resolveTrustedAuditActor({ auth: {} })).toBe('SYSTEM');
  });

  it('serializes Party create and close authoritative reads behind the company/number lock', async () => {
    const createQueries: string[] = [];
    const createPayload = {
      commandId: 'command-party-lock-create',
      operationId: 'operation-party-lock-create',
      companyId: COMPANY,
      partyRecordId: 'party-lock-create',
      partyNumber: '5',
      modelId: 'model-1',
      pattaCount: 1,
      ishSoniPerPatta: 10,
      totalIshSoni: 10,
      ishSoni: 10
    };
    const createPool = {
      connect: async () => ({
        query: async (sql: string) => {
          createQueries.push(sql);
          if (/FROM models/i.test(sql)) return { rows: [{ id: 'model-1' }] };
          if (/FROM company_patta_sequences/i.test(sql)) return { rows: [{ next_patta_number: 1 }] };
          if (/FROM parties/i.test(sql) && /status != 'CLOSED'/i.test(sql)) return { rows: [] };
          if (/INSERT INTO change_log/i.test(sql)) return { rows: [{ change_id: 1, committed_at: '2026-09-22T00:00:00.000Z' }] };
          return { rows: [] };
        },
        release: () => undefined
      })
    } as any;

    const createResult = await processSingleOperation(
      createPool,
      { auth: { companyId: COMPANY, deviceId: 'device-1' } },
      envelope('CreateParty', createPayload)
    );
    expect(createResult.status).toBe('APPLIED');
    const createLocks = createQueries.reduce<number[]>((indexes, sql, index) => {
      if (/pg_advisory_xact_lock\(hashtext\(\$1 \|\| ':party:' \|\| \$2\)/i.test(sql)) indexes.push(index);
      return indexes;
    }, []);
    expect(createLocks).toHaveLength(1);
    expect(createQueries.findIndex((sql) => /FROM models/i.test(sql))).toBeGreaterThan(createLocks[0]);

    const closeQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const closePayload = {
      commandId: 'command-party-lock-close',
      operationId: 'operation-party-lock-close',
      companyId: COMPANY,
      partyRecordId: 'party-lock-close'
    };
    const closePool = {
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          closeQueries.push({ sql, params });
          if (/SELECT party_number FROM parties/i.test(sql) && !/FOR UPDATE/i.test(sql)) return { rows: [{ party_number: '5' }] };
          if (/FROM parties/i.test(sql) && /FOR UPDATE/i.test(sql)) {
            return { rows: [{ id: 'party-lock-close', party_number: '5', status: 'CLOSE_PENDING', server_revision: 1 }] };
          }
          if (/RETURNING closed_at/i.test(sql)) return { rows: [{ closed_at: '2026-09-22T00:00:00.000Z' }] };
          if (/INSERT INTO change_log/i.test(sql)) return { rows: [{ change_id: 2, committed_at: '2026-09-22T00:00:00.000Z' }] };
          return { rows: [] };
        },
        release: () => undefined
      })
    } as any;

    const closeResult = await processSingleOperation(
      closePool,
      { auth: { companyId: COMPANY, deviceId: 'device-1' } },
      envelope('CloseParty', closePayload)
    );
    expect(closeResult.status).toBe('APPLIED');
    const identityLockIndex = closeQueries.findIndex(({ sql }) => /pg_advisory_xact_lock\(hashtext\(\$1 \|\| ':party-identity:' \|\| \$2\)/i.test(sql));
    const numberReadIndex = closeQueries.findIndex(({ sql }) => /SELECT party_number FROM parties/i.test(sql));
    const numberLockIndex = closeQueries.findIndex(({ sql }) => /pg_advisory_xact_lock\(hashtext\(\$1 \|\| ':party:' \|\| \$2\)/i.test(sql));
    const rowLockIndex = closeQueries.findIndex(({ sql }) => /FROM parties/i.test(sql) && /FOR UPDATE/i.test(sql));
    expect(identityLockIndex).toBeGreaterThan(-1);
    expect(numberReadIndex).toBeGreaterThan(identityLockIndex);
    expect(numberLockIndex).toBeGreaterThan(numberReadIndex);
    expect(rowLockIndex).toBeGreaterThan(numberLockIndex);
    expect(closeQueries[identityLockIndex].params).toEqual([COMPANY, 'party-lock-close']);
    expect(closeQueries[numberReadIndex].params).toEqual([COMPANY, 'party-lock-close']);
    expect(closeQueries[numberLockIndex].params).toEqual([COMPANY, '5']);
    expect(closeQueries.some(({ sql }) => /pg_advisory_xact_lock/i.test(sql) && /SELECT party_number FROM parties/i.test(sql))).toBe(false);
    expect(closeQueries.some(({ sql }) => /legacy_party_collision_exceptions|EXHAUSTED/i.test(sql))).toBe(false);
  });
});
