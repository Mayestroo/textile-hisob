import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

const { buildFastifyServer } = require('./app.cjs');
const { getServerPool, resetServerDatabase, closeServerPool } = require('./infrastructure/db.cjs');
const { verifyFreshPostgres16TestEnvironment } = require('../../scripts/verify/verify-pg16-test-env.cjs');

const describePostgresIntegration = process.env.NOVDA_DISPOSABLE_PG === '1'
  && Boolean(process.env.NOVDA_PG_URL)
  && !process.env.DATABASE_URL
  ? describe
  : describe.skip;

describePostgresIntegration('authenticated  PostgreSQL bootstrap', () => {
  const companyId = 'comp_novda';
  const otherCompanyId = 'bootstrap-other-company';
  const headers = {
    authorization: `Bearer novda-test-token:${companyId}:bootstrap-device`,
    'x-client-version': '2.0.0'
  };
  let pool: any;
  let app: any;
  let snapshotTestHook: ((value: any) => Promise<void>) | null = null;

  async function seedApprovedBaseline() {
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
      VALUES ('period-current', $1, 'September 2026', '2026-09-01', 0, 'OPEN', 1),
             ('period-archive', $1, 'August 2026', '2026-08-01', 1, 'CLOSED', 1)
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
      INSERT INTO patta_batch_settings (
        company_id, model_id, party_number, is_custom_party, total_ish_soni, color, sizes_json, server_revision
      ) VALUES ($1, 'model_1', '42', true, '446', 'Black', '{"M":"446"}'::jsonb, 1)
    `, [companyId]);
    await pool.query(`
      INSERT INTO period_archives (company_id, period_id, archive_json, sha256, archived_at)
      VALUES ($1, 'period-archive', '{"periodId":"period-archive","workers":[]}'::jsonb, $2, '2026-09-01T00:00:00Z')
    `, [companyId, 'a'.repeat(64)]);
  }

  async function addBaselineImportEvidence() {
    const now = new Date().toISOString();
    const sourceHash = 'b'.repeat(64);
    const decisionId = 'bootstrap-approved-baseline';
    await pool.query(`INSERT INTO migration_baseline_decisions (
      baseline_decision_id, company_id, decision, scope_json, source_path, source_size,
      source_mtime, source_snapshot_hash, decided_at
    ) VALUES ($1, $2, 'CLEAN_PRODUCTION_LEDGER_BASELINE', '{}'::jsonb, 'fixture://approved-baseline', 1, $3, $4, $3)`,
    [decisionId, companyId, now, sourceHash]);
    await pool.query(`INSERT INTO baseline_import_runs (
      baseline_import_run_id, company_id, source_snapshot_hash, baseline_decision_id, status
    ) VALUES ('bootstrap-baseline-run', $1, $2, $3, 'APPLIED')`, [companyId, sourceHash, decisionId]);
  }

  beforeAll(async () => {
    await verifyFreshPostgres16TestEnvironment(process.env.NOVDA_PG_URL);
    pool = getServerPool();
    await resetServerDatabase();
    app = buildFastifyServer({
      pool,
      allowTestTokens: true,
      bootstrapTestHook: async (snapshot: any, cursor: string) => {
        if (snapshotTestHook) await snapshotTestHook({ snapshot, cursor });
      }
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeServerPool();
  });

  beforeEach(async () => {
    snapshotTestHook = null;
    await resetServerDatabase();
    await seedApprovedBaseline();
  });

  it('returns the exact PostgreSQL clean baseline, opening balances, and required references without fabricated facts', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sync/bootstrap', headers });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.success).toBe(true);
    expect(result.snapshot.company).toEqual({ companyId });
    expect(result.snapshot.models).toHaveLength(18);
    expect(result.snapshot.workers).toHaveLength(201);
    expect(result.snapshot.parties).toHaveLength(42);
    expect(result.snapshot.periods).toHaveLength(2);
    expect(result.snapshot.workerAdjustments).toHaveLength(11);
    expect(result.snapshot.workerAdjustments.filter((adjustment: any) => adjustment.type === 'AVANS')).toHaveLength(4);
    expect(result.snapshot.workerAdjustments.filter((adjustment: any) => adjustment.type === 'JARIMA')).toHaveLength(7);
    expect(result.snapshot.batchSettings).toMatchObject({
      company: { availableSizes: ['S', 'M', 'L'] },
      models: [{ modelId: 'model_1', partyNumber: '42', totalIshSoni: '446' }]
    });
    expect(result.snapshot.periodArchives).toHaveLength(1);
    expect(result.snapshot.models[0].operations).toEqual([{ id: 'operation-sew', name: 'Sew', rate: 12.5 }]);
    expect(result.snapshot.tickets).toEqual([]);
    expect(result.snapshot.productionAdjustments).toEqual([]);
    expect(result.counts).toMatchObject({
      workers: 201,
      models: 18,
      parties: 42,
      tickets: 0,
      ticketEntries: 0,
      productionAdjustments: 0
    });
    expect(result.cursor).toBe('0');
    expect(result.nextPattaNumber).toBe(1);
    expect(JSON.stringify(result.snapshot)).not.toContain('telegram');
    expect(result.snapshot).not.toHaveProperty('deletedWorkerIds');
    expect(result.snapshot).not.toHaveProperty('printedPattas');

    const workerRows = await pool.query(`
      SELECT w.id, b.telegram_id FROM workers w
      LEFT JOIN worker_telegram_bindings b ON b.company_id = w.company_id AND b.worker_id = w.id
      WHERE w.company_id = $1 AND w.id IN (200, 201) ORDER BY w.id
    `, [companyId]);
    expect(workerRows.rows).toEqual([
      { id: 200, telegram_id: '123456789' },
      { id: 201, telegram_id: null }
    ]);
    const facts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM printed_pattas WHERE company_id = $1)::int AS pattas,
        (SELECT COUNT(*) FROM tickets WHERE company_id = $1)::int AS tickets,
        (SELECT COUNT(*) FROM ticket_entries WHERE company_id = $1)::int AS entries,
        (SELECT COUNT(*) FROM production_adjustments WHERE company_id = $1)::int AS adjustments,
        (SELECT COALESCE(MAX(id), 0) + 1 FROM workers WHERE company_id = $1)::int AS next_worker_id,
        (SELECT SUM(amount) FROM worker_adjustments WHERE company_id = $1 AND type = 'AVANS')::numeric AS avans,
        (SELECT SUM(amount) FROM worker_adjustments WHERE company_id = $1 AND type = 'JARIMA')::numeric AS jarima
    `, [companyId]);
    expect(facts.rows[0]).toMatchObject({ pattas: 0, tickets: 0, entries: 0, adjustments: 0, next_worker_id: 202, avans: '2020000', jarima: '550000' });
  });

  it('requires device authentication and rejects a supplied cross-company scope', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/sync/bootstrap' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error.code).toBe('AUTH_REQUIRED');

    await pool.query(`INSERT INTO workers (id, company_id, name) VALUES (900, $1, 'Other tenant worker')`, [otherCompanyId]);
    const crossCompany = await app.inject({
      method: 'GET',
      url: `/api/sync/bootstrap?companyId=${otherCompanyId}`,
      headers
    });
    expect(crossCompany.statusCode).toBe(403);
    expect(crossCompany.json().error.code).toBe('COMPANY_SCOPE_MISMATCH');

    const otherTenant = await app.inject({
      method: 'GET',
      url: '/api/sync/bootstrap',
      headers: {
        ...headers,
        authorization: `Bearer novda-test-token:${otherCompanyId}:other-device`
      }
    });
    expect(otherTenant.statusCode).toBe(200);
    expect(otherTenant.json().snapshot.company.companyId).toBe(otherCompanyId);
    expect(otherTenant.json().snapshot.workers.map((worker: any) => worker.id)).toEqual([900]);
    expect(otherTenant.json().snapshot.models).toEqual([]);
    expect(otherTenant.json().snapshot.parties).toEqual([]);
  });

  it('does not lose a real mutation committed after the bootstrap snapshot boundary', async () => {
    await addBaselineImportEvidence();
    let snapshotReached!: () => void;
    let releaseSnapshot!: () => void;
    const reached = new Promise<void>((resolve) => { snapshotReached = resolve; });
    const hold = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    snapshotTestHook = async () => {
      snapshotReached();
      await hold;
    };

    const bootstrapPromise = app.inject({ method: 'GET', url: '/api/sync/bootstrap', headers });
    await reached;
    const operationId = crypto.randomUUID();
    let mutationFinished = false;
    const mutationPromise = app.inject({
      method: 'POST',
      url: '/api/workers',
      headers,
      payload: { operationId, name: 'Worker created after bootstrap snapshot', staj: 0, role: 'Operator' }
    }).then((response: any) => {
      mutationFinished = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mutationFinished).toBe(false);

    releaseSnapshot();
    const bootstrapResponse = await bootstrapPromise;
    const snapshotCursor = bootstrapResponse.json().cursor;
    expect(bootstrapResponse.json().snapshot.workers).toHaveLength(201);
    const mutationResponse = await mutationPromise;
    expect(mutationResponse.statusCode).toBe(201);
    expect(mutationResponse.json().worker.id).toBe(202);

    const changes = await app.inject({
      method: 'GET',
      url: `/api/sync/changes?cursor=${encodeURIComponent(snapshotCursor)}`,
      headers
    });
    expect(changes.statusCode).toBe(200);
    expect(changes.json().items).toHaveLength(1);
    expect(changes.json().items[0]).toMatchObject({ entityType: 'worker', entityId: '202', changeType: 'INSERT' });
    const replay = await app.inject({
      method: 'GET',
      url: `/api/sync/changes?cursor=${encodeURIComponent(changes.json().nextCursor)}`,
      headers
    });
    expect(replay.json().items).toEqual([]);
  });
});
