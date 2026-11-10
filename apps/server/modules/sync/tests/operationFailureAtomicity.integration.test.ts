import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

const { getServerPool, resetServerDatabase, closeServerPool } = require('../../../infrastructure/db.cjs');
const { verifyFreshPostgres16TestEnvironment } = require('../../../../../scripts/verify/database/verify-pg16-test-env.cjs');
const { processSingleOperation } = require('../handlers/operations.cjs');
const { canonicalStringify, computePayloadHash } = require('../canonicalPayload.cjs');

const postgres = process.env.NOVDA_DISPOSABLE_PG === '1' && Boolean(process.env.NOVDA_PG_URL) && !process.env.DATABASE_URL
  ? describe : describe.skip;
const companyId = 'batch04-atomicity';
const req = { auth: { companyId, deviceId: 'batch04-device' } };

postgres('batch04 durable PostgreSQL rollback and ambiguous commit', () => {
  let pool: any;
  beforeAll(async () => {
    await verifyFreshPostgres16TestEnvironment(process.env.NOVDA_PG_URL);
    pool = getServerPool();
    await resetServerDatabase();
  });
  afterAll(async () => { if (pool) await closeServerPool(); });
  beforeEach(async () => {
    await resetServerDatabase();
    await pool.query(`INSERT INTO models (id, company_id, name, operations_json)
      VALUES ('model-batch04', $1, 'Batch04 model', '[]'::jsonb)`, [companyId]);
    await pool.query(`INSERT INTO workers (id, company_id, name) VALUES (11, $1, 'Fixture worker')`, [companyId]);
  });
  function operation(id: string) {
    const payload = { commandId: `cmd_${id}`, operationId: id, companyId, adjustmentId: `adj_${id}`,
      modelId: 'model-batch04', workerId: 11, opName: 'Sew', deltaQty: 2, effectiveDate: '2026-09-01' };
    return { operationId: id, companyId, commandType: 'RecordProductionAdjustment', entityType: 'production_adjustment',
      entityId: `adj_${id}`, payload, payloadHash: computePayloadHash(canonicalStringify(payload)) };
  }
  function injectedPool(match: (sql: string) => boolean, commitSucceeded = false) {
    let injected = false;
    return { connect: async () => {
      const client = await pool.connect();
      return { release: (error?: Error) => client.release(error), query: async (sql: string, params?: any[]) => {
        if (!injected && match(sql)) {
          injected = true;
          if (commitSucceeded) await client.query(sql, params);
          throw Object.assign(new Error('injected database failure'), { code: '40001' });
        }
        return client.query(sql, params);
      } };
    } };
  }
  async function durable(id: string, expected: number) {
    // pool.query checks out a fresh connection after the attempted transaction.
    const fact = await pool.query('SELECT server_revision FROM production_adjustments WHERE company_id = $1 AND adjustment_id = $2', [companyId, `adj_${id}`]);
    const dedup = await pool.query('SELECT operation_id FROM operations_dedup WHERE company_id = $1 AND operation_id = $2', [companyId, id]);
    const change = await pool.query('SELECT operation_id FROM change_log WHERE company_id = $1 AND operation_id = $2', [companyId, id]);
    expect(fact.rows).toHaveLength(expected);
    expect(dedup.rows).toHaveLength(expected);
    expect(change.rows).toHaveLength(expected);
    if (expected) expect(fact.rows[0].server_revision).toBe(1);
  }

  it.each(['after mutation/changefeed', 'dedup INSERT', 'immediately before COMMIT'])(
    '%s rolls back durably; exact retry and replay each apply once', async (stage) => {
      const op = operation(stage.replace(/\W/g, '_'));
      const options = stage === 'after mutation/changefeed'
        ? { testHookBeforeCommit: async () => { throw new Error('injected database failure'); } } : {};
      const failingPool = stage === 'dedup INSERT'
        ? injectedPool((sql) => sql.includes('INSERT INTO operations_dedup'))
        : stage === 'immediately before COMMIT' ? injectedPool((sql) => sql === 'COMMIT') : pool;
      await expect(processSingleOperation(failingPool, req, op, options)).rejects.toThrow('injected database failure');
      await durable(op.operationId, 0);
      expect(await processSingleOperation(pool, req, op)).toMatchObject({ status: 'APPLIED', isReplay: false });
      expect(await processSingleOperation(pool, req, op)).toMatchObject({ status: 'APPLIED', isReplay: true });
      await durable(op.operationId, 1);
    }
  );

  it('COMMIT succeeded but acknowledgement was lost: exact replay has no second durable effects', async () => {
    const op = operation('committed_without_ack');
    await expect(processSingleOperation(injectedPool((sql) => sql === 'COMMIT', true), req, op))
      .rejects.toThrow('injected database failure');
    await durable(op.operationId, 1);
    expect(await processSingleOperation(pool, req, op)).toMatchObject({ status: 'APPLIED', isReplay: true });
    await durable(op.operationId, 1);
  });
});
