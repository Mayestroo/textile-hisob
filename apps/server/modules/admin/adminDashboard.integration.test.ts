import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, generateKeyPairSync, sign } from 'crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildFastifyServer } from '../../app.cjs';
import { getServerPool, resetServerDatabase, closeServerPool } from '../../infrastructure/db.cjs';
const { canonicalActivationPayload } = require('../activation/licenseActivation.cjs');
const { createActivationRequest } = require('../activation/activationRequests.cjs');
const { verifyFreshPostgres16TestEnvironment } = require('../../../../scripts/verify/verify-pg16-test-env.cjs');

const ADMIN_ID = '1526974123';
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
  let signerClient: ReturnType<typeof vi.fn>;
  let signer: ReturnType<typeof generateKeyPairSync>;

  beforeAll(async () => {
    await verifyFreshPostgres16TestEnvironment(process.env.NOVDA_PG_URL);
    pool = getServerPool();
    await resetServerDatabase();
    signer = generateKeyPairSync('ed25519');
    adminSession = createSession();
    signerClient = vi.fn(async ({ sessionToken, payload }: { sessionToken: string; payload: Record<string, unknown> }) => {
      if (!sessionToken) throw new Error('SESSION_REQUIRED');
      return {
        telegramId: ADMIN_ID,
        signedActivation: {
          payload,
          signature: sign(null, Buffer.from(canonicalActivationPayload(payload)), signer.privateKey).toString('base64')
        }
      };
    });
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
      allowedAdminIds: new Set([ADMIN_ID]),
      adminWebAppSessionSecret: SESSION_SECRET,
      adminBotInternalUrl: 'http://novda-admin-bot:8080',
      adminWebAppPath: path.join(__dirname, '..', '..', 'static', 'admin-webapp'),
      fetchImpl,
      adminSignerClient: signerClient,
      licensePublicKey: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
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
    await pool.query(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'migrations', 'deploy_activation_company_scope_migration.sql'), 'utf8'));
    await pool.query(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'migrations', 'deploy_company_admin_scope_migration.sql'), 'utf8'));
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
    signerClient.mockClear();
  });

  it('seeds the requested Telegram admin as comp_novda-scoped without global allowlisting', async () => {
    const grant = await pool.query(`SELECT telegram_id, company_id, is_active, assignment_source
      FROM activation_company_admins WHERE telegram_id = $1`, ['274466315']);
    expect(grant.rows).toEqual([{
      telegram_id: '274466315',
      company_id: COMPANY_ID,
      is_active: true,
      assignment_source: 'OWNER_BOOTSTRAP'
    }]);
    expect(new Set([ADMIN_ID]).has('274466315')).toBe(false);
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

  it('serves all dashboard projections from PostgreSQL and excludes credential material', async () => {
    const sessionToken = await exchangeSession();
    const scopeBefore = await pool.query('SELECT to_jsonb(s) AS row FROM company_batch_settings s WHERE company_id = $1', [COMPANY_ID]);
    const companyWrite = await adminRequest('POST', '/api/admin/webapp/companies', {
      companyId: COMPANY_ID,
      companyName: 'Fixture Company',
      allowedRoles: ['admin', 'type', 'print'],
      requireTicketValidation: true,
      adminTelegramId: '99887766'
    }, sessionToken);
    expect(companyWrite.statusCode).toBe(200);
    expect(companyWrite.json().company).toMatchObject({
      company_id: COMPANY_ID,
      updated_by_telegram_id: ADMIN_ID,
      updated_by_source: 'TELEGRAM_ADMIN'
    });
    const [scopeAfter, canonicalCompanyTable] = await Promise.all([
      pool.query('SELECT to_jsonb(s) AS row FROM company_batch_settings s WHERE company_id = $1', [COMPANY_ID]),
      pool.query("SELECT to_regclass('public.companies') AS relation")
    ]);
    expect(scopeAfter.rows).toEqual(scopeBefore.rows);
    expect(canonicalCompanyTable.rows[0].relation).toBeNull();

    const [overview, companies, devices, workers, payroll, activations, events, page] = await Promise.all([
      adminRequest('GET', '/api/admin/webapp/overview', undefined, sessionToken),
      adminRequest('GET', '/api/admin/webapp/companies', undefined, sessionToken),
      adminRequest('GET', '/api/admin/webapp/devices', undefined, sessionToken),
      adminRequest('GET', `/api/admin/webapp/workers?companyId=${COMPANY_ID}`, undefined, sessionToken),
      adminRequest('GET', `/api/admin/webapp/payroll?companyId=${COMPANY_ID}&periodId=period-current`, undefined, sessionToken),
      adminRequest('GET', '/api/admin/webapp/activations?status=PENDING', undefined, sessionToken),
      adminRequest('GET', `/api/admin/webapp/activations/${REQUEST_APPROVE_ID}/events`, undefined, sessionToken),
      adminRequest('GET', '/admin-app', undefined, sessionToken)
    ]);

    expect(overview.json().overview).toMatchObject({ companies: 1, workers: 1, models: 1, parties: 1, devices: 1, pendingActivations: 2 });
    expect(companies.json().companies[0]).toMatchObject({ companyId: COMPANY_ID, companyName: 'Fixture Company', activationConfigured: true });
    expect(devices.json().devices.registered).toHaveLength(1);
    expect(devices.json().devices.activationRequests).toHaveLength(2);
    expect(workers.json().workers[0]).toMatchObject({ workerId: WORKER_ID, binding: { telegramId: '987654321' } });
    expect(JSON.stringify(workers.json())).not.toContain('pin_hash');
    expect(payroll.json().payroll.workers[0]).toMatchObject({ gross: 50, avans: 4, jarima: 3, staj: 1, net: 42, pieces: 10 });
    expect(activations.json().activations).toHaveLength(2);
    expect(JSON.stringify(activations.json())).not.toContain('request_token_hash');
    expect(events.json().events).toEqual([]);
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
  });

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

  it('persists strict/free mode by company, audits each transition, and returns durable refetched state', async () => {
    await pool.query(`INSERT INTO company_batch_settings (company_id, available_sizes_json, server_revision) VALUES ('other_company', '[]', 1)`);
    const otherPolicy = await adminRequest('POST', '/api/admin/webapp/companies', {
      companyId: 'other_company', companyName: 'Other Company', allowedRoles: ['admin']
    });
    expect(otherPolicy.statusCode).toBe(200);

    const off = await adminRequest('PUT', `/api/admin/webapp/companies/${COMPANY_ID}/strict-mode`, { strictMode: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().mode).toMatchObject({ companyId: COMPANY_ID, strictMode: false, policyRevision: 2 });
    const afterOff = await adminRequest('GET', '/api/admin/webapp/companies');
    expect(afterOff.json().companies.find((item: any) => item.companyId === COMPANY_ID)).toMatchObject({ strictMode: false, policyRevision: 2 });
    expect(afterOff.json().companies.find((item: any) => item.companyId === 'other_company')).toMatchObject({ strictMode: true, policyRevision: 1 });

    const on = await adminRequest('PUT', `/api/admin/webapp/companies/${COMPANY_ID}/strict-mode`, { strictMode: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().mode).toMatchObject({ strictMode: true, policyRevision: 3 });
    const [stored, events] = await Promise.all([
      pool.query('SELECT require_ticket_validation, policy_revision, updated_by_telegram_id, updated_by_source FROM activation_companies WHERE company_id = $1', [COMPANY_ID]),
      pool.query('SELECT actor_telegram_id, previous_require_ticket_validation, require_ticket_validation, policy_revision FROM activation_policy_events WHERE company_id = $1 ORDER BY event_id', [COMPANY_ID])
    ]);
    expect(stored.rows[0]).toMatchObject({ require_ticket_validation: true, policy_revision: 3, updated_by_telegram_id: ADMIN_ID, updated_by_source: 'TELEGRAM_ADMIN' });
    expect(events.rows).toEqual([
      { actor_telegram_id: ADMIN_ID, previous_require_ticket_validation: true, require_ticket_validation: false, policy_revision: 2 },
      { actor_telegram_id: ADMIN_ID, previous_require_ticket_validation: false, require_ticket_validation: true, policy_revision: 3 }
    ]);
  });

  it('propagates a strict/free change into existing approved device activations', async () => {
    const approved = await adminRequest('POST', `/api/admin/webapp/activations/${REQUEST_APPROVE_ID}/approve`, {
      companyId: COMPANY_ID, role: 'admin'
    });
    expect(approved.statusCode).toBe(200);
    const before = await pool.query('SELECT signed_payload, signature FROM activation_requests WHERE request_id = $1', [REQUEST_APPROVE_ID]);
    expect(before.rows[0].signed_payload.requireTicketValidation).toBe(true);

    const changed = await adminRequest('PUT', `/api/admin/webapp/companies/${COMPANY_ID}/strict-mode`, { strictMode: false });
    expect(changed.statusCode).toBe(200);
    const persisted = await pool.query('SELECT signed_payload, signature FROM activation_requests WHERE request_id = $1', [REQUEST_APPROVE_ID]);
    expect(persisted.rows[0].signed_payload.requireTicketValidation).toBe(false);
    expect(persisted.rows[0].signature).not.toBe(before.rows[0].signature);
  });

  it('reapplies an already-free company policy to stale approved activations for device polling', async () => {
    const approved = await adminRequest('POST', `/api/admin/webapp/activations/${REQUEST_APPROVE_ID}/approve`, {
      companyId: COMPANY_ID, role: 'admin'
    });
    expect(approved.statusCode).toBe(200);
    await pool.query('UPDATE activation_companies SET require_ticket_validation = FALSE WHERE company_id = $1', [COMPANY_ID]);

    const reapplied = await adminRequest('PUT', `/api/admin/webapp/companies/${COMPANY_ID}/strict-mode`, { strictMode: false });
    expect(reapplied.statusCode).toBe(200);
    expect(reapplied.json().mode).toMatchObject({ strictMode: false, policyRevision: 1, synchronizedDevices: 1 });

    const devicePoll = await app.inject({
      method: 'GET', url: `/api/activation/requests/${REQUEST_APPROVE_ID}`,
      headers: { 'x-activation-request-token': 'a'.repeat(64), 'x-machine-id': '1111-2222-3333-4444' }
    });
    expect(devicePoll.json().request.activation.payload.requireTicketValidation).toBe(false);
    expect((await pool.query('SELECT synchronized_device_count FROM activation_policy_events WHERE company_id = $1', [COMPANY_ID])).rows)
      .toEqual([{ synchronized_device_count: 1 }]);
  });

  it('rejects policy creation for an unknown scope and invalid roles without creating business rows', async () => {
    const unknown = await adminRequest('POST', '/api/admin/webapp/companies', {
      companyId: 'company-that-does-not-exist', companyName: 'Unknown', allowedRoles: ['admin']
    });
    const invalidRole = await adminRequest('POST', '/api/admin/webapp/companies', {
      companyId: COMPANY_ID, companyName: COMPANY_ID, allowedRoles: ['owner']
    });

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('CANONICAL_COMPANY_NOT_FOUND');
    expect(invalidRole.statusCode).toBe(400);
    expect(invalidRole.json().error.code).toBe('INVALID_ACTIVATION_ROLES');
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM company_batch_settings')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM workers WHERE company_id = $1', [COMPANY_ID])).rows[0].count).toBe(1);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM activation_companies WHERE company_id = $1', [COMPANY_ID])).rows[0].count).toBe(1);
  });

  it('does not sign or approve a request against an inactive activation policy', async () => {
    await pool.query('UPDATE activation_companies SET is_active = FALSE WHERE company_id = $1', [COMPANY_ID]);

    const response = await adminRequest('POST', `/api/admin/webapp/activations/${REQUEST_APPROVE_ID}/approve`, {
      companyId: COMPANY_ID, role: 'admin'
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ACTIVATION_ROLE_NOT_ALLOWED');
    expect(signerClient).not.toHaveBeenCalled();
    expect((await pool.query('SELECT status FROM activation_requests WHERE request_id = $1', [REQUEST_APPROVE_ID])).rows[0].status).toBe('PENDING');
  });

  it('persists activation approval, rejection, revocation, and actor audit rows through PostgreSQL', async () => {
    const sessionToken = await exchangeSession();
    const companyWrite = await adminRequest('POST', '/api/admin/webapp/companies', {
      companyId: COMPANY_ID, companyName: 'Fixture Company', allowedRoles: ['admin'], requireTicketValidation: true
    }, sessionToken);
    expect(companyWrite.statusCode).toBe(200);

    const approved = await adminRequest('POST', `/api/admin/webapp/activations/${REQUEST_APPROVE_ID}/approve`, {
      companyId: COMPANY_ID, role: 'admin', adminTelegramId: '99887766'
    }, sessionToken);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().activation.status).toBe('APPROVED');

    const rejected = await adminRequest('POST', `/api/admin/webapp/activations/${REQUEST_REJECT_ID}/reject`, {
      reason: 'Test rejection', adminTelegramId: '99887766'
    }, sessionToken);
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().activation.status).toBe('REJECTED');

    const revoked = await adminRequest('POST', `/api/admin/webapp/activations/${REQUEST_APPROVE_ID}/revoke`, {}, sessionToken);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().activation.status).toBe('REVOKED');

    const rows = await pool.query(`
      SELECT event_type, actor_telegram_id FROM activation_events WHERE request_id = $1 ORDER BY event_id
    `, [REQUEST_APPROVE_ID]);
    expect(rows.rows).toEqual([
      { event_type: 'APPROVED', actor_telegram_id: ADMIN_ID },
      { event_type: 'REVOKED', actor_telegram_id: ADMIN_ID }
    ]);
    const activationRow = await pool.query('SELECT status, revoked_by_telegram_id FROM activation_requests WHERE request_id = $1', [REQUEST_APPROVE_ID]);
    expect(activationRow.rows[0]).toMatchObject({ status: 'REVOKED', revoked_by_telegram_id: ADMIN_ID });
  });

  it('rejects a signed session for an unauthorized Telegram ID without changing PostgreSQL', async () => {
    const before = await pool.query('SELECT COUNT(*)::INT AS count FROM activation_companies');
    const forbidden = await adminRequest('POST', '/api/admin/webapp/companies', {
      companyId: COMPANY_ID, companyName: 'Unauthorized', allowedRoles: ['admin']
    }, createSession('99887766').token);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('ADMIN_SESSION_NOT_AUTHORIZED');
    const after = await pool.query('SELECT COUNT(*)::INT AS count FROM activation_companies');
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
