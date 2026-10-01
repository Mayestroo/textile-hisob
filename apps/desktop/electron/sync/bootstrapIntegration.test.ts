import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildFastifyServer } = require('../../../server/app.cjs');
const { getServerPool, resetServerDatabase, closeServerPool } = require('../../../server/infrastructure/db.cjs');
const { verifyFreshPostgres16TestEnvironment } = require('../../../../scripts/verify/verify-pg16-test-env.cjs');
const { getCompanyDatabase, closeAllCompanyDatabases } = require('../database/databaseManager.cjs');
const { loadWorkbookProjectionFromSqlite } = require('../database/projectionReader.cjs');
const { SyncClient } = require('./syncClient.cjs');
const { ensureCompanyBootstrapped } = require('./bootstrapInitializer.cjs');
const { applyBootstrapSnapshot, getBootstrapState } = require('./bootstrapApplier.cjs');

const describePostgresIntegration = process.env.NOVDA_DISPOSABLE_PG === '1'
  && Boolean(process.env.NOVDA_PG_URL)
  && !process.env.DATABASE_URL
  ? describe
  : describe.skip;

describePostgresIntegration(' PostgreSQL-to-SQLite bootstrap integration', () => {
  const companyId = 'bootstrap-desktop-integration';
  const token = `novda-test-token:${companyId}:bootstrap-integration-device`;
  let pool: any;
  let app: any;
  let baseUrl: string;
  let userData: string;
  let localDb: any;

  async function seedProductionLikeCanonicalBaseline() {
    await pool.query(`
      INSERT INTO models (
        id, company_id, name, operations_json, hisob_sheet_name, title, party, color, size,
        patta_ops_order_json, status, server_revision
      )
      SELECT 'model_' || series, $1, 'Model ' || series,
        '[{"id":"operation-sew","name":"Sew","rate":12.5}]'::jsonb,
        'Model ' || series || '-hisob', 'Model- ' || series, '', 'Black', 'M', '["Sew"]'::jsonb,
        'ACTIVE', 1
      FROM generate_series(1, 18) AS series
    `, [companyId]);
    await pool.query(`
      INSERT INTO workers (id, company_id, name, status, staj, role, server_revision)
      SELECT series, $1, 'Worker ' || series, 'ACTIVE', 0, 'Operator', 1
      FROM generate_series(1, 201) AS series
    `, [companyId]);
    await pool.query(`
      INSERT INTO periods (id, company_id, name, start_date, is_closed, status, server_revision)
      VALUES ('period-current', $1, 'September 2026', '2026-09-01', 0, 'OPEN', 1)
    `, [companyId]);
    await pool.query(`
      INSERT INTO parties (
        id, company_id, party_number, physical_party_number, model_id, model_name,
        patta_count, cumulative_patta_count, ish_soni, cumulative_ish_soni,
        sizes_json, status, server_revision
      )
      SELECT 'party_' || series, $1, series::text, series::text,
        'model_' || (((series - 1) % 18) + 1), 'Model ' || (((series - 1) % 18) + 1),
        0, 0, 0, 0, '{}'::jsonb, 'ACTIVE', 1
      FROM generate_series(1, 42) AS series
    `, [companyId]);
    await pool.query(`
      INSERT INTO worker_telegram_bindings (telegram_id, company_id, worker_id, username)
      VALUES ('123456789', $1, 200, 'worker200')
    `, [companyId]);
    await pool.query(`
      INSERT INTO worker_adjustments (id, company_id, worker_id, type, amount, source_id, provenance, created_at, period_id)
      SELECT 'opening-avans-' || series, $1, 1, 'AVANS', 505000, 'source-avans-' || series,
        'OWNER_APPROVED_BASELINE', '2026-09-01T00:00:00Z', 'period-current'
      FROM generate_series(1, 4) AS series
    `, [companyId]);
    await pool.query(`
      INSERT INTO worker_adjustments (id, company_id, worker_id, type, amount, source_id, provenance, created_at, period_id)
      SELECT 'opening-jarima-' || series, $1, 1, 'JARIMA',
        CASE WHEN series = 7 THEN 78574 ELSE 78571 END, 'source-jarima-' || series,
        'OWNER_APPROVED_BASELINE', '2026-09-01T00:00:00Z', 'period-current'
      FROM generate_series(1, 7) AS series
    `, [companyId]);
    await pool.query(`
      INSERT INTO company_batch_settings (company_id, available_sizes_json, server_revision)
      VALUES ($1, '["S","M","L"]'::jsonb, 1)
    `, [companyId]);
    await pool.query(`
      INSERT INTO patta_batch_settings (company_id, model_id, color)
      SELECT $1::VARCHAR, id, color FROM models WHERE company_id = $1::VARCHAR
    `, [companyId]);
  }

  beforeAll(async () => {
    await verifyFreshPostgres16TestEnvironment(process.env.NOVDA_PG_URL);
    pool = getServerPool();
    await resetServerDatabase();
    app = buildFastifyServer({ pool, allowTestTokens: true });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    if (app) await app.close();
    closeAllCompanyDatabases();
    await closeServerPool();
  });

  beforeEach(async () => {
    await resetServerDatabase();
    closeAllCompanyDatabases();
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-bootstrap-pg-client-'));
    localDb = getCompanyDatabase(userData, companyId);
    await seedProductionLikeCanonicalBaseline();
  });

  afterEach(() => {
    closeAllCompanyDatabases();
    if (userData && fs.existsSync(userData)) fs.rmSync(userData, { recursive: true, force: true });
  });

  it('hydrates a fresh SQLite DB to exact 201/18/42 PostgreSQL baseline and the same-snapshot cursor', async () => {
    const client = new SyncClient({ baseUrl, token, deviceId: 'bootstrap-integration-device', allowHttp: true });
    const result = await ensureCompanyBootstrapped(localDb, companyId, client);

    expect(result).toMatchObject({ status: 'APPLIED', cursor: '0', counts: {
      workers: 201, models: 18, parties: 42, workerAdjustments: 11,
      tickets: 0, ticketEntries: 0, productionAdjustments: 0
    } });
    expect(getBootstrapState(localDb, companyId)).toMatchObject({ status: 'COMPLETE', cursor: '0' });
    const projection = loadWorkbookProjectionFromSqlite(localDb, companyId);
    expect(projection.workers).toHaveLength(201);
    expect(projection.models).toHaveLength(18);
    expect(projection.printedPartyHistory).toHaveLength(42);
    expect(projection.workers.find((worker: any) => worker.id === 1)).toMatchObject({ avans: 2020000, jarima: 550000 });
    expect(projection.models[0].operations).toEqual([{ id: 'operation-sew', name: 'Sew', rate: 12.5 }]);
    expect(projection.pattaBatchConfigs['model_1']).toMatchObject({ partyNumber: '', isCustomParty: false, totalIshSoni: '' });
    expect(localDb.prepare('SELECT COUNT(*) AS count FROM tickets').get().count).toBe(0);
    expect(localDb.prepare('SELECT COUNT(*) AS count FROM ticket_entries').get().count).toBe(0);
    expect(localDb.prepare('SELECT COUNT(*) AS count FROM production_adjustments').get().count).toBe(0);

    const serverWorkerPolicy = await pool.query(`
      SELECT w.id, b.telegram_id FROM workers w
      LEFT JOIN worker_telegram_bindings b ON b.company_id = w.company_id AND b.worker_id = w.id
      WHERE w.company_id = $1 AND w.id IN (200, 201) ORDER BY w.id
    `, [companyId]);
    expect(serverWorkerPolicy.rows).toEqual([
      { id: 200, telegram_id: '123456789' },
      { id: 201, telegram_id: null }
    ]);
    const serverCounts = await pool.query(`
      SELECT (SELECT COUNT(*) FROM printed_pattas WHERE company_id = $1)::int AS pattas,
        (SELECT COUNT(*) FROM tickets WHERE company_id = $1)::int AS tickets,
        (SELECT COUNT(*) FROM ticket_entries WHERE company_id = $1)::int AS entries,
        (SELECT COUNT(*) FROM production_adjustments WHERE company_id = $1)::int AS adjustments,
        (SELECT COALESCE(MAX(id), 0) + 1 FROM workers WHERE company_id = $1)::int AS next_worker_id
    `, [companyId]);
    expect(serverCounts.rows[0]).toEqual({ pattas: 0, tickets: 0, entries: 0, adjustments: 0, next_worker_id: 202 });
  });

  it('retries after a local pre-commit crash without leaving partial rows or a completed marker', async () => {
    const client = new SyncClient({ baseUrl, token, deviceId: 'bootstrap-integration-device', allowHttp: true });
    const response = await client.getBootstrap();
    expect(() => applyBootstrapSnapshot(localDb, companyId, response, {
      testHookBeforeCommit: () => { throw new Error('SIMULATED_BOOTSTRAP_PROCESS_CRASH'); }
    })).toThrow('SIMULATED_BOOTSTRAP_PROCESS_CRASH');
    expect(getBootstrapState(localDb, companyId)).toMatchObject({ status: 'NEEDS_BOOTSTRAP' });
    expect(localDb.prepare('SELECT COUNT(*) AS count FROM workers').get().count).toBe(0);

    const retry = await ensureCompanyBootstrapped(localDb, companyId, client);
    expect(retry.status).toBe('APPLIED');
    expect(localDb.prepare('SELECT COUNT(*) AS count FROM workers').get().count).toBe(201);
  });
});
