import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildFastifyServer } from '../../../app.cjs';
import { getServerPool, resetServerDatabase, closeServerPool } from '../../../infrastructure/db.cjs';
const { createActivationRequest } = require('../../activation/activationRequests.cjs');
const { verifyFreshPostgres16TestEnvironment } = require('../../../../../scripts/verify/database/verify-pg16-test-env.cjs');

const ADMIN_ID = '274466315';
const SESSION_SECRET = 'admin-dashboard-postgres-test-secret-32-bytes';
const COMPANY_ID = 'comp_novda';
const WORKER_ID = 601;
const REQUEST_APPROVE_ID = '00000000-0000-4000-8000-000000000601';
const REQUEST_REJECT_ID = '00000000-0000-4000-8000-000000000602';
const TICKET_ID = '00000000-0000-4000-8000-000000000603';
const describePostgresIntegration = process.env.NOVDA_DISPOSABLE_PG === '1'
  && Boolean(process.env.NOVDA_PG_URL)
  && !process.env.DATABASE_URL
  ? describe
  : describe.skip;

function createSession(sub = ADMIN_ID) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { exp: now + 900, iat: now, nonce: '0123456789abcdefghijklmn', sub };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', SESSION_SECRET).update(encoded, 'ascii').digest('base64url');
  return { token: `${encoded}.${signature}`, expiresAt: claims.exp };
}

