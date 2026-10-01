import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildFastifyServer } from './app.cjs';
import { getServerPool, resetServerDatabase, closeServerPool } from './infrastructure/db.cjs';
import { provisionDevice } from './auth/deviceProvisioning.cjs';
import { provisionOperator } from './auth/operatorAuth.cjs';
import { canonicalStringify, computePayloadHash } from './modules/sync/canonicalPayload.cjs';

describe('live PostgreSQL trusted operator reconciliation authority', () => {
  const companyId = 'phase2-rbac-fixture';
  const deviceId = 'phase2-rbac-device';
  let pool: any;
  let app: any;
  let deviceToken: string;
  let adminToken: string;

  beforeAll(async () => {
    pool = getServerPool();
    await resetServerDatabase();
    const device = await provisionDevice(pool, { deviceId, companyId });
    deviceToken = device.token;
    await provisionOperator(pool, { operatorId: 'phase2-admin', companyId, displayName: 'Phase 2 Admin', role: 'admin', password: 'phase2-test-password' });
    app = buildFastifyServer({ pool, allowTestTokens: false, businessMutationsEnabled: true });
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: '/api/auth/operator/login',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { operatorId: 'phase2-admin', password: 'phase2-test-password' }
    });
    adminToken = JSON.parse(login.payload).session.token;
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeServerPool();
  });

  beforeEach(async () => {
    // Audit rows are immutable by trigger; isolate each fixture with TRUNCATE.
    await pool.query(`TRUNCATE TABLE
      operations_dedup,
      change_log,
      migration_reconciliation_resolutions,
      production_adjustments,
      migration_reconciliation_candidates
      RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO migration_reconciliation_candidates
      (candidate_id, company_id, model_id, worker_id, operation_name, legacy_qty, ticket_derived_qty, delta_qty, reason, source_snapshot_hash)
      VALUES ('phase2-candidate', $1, 'model-fixture', 1, 'Bichish', 10, 0, 10, 'fixture', repeat('a', 64))`, [companyId]);
  });

  function operation(operationId: string, decision: string, operatorId = 'phase2-admin') {
    const payload = {
      commandId: `cmd-${operationId}`, operationId, companyId, candidateId: 'phase2-candidate', decision,
      operatorId, operatorRole: 'admin', reason: 'fixture decision', effectiveDate: '2026-09-01'
    };
    return { operationId, companyId, commandType: 'ResolveMigrationReconciliationCandidate', entityType: 'reconciliation_candidate', entityId: 'phase2-candidate', payload, payloadHash: computePayloadHash(canonicalStringify(payload)) };
  }

  async function send(op: any, token = adminToken, device = deviceToken) {
    return app.inject({
      method: 'POST', url: '/api/sync/operations',
      headers: { authorization: `Bearer ${device}`, 'x-operator-token': token },
      payload: { operations: [op] }
    });
  }

  it('two authorized clients resolving one candidate produce exactly one winner', async () => {
    const [confirm, reject] = await Promise.all([
      send(operation('phase2-confirm', 'CONFIRM_LEGACY_AS_ADJUSTMENT')),
      send(operation('phase2-reject', 'REJECT_LEGACY_DIFFERENCE'))
    ]);
    const results = [JSON.parse(confirm.payload).results[0], JSON.parse(reject.payload).results[0]];
    expect(results.filter((result) => result.status === 'APPLIED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'REJECTED' || result.status === 'CONFLICT')).toHaveLength(1);
    const rows = await pool.query('SELECT status FROM migration_reconciliation_candidates WHERE company_id = $1 AND candidate_id = $2', [companyId, 'phase2-candidate']);
    const adjustments = await pool.query('SELECT COUNT(*) FROM production_adjustments WHERE company_id = $1', [companyId]);
    expect(['APPROVED', 'REJECTED']).toContain(rows.rows[0].status);
    expect(Number(adjustments.rows[0].count)).toBe(rows.rows[0].status === 'APPROVED' ? 1 : 0);
  });

  it('reconciliation mutation rolls back when failure is injected before commit', async () => {
    const { processSingleOperation } = require('./modules/sync/handlers/operations.cjs');
    const payload = operation('phase2-rollback', 'CONFIRM_LEGACY_AS_ADJUSTMENT');
    await processSingleOperation(pool, { auth: { companyId, deviceId, operator: { operatorId: 'phase2-admin', companyId, deviceId, role: 'admin', isActive: true } } }, payload, { testHookBeforeCommit: async () => { throw new Error('fixture failure'); } });
    const resolution = await pool.query('SELECT COUNT(*) FROM migration_reconciliation_resolutions WHERE company_id = $1', [companyId]);
    const adjustment = await pool.query('SELECT COUNT(*) FROM production_adjustments WHERE company_id = $1', [companyId]);
    const log = await pool.query('SELECT COUNT(*) FROM change_log WHERE company_id = $1', [companyId]);
    expect(Number(resolution.rows[0].count)).toBe(0);
    expect(Number(adjustment.rows[0].count)).toBe(0);
    expect(Number(log.rows[0].count)).toBe(0);
  });
});
