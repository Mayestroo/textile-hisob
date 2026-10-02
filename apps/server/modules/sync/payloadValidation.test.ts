import { describe, expect, it } from 'vitest';
import { canonicalStringify, computePayloadHash } from './canonicalPayload.cjs';

const {
  MAX_OPERATIONS,
  MAX_PAYLOAD_BYTES,
  createValidationError,
  validateCommandPayload,
  validateOperationEnvelope
} = require('./payloadValidation.cjs');
const { processSingleOperation, resolveTrustedAuditActor } = require('./handlers/operations.cjs');

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
    entityType: commandType === 'SubmitTicket' || commandType === 'DeleteTicket' ? 'ticket' : commandType === 'CreateParty' || commandType === 'CloseParty' ? 'party' : commandType === 'ResolveMigrationReconciliationCandidate' ? 'reconciliation_candidate' : 'production_adjustment',
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
  it('validates canonical ticket deletion identity and company scope', () => {
    const payload = { commandId: 'delete-cmd', operationId: 'delete-op', companyId: COMPANY, ticketId: TICKET_ID };
    const operation = envelope('DeleteTicket', payload);
    expect(validateCommandPayload('DeleteTicket', payload, context(operation))).toMatchObject({ ticketId: TICKET_ID, companyId: COMPANY });
    expectCode(() => validateCommandPayload('DeleteTicket', payload, context({ ...operation, entityId: 'other-ticket' })), 'ENTITY_ID_MISMATCH');
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
              server_revision: 1
            }] };
          }
          if (/INSERT INTO change_log/i.test(sql)) {
            return { rows: [{ change_id: 1, committed_at: '2026-09-22T00:00:00.000Z' }] };
          }
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