describePostgresIntegration(' Admin Dashboard PostgreSQL integration', () => {
  let app: any;
  let pool: any;
  let adminSession: ReturnType<typeof createSession>;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    await verifyFreshPostgres16TestEnvironment(process.env.NOVDA_PG_URL);
    pool = getServerPool();
    await resetServerDatabase();
    adminSession = createSession();
    fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/internal/admin/webapp/session')) {
        return new Response(JSON.stringify({
          success: true,
          session: adminSession,
          user: { id: Number(ADMIN_ID), first_name: 'Postgres Admin' }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: false, error: { code: 'INTERNAL_ROUTE_NOT_FOUND' } }), { status: 404 });
    });
    app = buildFastifyServer({
      pool,
      adminApiToken: 'admin-dashboard-service-test-token',
      adminWebAppSessionSecret: SESSION_SECRET,
      adminBotInternalUrl: 'http://novda-admin-bot:8080',
      adminWebAppPath: path.join(__dirname, '..', '..', '..', '..', 'webapps', 'admin'),
      fetchImpl
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeServerPool();
  });

  beforeEach(async () => {
    await resetServerDatabase();
    await pool.query(`INSERT INTO company_batch_settings (company_id, available_sizes_json, server_revision)
      VALUES ($1, '["XXS","S","M"]'::jsonb, 1)`, [COMPANY_ID]);
    await pool.query(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'database', 'migrations', 'deploy_activation_company_scope_migration.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'database', 'migrations', 'deploy_company_admin_scope_migration.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'database', 'migrations', 'deploy_worker_telegram_unbind_migration.sql'), 'utf8'));
    await pool.query(`
      INSERT INTO models (id, company_id, name, operations_json, status, server_revision)
      VALUES ('model-1', $1, 'Fixture Model', '[{"name":"Stitch","rate":9}]', 'ACTIVE', 1)
    `, [COMPANY_ID]);
    await pool.query(`
      INSERT INTO workers (id, company_id, name, status, staj, role, server_revision)
      VALUES ($1, $2, 'Fixture Worker', 'ACTIVE', 1, 'worker', 1)
    `, [WORKER_ID, COMPANY_ID]);
    await pool.query(`
      INSERT INTO periods (id, company_id, name, start_date, is_closed, status, server_revision)
      VALUES ('period-current', $1, 'September', '2026-09-01', 0, 'OPEN', 1)
    `, [COMPANY_ID]);
    await pool.query(`
      INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, model_name, status)
      VALUES ('party-1', $1, '35', '35', 'model-1', 'Fixture Model', 'ACTIVE')
    `, [COMPANY_ID]);
    await pool.query(`
      INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number, qty, status, submitted_at, period_id)
      VALUES ($1, $2, 'model-1', '35', 'party-1', 1, 10, 'CONFIRMED', '2026-09-10T12:00:00Z', 'period-current')
    `, [TICKET_ID, COMPANY_ID]);
    await pool.query(`
      INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, rate_snapshot, qty)
      VALUES ('entry-1', $1, $2, 'Stitch', $3, 5, 10)
    `, [TICKET_ID, COMPANY_ID, WORKER_ID]);
    await pool.query(`
      INSERT INTO worker_adjustments (id, company_id, worker_id, type, amount, source_id, provenance, created_at, period_id)
      VALUES ('adjustment-avans', $1, $2, 'AVANS', 4, 'source-avans', 'TEST', '2026-09-11T12:00:00Z', 'period-current'),
             ('adjustment-jarima', $1, $2, 'JARIMA', 3, 'source-jarima', 'TEST', '2026-09-11T12:00:00Z', 'period-current')
    `, [COMPANY_ID, WORKER_ID]);
    await pool.query(`
      INSERT INTO server_devices (device_id, company_id, token_hash, client_version, is_revoked)
      VALUES ('device-601', $1, $2, '2.0.0', FALSE)
    `, [COMPANY_ID, 'a'.repeat(64)]);
    await createActivationRequest(pool, {
      requestId: REQUEST_APPROVE_ID,
      requestToken: 'a'.repeat(64),
      machineId: '1111-2222-3333-4444',
      clientContext: { appVersion: '1.7.8', platform: 'win32' }
    });
    await createActivationRequest(pool, {
      requestId: REQUEST_REJECT_ID,
      requestToken: 'b'.repeat(64),
      machineId: '5555-6666-7777-8888',
      clientContext: { appVersion: '1.7.8', platform: 'win32' }
    });
    await pool.query(`
      INSERT INTO worker_telegram_bindings (telegram_id, company_id, worker_id, username)
      VALUES ('987654321', $1, $2, 'fixtureworker')
    `, [COMPANY_ID, WORKER_ID]);
    fetchImpl.mockClear();
  });

  it('counts printed party quantities and pattas independently of submitted work', async () => {
    await pool.query(`INSERT INTO parties
      (id, company_id, party_number, physical_party_number, model_id, patta_count, total_ish_soni, ish_soni, printed_at, created_at)
      VALUES
      ('print-1', $1, '41', '41', 'model-1', 10, 280, 280, '2026-11-13T03:31:19Z', '2026-11-14T00:00:00Z'),
      ('print-2', $1, '42', '42', 'model-1', 10, 140, 140, '2026-11-13T03:33:13Z', '2026-11-14T00:00:00Z'),
      ('print-3', $1, '43', '43', 'model-1', 10, 1040, 1040, '2026-11-13T03:59:58Z', '2026-11-14T00:00:00Z')`, [COMPANY_ID]);
    await pool.query(`UPDATE ticket_entries SET created_at = '2026-09-10T12:00:00Z' WHERE company_id = $1`, [COMPANY_ID]);

    const response = await app.inject({
      method: 'GET',
      url: `/internal/admin/daily-report?date=2026-11-13&companyId=${COMPANY_ID}`,
      headers: { 'x-novda-admin-token': 'admin-dashboard-service-test-token' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().report.cutProduction).toEqual({
      totalQty: 1460, totalTickets: 30,
      byModel: [{ modelId: 'model-1', modelName: 'Fixture Model', qty: 1460, ticketCount: 30 }]
    });
    expect(response.json().report.enteredProduction).toEqual({ totalQty: 0, totalEntries: 0, byModel: [] });
  });

  it('uses the Tashkent print day and legacy quantity fallback without counting other companies', async () => {
    await pool.query(`INSERT INTO parties
      (id, company_id, party_number, physical_party_number, model_id, patta_count, total_ish_soni, ish_soni, printed_at, created_at, status)
      VALUES
      ('start', $1, '41', '41', 'model-1', 2, 100, 999, '2026-11-12T19:00:00Z', NOW(), 'CLOSED'),
      ('end', $1, '42', '42', 'model-1', 3, 150, 999, '2026-11-13T18:59:59Z', NOW(), 'ACTIVE'),
      ('before', $1, '43', '43', 'model-1', 7, 700, 700, '2026-11-12T18:59:59Z', NOW(), 'ACTIVE'),
      ('after', $1, '44', '44', 'model-1', 8, 800, 800, '2026-11-13T19:00:00Z', NOW(), 'ACTIVE'),
      ('legacy', $1, '45', '45', 'model-1', 4, NULL, 200, NULL, '2026-11-13T08:00:00Z', 'ACTIVE'),
      ('zero', $1, '46', '46', 'model-1', 1, 0, 999, '2026-11-13T08:00:00Z', NOW(), 'ACTIVE'),
      ('other', 'other_company', '41', '41', 'model-1', 9, 900, 900, '2026-11-13T08:00:00Z', NOW(), 'ACTIVE')`, [COMPANY_ID]);

    const response = await app.inject({
      method: 'GET',
      url: `/internal/admin/daily-report?date=2026-11-13&companyId=${COMPANY_ID}`,
      headers: { 'x-novda-admin-token': 'admin-dashboard-service-test-token' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().report.cutProduction).toEqual({
      totalQty: 450, totalTickets: 10,
      byModel: [{ modelId: 'model-1', modelName: 'Fixture Model', qty: 450, ticketCount: 10 }]
    });
  });

  it('seeds the requested Telegram admin with a company-scoped grant', async () => {
    const grant = await pool.query(`SELECT telegram_id, company_id, is_active, assignment_source
      FROM activation_company_admins WHERE telegram_id = $1`, ['274466315']);
    expect(grant.rows).toEqual([{
      telegram_id: '274466315',
      company_id: COMPANY_ID,
      is_active: true,
      assignment_source: 'OWNER_BOOTSTRAP'
    }]);
  });

  it('unbounds the exact worker/Telegram pair through the company-admin bot route and records the actor', async () => {
    const previous = await pool.query(`SELECT COUNT(*)::int AS count FROM worker_telegram_binding_events
      WHERE company_id = $1 AND worker_id = $2 AND telegram_id = $3
        AND actor_telegram_id = $4 AND event_type = 'UNBOUND'`, [COMPANY_ID, WORKER_ID, '987654321', ADMIN_ID]);
    const response = await app.inject({
      method: 'POST',
      url: '/internal/admin/webapp/unbind-worker',
      headers: { 'x-novda-admin-token': 'admin-dashboard-service-test-token' },
      payload: {
        adminTelegramId: '274466315', companyId: COMPANY_ID,
        workerId: WORKER_ID, telegramId: '987654321'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().binding).toMatchObject({
      companyId: COMPANY_ID, workerId: WORKER_ID, telegramId: '987654321', unboundBy: '274466315'
    });
    expect((await pool.query(`SELECT telegram_id FROM worker_telegram_bindings
      WHERE company_id = $1 AND worker_id = $2`, [COMPANY_ID, WORKER_ID])).rows).toEqual([]);
    const events = await pool.query(`SELECT COUNT(*)::int AS count FROM worker_telegram_binding_events
      WHERE company_id = $1 AND worker_id = $2 AND telegram_id = $3
        AND actor_telegram_id = $4 AND event_type = 'UNBOUND'`, [COMPANY_ID, WORKER_ID, '987654321', ADMIN_ID]);
    expect(events.rows[0].count).toBe(previous.rows[0].count + 1);

    const crossCompany = await app.inject({
      method: 'POST',
      url: '/internal/admin/webapp/unbind-worker',
      headers: { 'x-novda-admin-token': 'admin-dashboard-service-test-token' },
      payload: {
        adminTelegramId: '274466315', companyId: 'other_company',
        workerId: WORKER_ID, telegramId: '8363499557'
      }
    });
    expect(crossCompany.statusCode).toBe(403);
    expect(crossCompany.json().error.code).toBe('ADMIN_COMPANY_SCOPE_REQUIRED');
  });

  async function exchangeSession() {
    const response = await app.inject({
      method: 'POST', url: '/api/admin/webapp/session', payload: { initData: 'test-signed-init-data' }
    });
    expect(response.statusCode).toBe(200);
    return response.json().session.token as string;
  }

  async function adminRequest(method: string, url: string, payload?: unknown, sessionToken?: string) {
    const token = sessionToken || await exchangeSession();
    return app.inject({
      method, url, headers: { authorization: `Bearer ${token}` }, payload
    });
  }

  it('seeds policy for the existing comp_novda scope with baseline provenance and restrictive reference', async () => {
    const [scope, policy, constraint] = await Promise.all([
      pool.query('SELECT to_jsonb(s) AS row FROM company_batch_settings s WHERE company_id = $1', [COMPANY_ID]),
      pool.query('SELECT company_id, company_name, allowed_roles, require_ticket_validation, is_active, updated_by_telegram_id, updated_by_source FROM activation_companies WHERE company_id = $1', [COMPANY_ID]),
      pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'activation_companies_company_scope_fk' AND convalidated = TRUE`)
    ]);

    expect(scope.rows).toHaveLength(1);
    expect(policy.rows).toEqual([{
      company_id: COMPANY_ID, company_name: COMPANY_ID,
      allowed_roles: ['admin', 'type', 'print'], require_ticket_validation: true,
      is_active: true, updated_by_telegram_id: null, updated_by_source: 'APPROVED_PRODUCTION_BASELINE'
    }]);
    expect(constraint.rows[0].definition).toContain('FOREIGN KEY (company_id) REFERENCES company_batch_settings(company_id) ON DELETE RESTRICT');
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM company_batch_settings WHERE company_id = $1', [COMPANY_ID])).rows[0].count).toBe(1);
    await expect(pool.query('DELETE FROM company_batch_settings WHERE company_id = $1', [COMPANY_ID]))
      .rejects.toMatchObject({ code: '23503' });
    expect((await pool.query('SELECT company_id FROM company_batch_settings WHERE company_id = $1', [COMPANY_ID])).rows)
      .toEqual([{ company_id: COMPANY_ID }]);
  });

  it('serves only the granted company and rejects other companies', async () => {
    const sessionToken = await exchangeSession();
    const [companies, workers, payroll, crossCompany, page] = await Promise.all([
      adminRequest('GET', '/api/admin/webapp/companies', undefined, sessionToken),
      adminRequest('GET', `/api/admin/webapp/workers?companyId=${COMPANY_ID}`, undefined, sessionToken),
      adminRequest('GET', `/api/admin/webapp/payroll?companyId=${COMPANY_ID}&periodId=period-current`, undefined, sessionToken),
      adminRequest('GET', '/api/admin/webapp/workers?companyId=other_company', undefined, sessionToken),
      app.inject({ method: 'GET', url: '/admin-app' })
    ]);
    expect(companies.statusCode).toBe(200);
    expect(companies.json().companies.map((company: any) => company.companyId)).toEqual([COMPANY_ID]);
    expect(workers.json().workers[0]).toMatchObject({ workerId: WORKER_ID, binding: { telegramId: '987654321' } });
    expect(JSON.stringify(workers.json())).not.toContain('pin_hash');
    expect(payroll.statusCode).toBe(200);
    // The open period uses the current model rate (9) rather than the historical snapshot (5).
    expect(payroll.json().payroll.workers[0]).toMatchObject({ gross: 90, avans: 4, jarima: 3, staj: 1, net: 82, pieces: 10 });
    expect(crossCompany.statusCode).toBe(403);
    expect(crossCompany.json().error.code).toBe('ADMIN_COMPANY_SCOPE_REQUIRED');
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
  });

  it('does not grant company access without an active company grant', async () => {
    const response = await adminRequest('GET', '/api/admin/webapp/workers', undefined, createSession('99887766').token);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ADMIN_TELEGRAM_ID_NOT_AUTHORIZED');
  });

  it('does not expose superadmin activation and company-policy writes or change their rows', async () => {
    const sessionToken = await exchangeSession();
    const before = await pool.query('SELECT status FROM activation_requests WHERE request_id = $1', [REQUEST_APPROVE_ID]);
    for (const [method, url] of [
      ['POST', `/api/admin/webapp/activations/${REQUEST_APPROVE_ID}/approve`],
      ['POST', `/api/admin/webapp/activations/${REQUEST_APPROVE_ID}/reject`],
      ['POST', `/api/admin/webapp/activations/${REQUEST_APPROVE_ID}/revoke`],
      ['POST', '/api/admin/webapp/companies'],
      ['PUT', `/api/admin/webapp/companies/${COMPANY_ID}/strict-mode`]
    ]) {
      const response = await adminRequest(method, url, {}, sessionToken);
      expect(response.statusCode).toBe(404);
    }
    expect((await pool.query('SELECT status FROM activation_requests WHERE request_id = $1', [REQUEST_APPROVE_ID])).rows).toEqual(before.rows);
  });
});
