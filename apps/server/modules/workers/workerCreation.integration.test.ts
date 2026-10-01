import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

const { getServerPool, resetServerDatabase, closeServerPool } = require('../../infrastructure/db.cjs');
const { buildFastifyServer } = require('../../app.cjs');
const { normalizeCreateWorkerRequest } = require('./workerCreation.cjs');

const describePostgresIntegration = process.env.NOVDA_DISPOSABLE_PG === '1'
  && Boolean(process.env.NOVDA_PG_URL)
  && !process.env.DATABASE_URL
  ? describe
  : describe.skip;

describe('worker create request contract', () => {
  it('derives tenant and device authority from auth and accepts only request identity', () => {
    const request = normalizeCreateWorkerRequest(
      { companyId: 'company-a', deviceId: 'device-a' },
      {
        operationId: '00000000-0000-4000-8000-000000000501',
        name: '  New Worker  ',
        staj: 3,
        role: 'Operator',
        balanceAdjustments: []
      }
    );
    expect(request).toMatchObject({
      companyId: 'company-a',
      deviceId: 'device-a',
      operationId: '00000000-0000-4000-8000-000000000501',
      name: 'New Worker',
      staj: 3,
      role: 'Operator',
      balanceAdjustments: []
    });
    expect(request).not.toHaveProperty('workerId');
  });

  it.each(['id', 'workerId', 'canonicalWorkerId', 'deletedWorkerIds', 'companyId'])(
    'rejects client-supplied %s authority',
    (field) => {
      expect(() => normalizeCreateWorkerRequest(
        { companyId: 'company-a', deviceId: 'device-a' },
        { operationId: '00000000-0000-4000-8000-000000000502', name: 'New Worker', [field]: 202 }
      )).toThrowError(expect.objectContaining({ code: 'CLIENT_WORKER_ID_FORBIDDEN' }));
    }
  );

  it('does not accept allocationId as a worker business identity', () => {
    expect(() => normalizeCreateWorkerRequest(
      { companyId: 'company-a', deviceId: 'device-a' },
      { operationId: '00000000-0000-4000-8000-000000000503', name: 'New Worker', allocationId: 202 }
    )).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_CREATE_REQUEST' }));
  });
});

describePostgresIntegration('authoritative PostgreSQL worker creation', () => {
  const companyId = 'worker-create-pg-test';
  const sourceHash = 'a'.repeat(64);
  let pool: any;
  let app: any;

  const headers = {
    authorization: `Bearer novda-test-token:${companyId}:worker-create-device`,
    'x-client-version': '2.0.0'
  };

  async function create(body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/workers', headers, payload: body });
  }

  beforeAll(async () => { pool = getServerPool(); });
  afterAll(async () => { await closeServerPool(); });
  beforeEach(async () => {
    await resetServerDatabase();
    const now = new Date().toISOString();
    const decisionId = 'worker-create-baseline-decision';
    await pool.query(`INSERT INTO migration_baseline_decisions (
      baseline_decision_id, company_id, decision, scope_json, source_path, source_size,
      source_mtime, source_snapshot_hash, decided_at
    ) VALUES ($1, $2, 'CLEAN_PRODUCTION_LEDGER_BASELINE', $3::jsonb, $4, 1, $5, $6, $5)`, [
      decisionId, companyId, JSON.stringify({}), 'legacy://test/companies/worker-create-pg-test/syncData', now, sourceHash
    ]);
    await pool.query(`INSERT INTO baseline_import_runs (
      baseline_import_run_id, company_id, source_snapshot_hash, baseline_decision_id, status
    ) VALUES ($1, $2, $3, $4, 'APPLIED')`, ['worker-create-baseline-run', companyId, sourceHash, decisionId]);
    await pool.query(`INSERT INTO workers (id, company_id, name, staj, status) VALUES
      (200, $1, 'Historical Worker 200', 0, 'ACTIVE'),
      (201, $1, 'Historical Worker 201', 0, 'ACTIVE')`, [companyId]);
    app = buildFastifyServer({ pool, allowTestTokens: true, minClientVersion: '2.0.0' });
    await app.ready();
  });
  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('allocates by worker.id, recovers a lost ACK through replay without duplication, and allocates 203 next', async () => {
    const operationId = crypto.randomUUID();
    const body = { operationId, name: 'First New Worker', staj: 4, role: 'Operator' };

    const created = await create(body);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ success: true, operationId, worker: { id: 202, name: body.name } });
    expect(created.json().worker).not.toHaveProperty('allocationId');

    const replay = await create(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ success: true, operationId, replay: true, worker: { id: 202 } });
    expect(replay.json().worker).not.toHaveProperty('allocationId');
    expect((await pool.query('SELECT COUNT(*) FROM workers WHERE company_id = $1 AND id = 202', [companyId])).rows[0].count)
      .toBe('1');

    const conflict = await create({ ...body, name: 'Different payload' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');

    const next = await create({ operationId: crypto.randomUUID(), name: 'Second New Worker' });
    expect(next.statusCode).toBe(201);
    expect(next.json().worker.id).toBe(203);

    const evidence = await pool.query(`
      SELECT w.id, d.command_type, d.entity_id, d.result_json->'worker'->>'id' AS result_worker_id
      FROM workers w JOIN operations_dedup d ON d.company_id = w.company_id AND d.entity_id = w.id::text
      WHERE w.company_id = $1 ORDER BY w.id
    `, [companyId]);
    expect(evidence.rows).toEqual([
      expect.objectContaining({ id: 202, command_type: 'CreateWorker', entity_id: '202', result_worker_id: '202' }),
      expect.objectContaining({ id: 203, command_type: 'CreateWorker', entity_id: '203', result_worker_id: '203' })
    ]);
  });

  it('serializes concurrent distinct requests into unique monotonically increasing worker IDs', async () => {
    const requests = Array.from({ length: 12 }, (_, index) => create({
      operationId: crypto.randomUUID(),
      name: `Concurrent Worker ${index + 1}`
    }));
    const responses = await Promise.all(requests);

    expect(responses.every((response: any) => response.statusCode === 201)).toBe(true);
    expect(responses.map((response: any) => response.json().worker.id).sort((a: number, b: number) => a - b))
      .toEqual(Array.from({ length: 12 }, (_, index) => 202 + index));
    const rows = await pool.query('SELECT id FROM workers WHERE company_id = $1 ORDER BY id', [companyId]);
    expect(rows.rows.map((row: any) => row.id)).toEqual(Array.from({ length: 14 }, (_, index) => 200 + index));
  });

  it('rejects client-assigned IDs and does not change the roster', async () => {
    const rejected = await create({ operationId: crypto.randomUUID(), workerId: 202, name: 'Forged Worker' });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('CLIENT_WORKER_ID_FORBIDDEN');
    const count = await pool.query('SELECT COUNT(*) FROM workers WHERE company_id = $1', [companyId]);
    expect(count.rows[0].count).toBe('2');
  });
});
