import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fastify from 'fastify';

const { isInternalAdminBotUrl, registerAdminDashboardRoutes } = require('./adminDashboardRoutes.cjs');

const SECRET = 'test-session-secret-with-enough-entropy';
const ADMIN_ID = '1526974123';
const NOW = Math.floor(Date.now() / 1000);

function createSession(sub = ADMIN_ID) {
  const claims = { exp: NOW + 900, iat: NOW, nonce: '0123456789abcdefghijklmn', sub };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', SECRET).update(encoded, 'ascii').digest('base64url');
  return `${encoded}.${signature}`;
}

function createDashboard() {
  return {
    overview: vi.fn().mockResolvedValue({ workers: 201 }),
    listCompanies: vi.fn().mockResolvedValue([]),
    listDevices: vi.fn().mockResolvedValue({ registered: [], activationRequests: [] }),
    listWorkers: vi.fn().mockResolvedValue({ workers: [], limit: 100, offset: 0 }),
    getPayroll: vi.fn().mockResolvedValue({ period: null, workers: [] }),
    listActivations: vi.fn().mockResolvedValue([]),
    getActivationEvents: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue({ models: [] }),
    listParties: vi.fn().mockResolvedValue({ parties: [] }),
    listTickets: vi.fn().mockResolvedValue({ tickets: [] }),
    getBalances: vi.fn().mockResolvedValue({ companyId: 'comp_novda', facts: [] }),
    getSystemHealth: vi.fn().mockResolvedValue({ api: 'available', database: 'available' }),
    updateCompanyStrictMode: vi.fn().mockResolvedValue({ companyId: 'comp_novda', strictMode: false, policyRevision: 2 }),
    upsertCompany: vi.fn().mockResolvedValue({ company_id: 'comp_novda' }),
    approveActivation: vi.fn().mockResolvedValue({ status: 'APPROVED' }),
    rejectActivation: vi.fn().mockResolvedValue({ status: 'REJECTED' }),
    revokeActivation: vi.fn().mockResolvedValue({ status: 'REVOKED' })
  };
}

