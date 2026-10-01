import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildFastifyServer } from './app.cjs';
import { provisionDevice } from './auth/deviceProvisioning.cjs';
import { provisionOperator } from './auth/operatorAuth.cjs';
import { closeServerPool, getServerPool, resetServerDatabase } from './infrastructure/db.cjs';
import { canonicalStringify, computePayloadHash } from './modules/sync/canonicalPayload.cjs';

describe('authoritative period-close enforcement', () => {
  const companyId = 'period-close-authority';
  const deviceId = 'period-close-device';
  let pool: any;
  let app: any;
  let deviceToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    pool = getServerPool();
    await resetServerDatabase();
    app = buildFastifyServer({ pool, allowTestTokens: false, businessMutationsEnabled: true });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeServerPool();
  });

  beforeEach(async () => {
    await resetServerDatabase();
    await pool.query(`DELETE FROM periods WHERE company_id = $1`, [companyId]);
    ({ token: deviceToken } = await provisionDevice(pool, { companyId, deviceId }));
    await provisionOperator(pool, { operatorId: 'period-close-admin', companyId, displayName: 'Period Close Admin', role: 'admin', password: 'period-close-password' });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/operator/login',
      headers: { authorization: `Bearer ${deviceToken}`, 'x-client-version': '2.0.0' },
      payload: { operatorId: 'period-close-admin', password: 'period-close-password' }
    });
    operatorToken = JSON.parse(login.payload).session.token;
    await pool.query(`INSERT INTO models (id, company_id, name, operations_json) VALUES ('model-period', $1, 'Period Model', '[{"name":"Bichish"}]')`, [companyId]);
    await pool.query(`INSERT INTO workers (id, company_id, name) VALUES (1, $1, 'Period Worker')`, [companyId]);
    await pool.query(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status) VALUES ('party-period', $1, '1', '1', 'model-period', 'ACTIVE')`, [companyId]);
    await pool.query(`INSERT INTO periods (id, company_id, start_date, end_date, is_closed) VALUES ('august-closed', $1, '2026-08-01', '2026-08-31', 1)`, [companyId]);
  });

  async function send(operation: any, operator = false) {
    return app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: {
        authorization: `Bearer ${deviceToken}`,
        'x-client-version': '2.0.0',
        ...(operator ? { 'x-operator-token': operatorToken } : {})
      },
      payload: { operations: [operation] }
    });
  }

  function descriptor(commandType: string, operationId: string, entityId: string, payload: any) {
    return {
      operationId,
      companyId,
      commandType,
      entityType: commandType === 'SubmitTicket' ? 'ticket' : commandType === 'ResolveMigrationReconciliationCandidate' ? 'reconciliation_candidate' : 'production_adjustment',
      entityId,
      payload,
      payloadHash: computePayloadHash(canonicalStringify(payload))
    };
  }

  function ticket(ticketId: string, operationId: string, effectiveDate?: string, submittedAt?: string) {
    return {
      commandId: `cmd-${operationId}`,
      operationId,
      companyId,
      ticketId,
      modelId: 'model-period',
      partyNumber: '1',
      partyRecordId: 'party-period',
      pattaNumber: 1,
      qty: 1,
      entries: [{ opName: 'Bichish', workerId: 1, qty: 1 }],
      ...(effectiveDate ? { effectiveDate } : {}),
      ...(submittedAt ? { submittedAt } : {})
    };
  }

  it('accepts open dates, rejects both closed boundaries, and preserves ISO business dates without timezone shifting', async () => {
    const cases = [
      ['00000000-0000-4000-8000-000000000401', 'op-period-jul', '2026-07-31', 'APPLIED'],
      ['00000000-0000-4000-8000-000000000402', 'op-period-start', '2026-08-01', 'REJECTED'],
      ['00000000-0000-4000-8000-000000000403', 'op-period-end', '2026-08-31', 'REJECTED'],
      ['00000000-0000-4000-8000-000000000404', 'op-period-sep', '2026-09-01', 'APPLIED']
    ] as const;
    for (const [ticketId, operationId, effectiveDate, status] of cases) {
      const payload = ticket(ticketId, operationId, effectiveDate);
      const result = JSON.parse((await send(descriptor('SubmitTicket', operationId, ticketId, payload))).payload).results[0];
      expect(result.status).toBe(status);
      if (status === 'REJECTED') expect(result.error.code).toBe('PERIOD_CLOSED');
    }

    const timezonePayload = ticket('00000000-0000-4000-8000-000000000405', 'op-period-iso', '2026-07-31', '2026-08-01T00:30:00+14:00');
    const timezoneResult = JSON.parse((await send(descriptor('SubmitTicket', 'op-period-iso', timezonePayload.ticketId, timezonePayload))).payload).results[0];
    expect(timezoneResult.status).toBe('APPLIED');

    const fallbackPayload = ticket('00000000-0000-4000-8000-000000000406', 'op-period-submitted', undefined, '2026-09-01T00:00:00.000Z');
    const fallbackResult = JSON.parse((await send(descriptor('SubmitTicket', 'op-period-submitted', fallbackPayload.ticketId, fallbackPayload))).payload).results[0];
    expect(fallbackResult.status).toBe('APPLIED');
  });

  it('enforces period close for production adjustments and reversals', async () => {
    const openAdjustment = { commandId: 'cmd-adjust-open', operationId: 'op-adjust-open', companyId, adjustmentId: 'adjust-open', modelId: 'model-period', workerId: 1, opName: 'Bichish', deltaQty: 5, reason: 'fixture', effectiveDate: '2026-07-31' };
    expect(JSON.parse((await send(descriptor('RecordProductionAdjustment', 'op-adjust-open', 'adjust-open', openAdjustment))).payload).results[0].status).toBe('APPLIED');

    const closedAdjustment = { ...openAdjustment, commandId: 'cmd-adjust-closed', operationId: 'op-adjust-closed', adjustmentId: 'adjust-closed', effectiveDate: '2026-08-01' };
    const closedAdjustmentResult = JSON.parse((await send(descriptor('RecordProductionAdjustment', 'op-adjust-closed', 'adjust-closed', closedAdjustment))).payload).results[0];
    expect(closedAdjustmentResult.error.code).toBe('PERIOD_CLOSED');

    const closedReversal = { commandId: 'cmd-reverse-closed', operationId: 'op-reverse-closed', companyId, reversalId: 'reverse-closed', originalAdjustmentId: 'adjust-open', baseRevision: 1, reason: 'fixture', effectiveDate: '2026-08-31' };
    const closedReversalResult = JSON.parse((await send(descriptor('ReverseProductionAdjustment', 'op-reverse-closed', 'reverse-closed', closedReversal))).payload).results[0];
    expect(closedReversalResult.error.code).toBe('PERIOD_CLOSED');

    const openReversal = { ...closedReversal, commandId: 'cmd-reverse-open', operationId: 'op-reverse-open', reversalId: 'reverse-open', effectiveDate: '2026-09-01' };
    expect(JSON.parse((await send(descriptor('ReverseProductionAdjustment', 'op-reverse-open', 'reverse-open', openReversal))).payload).results[0].status).toBe('APPLIED');
  });

  it('does not allow authorized reconciliation to bypass period close', async () => {
    for (const candidateId of ['candidate-closed', 'candidate-open']) {
      await pool.query(
        `INSERT INTO migration_reconciliation_candidates (candidate_id, company_id, model_id, worker_id, operation_name, legacy_qty, ticket_derived_qty, delta_qty, reason, source_snapshot_hash)
         VALUES ($1, $2, 'model-period', 1, 'Bichish', 5, 0, 5, 'fixture', repeat('a', 64))`,
        [candidateId, companyId]
      );
    }

    const closed = { commandId: 'cmd-reconcile-closed', operationId: 'op-reconcile-closed', companyId, candidateId: 'candidate-closed', decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT', operatorId: 'period-close-admin', operatorRole: 'admin', reason: 'fixture', effectiveDate: '2026-08-01' };
    const closedResult = JSON.parse((await send(descriptor('ResolveMigrationReconciliationCandidate', 'op-reconcile-closed', 'candidate-closed', closed), true)).payload).results[0];
    expect(closedResult.status).toBe('REJECTED');
    expect(closedResult.error.code).toBe('PERIOD_CLOSED');

    const open = { ...closed, commandId: 'cmd-reconcile-open', operationId: 'op-reconcile-open', candidateId: 'candidate-open', effectiveDate: '2026-09-01' };
    const openResult = JSON.parse((await send(descriptor('ResolveMigrationReconciliationCandidate', 'op-reconcile-open', 'candidate-open', open), true)).payload).results[0];
    expect(openResult.status).toBe('APPLIED');
    expect((await pool.query(`SELECT status FROM migration_reconciliation_candidates WHERE company_id = $1 AND candidate_id = 'candidate-open'`, [companyId])).rows[0].status).toBe('APPROVED');
  });
});