describe(' Admin WebApp routes', () => {
  let app: ReturnType<typeof fastify> | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function startApp(options: Record<string, unknown> = {}) {
    app = fastify();
    const dashboard = options.dashboard || createDashboard();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-admin-webapp-'));
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<meta name="novda-admin-webapp-version" content="test">');
    fs.writeFileSync(path.join(tempDir, 'admin.css'), 'body { color: black; }');
    fs.writeFileSync(path.join(tempDir, 'admin.js'), 'window.test = true;');
    registerAdminDashboardRoutes(app, {
      dashboard,
      sessionSecret: SECRET,
      allowedAdminIds: new Set([ADMIN_ID]),
      adminApiToken: 'internal-admin-service-token',
      adminBotInternalUrl: options.adminBotInternalUrl || 'http://novda-admin-bot:8080',
      adminWebAppPath: tempDir,
      fetchImpl: options.fetchImpl
    });
    return { app, dashboard };
  }

  it('allows only the private admin-bot service origin for auth and signing delegation', () => {
    expect(isInternalAdminBotUrl('http://novda-admin-bot:8080')).toBe(true);
    expect(isInternalAdminBotUrl('https://example.invalid')).toBe(false);
    expect(isInternalAdminBotUrl('http://127.0.0.1:8080')).toBe(false);
    expect(isInternalAdminBotUrl('http://novda-admin-bot:8080/path')).toBe(false);
  });

  it('fails closed on protected routes without an allowlisted WebApp session', async () => {
    const { app: server, dashboard } = startApp();
    await server.ready();

    const response = await server.inject({ method: 'GET', url: '/api/admin/webapp/overview' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('ADMIN_SESSION_REQUIRED');
    expect(dashboard.overview).not.toHaveBeenCalled();
  });

  it('exchanges Telegram initData with the private bot and returns only a verified session', async () => {
    const sessionToken = createSession();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      session: { token: sessionToken, expiresAt: NOW + 900 },
      user: { id: Number(ADMIN_ID), first_name: 'Admin' }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { app: server } = startApp({ fetchImpl });
    await server.ready();

    const response = await server.inject({
      method: 'POST',
      url: '/api/admin/webapp/session',
      payload: { initData: 'signed-telegram-init-data' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      session: { token: sessionToken, expiresAt: NOW + 900 },
      user: { id: ADMIN_ID, firstName: 'Admin', lastName: '', username: '' }
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://novda-admin-bot:8080/internal/admin/webapp/session',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-novda-admin-token': 'internal-admin-service-token' })
      })
    );
  });

  it('rejects a bot response with an invalid or non-allowlisted session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      session: { token: createSession('99887766'), expiresAt: NOW + 900 },
      user: { id: 99887766 }
    }), { status: 200 }));
    const { app: server } = startApp({ fetchImpl });
    await server.ready();

    const response = await server.inject({
      method: 'POST', url: '/api/admin/webapp/session', payload: { initData: 'signed-telegram-init-data' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ADMIN_SESSION_NOT_AUTHORIZED');
  });

  it('applies verified identity to reads and ignores caller-supplied admin IDs on writes', async () => {
    const { app: server, dashboard } = startApp();
    await server.ready();
    const authorization = `Bearer ${createSession()}`;

    const read = await server.inject({
      method: 'GET', url: '/api/admin/webapp/overview', headers: { authorization }
    });
    const write = await server.inject({
      method: 'POST', url: '/api/admin/webapp/companies', headers: { authorization },
      payload: { companyId: 'comp_novda', companyName: 'Novda', adminTelegramId: '99887766' }
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().overview.workers).toBe(201);
    expect(write.statusCode).toBe(200);
    expect(dashboard.upsertCompany).toHaveBeenCalledWith(ADMIN_ID, expect.objectContaining({ companyId: 'comp_novda' }));
    expect(dashboard.upsertCompany.mock.calls[0][0]).not.toBe('99887766');
  });

  it('passes only the verified session to activation signing operations', async () => {
    const { app: server, dashboard } = startApp();
    await server.ready();
    const sessionToken = createSession();
    const response = await server.inject({
      method: 'POST', url: '/api/admin/webapp/activations/00000000-0000-4000-8000-000000000001/approve',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { companyId: 'comp_novda', role: 'admin', adminTelegramId: '99887766' }
    });

    expect(response.statusCode).toBe(200);
    expect(dashboard.approveActivation).toHaveBeenCalledWith(ADMIN_ID, expect.objectContaining({
      requestId: '00000000-0000-4000-8000-000000000001', companyId: 'comp_novda', role: 'admin', sessionToken
    }));
  });

  it('protects new canonical read projections and does not invoke them for unauthorized requests', async () => {
    const { app: server, dashboard } = startApp();
    await server.ready();
    const denied = await server.inject({ method: 'GET', url: '/api/admin/webapp/parties' });
    const auth = { authorization: `Bearer ${createSession()}` };
    const [models, parties, tickets, balances, system] = await Promise.all([
      server.inject({ method: 'GET', url: '/api/admin/webapp/models', headers: auth }),
      server.inject({ method: 'GET', url: '/api/admin/webapp/parties?companyId=comp_novda', headers: auth }),
      server.inject({ method: 'GET', url: '/api/admin/webapp/tickets', headers: auth }),
      server.inject({ method: 'GET', url: '/api/admin/webapp/balances?companyId=comp_novda', headers: auth }),
      server.inject({ method: 'GET', url: '/api/admin/webapp/system', headers: auth })
    ]);
    expect(denied.statusCode).toBe(401);
    expect(dashboard.listParties).toHaveBeenCalledTimes(1);
    expect([models, parties, tickets, balances, system].map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(dashboard.getSystemHealth).toHaveBeenCalledOnce();
  });

  it('requires an authenticated admin for company strict-mode changes and takes company scope from the route', async () => {
    const { app: server, dashboard } = startApp();
    await server.ready();
    const denied = await server.inject({
      method: 'PUT', url: '/api/admin/webapp/companies/comp_novda/strict-mode', payload: { strictMode: false }
    });
    expect(denied.statusCode).toBe(401);
    expect(dashboard.updateCompanyStrictMode).not.toHaveBeenCalled();
    const sessionToken = createSession();
    const allowed = await server.inject({
      method: 'PUT', url: '/api/admin/webapp/companies/comp_novda/strict-mode',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { strictMode: false, companyId: 'other-company', adminTelegramId: '99887766' }
    });
    expect(allowed.statusCode).toBe(200);
    expect(dashboard.updateCompanyStrictMode).toHaveBeenCalledWith(ADMIN_ID, {
      strictMode: false, companyId: 'comp_novda', sessionToken
    });
  });

  it('serves the static app and assets with no-store security headers', async () => {
    const { app: server } = startApp();
    await server.ready();

    const page = await server.inject({ method: 'GET', url: '/admin-app' });
    const script = await server.inject({ method: 'GET', url: '/admin-app/admin.js' });

    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.body).toContain('novda-admin-webapp-version');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
  });
});
