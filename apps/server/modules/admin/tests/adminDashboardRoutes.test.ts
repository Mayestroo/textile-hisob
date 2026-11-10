import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fastify from 'fastify';

const { isInternalAdminBotUrl, isInternalWorkerBotHealthUrl, registerAdminDashboardRoutes } = require('../adminDashboardRoutes.cjs');
const { createAdminDashboardService } = require('../adminDashboard.cjs');

const SECRET = 'test-session-secret-with-enough-entropy';
const ADMIN_ID = '274466315';
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
    listPeriods: vi.fn().mockResolvedValue([]),
    closePeriod: vi.fn().mockResolvedValue({ status: 'APPLIED', serverRevision: 2 }),
    updateModelRates: vi.fn().mockResolvedValue({ status: 'APPLIED', serverRevision: 3 }),
    listCompanyAdmins: vi.fn().mockResolvedValue([]),
    setCompanyAdmin: vi.fn().mockResolvedValue({ companyId: 'comp_novda', telegramId: '274466315', isActive: true }),
    updateWorker: vi.fn().mockResolvedValue({ serverRevision: 2 }),
    setWorkerStatus: vi.fn().mockResolvedValue({ serverRevision: 2 }),
    getPayroll: vi.fn().mockResolvedValue({ period: null, workers: [] }),
    listActivations: vi.fn().mockResolvedValue([]),
    getActivationEvents: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue({ models: [] }),
    listParties: vi.fn().mockResolvedValue({ parties: [] }),
    listTickets: vi.fn().mockResolvedValue({ tickets: [] }),
    dailyProductionReport: vi.fn().mockResolvedValue({ date: '2026-11-10', report: { companyId: 'comp_novda' }, reports: [{ companyId: 'comp_novda' }] }),
    getBalances: vi.fn().mockResolvedValue({ companyId: 'comp_novda', facts: [] }),
    getSystemHealth: vi.fn().mockResolvedValue({ api: 'available', database: 'available' }),
    updateCompanyStrictMode: vi.fn().mockResolvedValue({ companyId: 'comp_novda', strictMode: false, policyRevision: 2 }),
    upsertCompany: vi.fn().mockResolvedValue({ company_id: 'comp_novda' }),
    unbindWorkerTelegram: vi.fn().mockResolvedValue({ companyId: 'comp_novda', workerId: 180, telegramId: '8363499557' }),
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
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<meta name="novda-admin-webapp-version" content="test"><script src="/admin-app/financial-intent.js" defer></script>');
    fs.mkdirSync(path.join(tempDir, 'styles'));
    fs.mkdirSync(path.join(tempDir, 'scripts'));
    fs.writeFileSync(path.join(tempDir, 'styles', 'admin.css'), 'body { color: black; }');
    fs.writeFileSync(path.join(tempDir, 'styles', 'company-admin.css'), '.company-app { color: green; }');
    fs.writeFileSync(path.join(tempDir, 'scripts', 'admin.js'), 'window.test = true;');
    fs.copyFileSync(path.join(__dirname, '..', '..', '..', '..', 'webapps', 'admin', 'scripts', 'financial-intent.js'), path.join(tempDir, 'scripts', 'financial-intent.js'));
    registerAdminDashboardRoutes(app, {
      dashboard,
      pool: options.pool || { query: async (_sql: string, params: string[]) => ({ rows: params[0] === ADMIN_ID ? [{ company_id: 'comp_novda' }] : [] }) },
      sessionSecret: SECRET,
      adminApiToken: 'internal-admin-service-token',
      adminBotInternalUrl: options.adminBotInternalUrl || 'http://novda-admin-bot:8080',
      workerBotHealthUrl: options.workerBotHealthUrl,
      adminWebAppPath: tempDir,
      fetchImpl: options.fetchImpl
    });
    return { app, dashboard };
  }

  it('allows only the private admin-bot service origin for session delegation', () => {
    expect(isInternalAdminBotUrl('http://novda-admin-bot:8080')).toBe(true);
    expect(isInternalAdminBotUrl('https://example.invalid')).toBe(false);
    expect(isInternalAdminBotUrl('http://127.0.0.1:8080')).toBe(false);
    expect(isInternalAdminBotUrl('http://novda-admin-bot:8080/path')).toBe(false);
  });

  it('fails closed on protected routes without a valid WebApp session', async () => {
    const { app: server, dashboard } = startApp();
    await server.ready();

    const response = await server.inject({ method: 'GET', url: '/api/admin/webapp/overview' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('ADMIN_SESSION_REQUIRED');
    expect(dashboard.overview).not.toHaveBeenCalled();
  });

  it('does not grant company access without an active company-admin grant', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    const { app: server, dashboard } = startApp({ pool });
    const response = await server.inject({
      method: 'GET', url: '/api/admin/webapp/overview',
      headers: { authorization: `Bearer ${createSession()}` }
    });
    expect(response.statusCode).toBe(403);
    expect(dashboard.overview).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('activation_company_admins'), [ADMIN_ID]);
  });

  it.each([
    ['overview', 'overview'], ['devices', 'listDevices'], ['workers', 'listWorkers'],
    ['payroll', 'getPayroll'], ['models', 'listModels'],
    ['parties', 'listParties'], ['tickets', 'listTickets'], ['balances', 'getBalances']
  ])('passes authorized company B through %s and rejects missing/unauthorized scope', async (route, method) => {
    const dashboard = createDashboard();
    const pool = { query: vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql).toContain('FROM activation_company_admins');
      expect(sql).toContain('is_active = TRUE');
      expect(params).toEqual(['123456789']);
      return { rows: [{ company_id: 'company-a' }, { company_id: 'company-b' }] };
    }) };
    const { app: server } = startApp({ dashboard, pool });
    const headers = { authorization: `Bearer ${createSession('123456789')}` };
    const service = dashboard[method as keyof typeof dashboard];
    for (const [query, error] of [['', 'ADMIN_COMPANY_SELECTION_REQUIRED'], ['?companyId=company-c', 'ADMIN_COMPANY_SCOPE_REQUIRED']]) {
      const denied = await server.inject({ method: 'GET', url: `/api/admin/webapp/${route}${query}`, headers });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe(error);
      expect(service).not.toHaveBeenCalled();
    }
    const allowed = await server.inject({ method: 'GET', url: `/api/admin/webapp/${route}?companyId=%20company-b%20&periodId=period-b&limit=12`, headers });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().success).toBe(true);
    expect(service).toHaveBeenCalledExactlyOnceWith({ companyId: 'company-b', periodId: 'period-b', limit: '12' });
  });

  it('carries selected B through the real worker projection SQL and response mapper (query double, not PG)', async () => {
    const pool = { query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM activation_company_admins')) {
        expect(params).toEqual(['123456789']);
        return { rows: [{ company_id: 'company-a' }, { company_id: 'company-b' }] };
      }
      expect(sql).toContain('FROM workers w');
      expect(sql).toContain('WHERE ($1::VARCHAR IS NULL OR w.company_id = $1)');
      expect(params).toEqual(['company-b', '%Fixture%', 12, 0, true]);
      return { rows: [{ worker_id: 27, company_id: 'company-b', worker_name: 'Fixture B', status: 'ACTIVE',
        total_count: '1', telegram_id: '987654321', username: 'fixture-b', staj: '0', server_revision: 3 }] };
    }) };
    const dashboard = createAdminDashboardService({ pool });
    const { app: server } = startApp({ pool, dashboard });
    const response = await server.inject({ method: 'GET',
      url: '/api/admin/webapp/workers?companyId=company-b&search=Fixture&limit=12&boundOnly=true',
      headers: { authorization: `Bearer ${createSession('123456789')}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, total: 1, limit: 12, offset: 0,
      workers: [{ companyId: 'company-b', workerId: 27, name: 'Fixture B', binding: { username: 'fixture-b' } }] });
    expect(pool.query).toHaveBeenCalledTimes(2);
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
      user: { id: ADMIN_ID, firstName: 'Admin', lastName: '', username: '' },
      access: { companyIds: ['comp_novda'] }
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
    expect(response.json().error.code).toBe('ADMIN_TELEGRAM_ID_NOT_AUTHORIZED');
  });

  it('applies verified identity to reads and ignores caller-supplied admin IDs on writes', async () => {
    const { app: server, dashboard } = startApp();
    await server.ready();
    const authorization = `Bearer ${createSession()}`;

    const read = await server.inject({
      method: 'GET', url: '/api/admin/webapp/overview', headers: { authorization }
    });
    const write = await server.inject({
      method: 'PUT', url: '/api/admin/webapp/companies/comp_novda/workers/12', headers: { authorization },
      payload: { name: 'Fixture', adminTelegramId: '99887766' }
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().overview.workers).toBe(201);
    expect(write.statusCode).toBe(200);
    expect(dashboard.updateWorker).toHaveBeenCalledWith(ADMIN_ID, expect.objectContaining({ companyId: 'comp_novda' }));
    expect(dashboard.updateWorker.mock.calls[0][0]).not.toBe('99887766');
  });

  it('does not expose retired activation-management routes in the company-admin API', async () => {
    const { app: server, dashboard } = startApp();
    await server.ready();
    const sessionToken = createSession();
    const headers = { authorization: `Bearer ${sessionToken}` };
    for (const action of ['approve', 'reject', 'revoke']) {
      const response = await server.inject({ method: 'POST',
        url: `/api/admin/webapp/activations/00000000-0000-4000-8000-000000000001/${action}`,
        headers, payload: { companyId: 'comp_novda', role: 'admin' } });
      expect(response.statusCode).toBe(404);
    }
    expect((await server.inject({ method: 'GET', url: '/api/admin/webapp/companies/comp_novda/admins', headers })).statusCode).toBe(404);
    expect((await server.inject({ method: 'PUT', url: '/api/admin/webapp/companies/comp_novda/admins/123', headers, payload: { isActive: true } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/api/admin/webapp/activations', headers })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/api/admin/webapp/activations/123/events', headers })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/api/admin/webapp/companies', headers, payload: {} })).statusCode).toBe(404);
    expect((await server.inject({ method: 'PUT', url: '/api/admin/webapp/companies/comp_novda/strict-mode', headers, payload: {} })).statusCode).toBe(404);
    expect(dashboard.approveActivation).not.toHaveBeenCalled();
    expect(dashboard.rejectActivation).not.toHaveBeenCalled();
    expect(dashboard.revokeActivation).not.toHaveBeenCalled();
    expect(dashboard.setCompanyAdmin).not.toHaveBeenCalled();
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
      server.inject({ method: 'GET', url: '/api/admin/webapp/balances?companyId=comp_novda&periodId=period-october', headers: auth }),
      server.inject({ method: 'GET', url: '/api/admin/webapp/system', headers: auth })
    ]);
    expect(denied.statusCode).toBe(401);
    expect(dashboard.listParties).toHaveBeenCalledTimes(1);
    expect([models, parties, tickets, balances, system].map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 404]);
    expect(dashboard.getSystemHealth).not.toHaveBeenCalled();
    expect(dashboard.getBalances).toHaveBeenCalledWith({ companyId: 'comp_novda', periodId: 'period-october' });
  });

  it('accepts only the fixed internal worker-bot health service URL', () => {
    expect(isInternalWorkerBotHealthUrl('http://novda-worker-bot:8081/health')).toBe(true);
    expect(isInternalWorkerBotHealthUrl('http://127.0.0.1:8081/health')).toBe(false);
    expect(isInternalWorkerBotHealthUrl('http://novda-worker-bot:8081/health?token=x')).toBe(false);
    expect(isInternalWorkerBotHealthUrl('https://novda-worker-bot:8081/health')).toBe(false);
  });

  it('exposes period close and model-rate mutations only through the authenticated company-scoped routes', async () => {
    const { app: server, dashboard } = startApp();
    await server.ready();
    const denied = await server.inject({ method: 'POST', url: '/api/admin/webapp/companies/comp_novda/periods/p1/close' });
    expect(denied.statusCode).toBe(401);
    const headers = { authorization: `Bearer ${createSession()}` };
    const [closed, rates] = await Promise.all([
      server.inject({ method: 'POST', url: '/api/admin/webapp/companies/comp_novda/periods/p1/close', headers, payload: { companyId: 'spoofed', endDate: '2026-10-31' } }),
      server.inject({ method: 'PUT', url: '/api/admin/webapp/companies/comp_novda/models/m1/rates', headers, payload: { companyId: 'spoofed', operations: [] } })
    ]);
    expect([closed.statusCode, rates.statusCode]).toEqual([200, 200]);
    expect(dashboard.closePeriod).toHaveBeenCalledWith(ADMIN_ID, expect.objectContaining({ companyId: 'comp_novda', periodId: 'p1' }));
    expect(dashboard.updateModelRates).toHaveBeenCalledWith(ADMIN_ID, expect.objectContaining({ companyId: 'comp_novda', modelId: 'm1' }));
    expect(dashboard.closePeriod.mock.calls[0][1].companyId).not.toBe('spoofed');
    expect(dashboard.updateModelRates.mock.calls[0][1].companyId).not.toBe('spoofed');
  });

  it('reports worker-bot health as server-confirmed online, offline, or unconfigured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', service: 'novda-worker-bot' }) });
    const { app: server } = startApp({ fetchImpl, workerBotHealthUrl: 'http://novda-worker-bot:8081/health' });
    await server.ready();
    const response = await server.inject({ method: 'GET', url: '/api/admin/webapp/worker-bot-status', headers: { authorization: `Bearer ${createSession()}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('online');
    expect(fetchImpl).toHaveBeenCalledWith('http://novda-worker-bot:8081/health', expect.objectContaining({ method: 'GET', cache: 'no-store' }));

    const unconfigured = startApp();
    await unconfigured.app.ready();
    const unknown = await unconfigured.app.inject({ method: 'GET', url: '/api/admin/webapp/worker-bot-status', headers: { authorization: `Bearer ${createSession()}` } });
    expect(unknown.json().status).toBe('unconfigured');
  });

  it('limits a company-scoped admin to its granted company across dashboard and device reads', async () => {
    const dashboard = createDashboard();
    dashboard.listCompanies.mockResolvedValue([
      { companyId: 'comp_novda', companyName: 'Novda' },
      { companyId: 'other_company', companyName: 'Other' }
    ]);
    const pool = {
      query: vi.fn(async (_sql: string, params: unknown[]) => ({
        rows: params[0] === '274466315' ? [{ company_id: 'comp_novda' }] : []
      }))
    };
    const { app: server } = startApp({ dashboard, pool });
    await server.ready();
    const auth = { authorization: `Bearer ${createSession('274466315')}` };

    const companies = await server.inject({ method: 'GET', url: '/api/admin/webapp/companies', headers: auth });
    expect(companies.statusCode).toBe(200);
    expect(companies.json().companies).toEqual([{ companyId: 'comp_novda', companyName: 'Novda' }]);

    const workers = await server.inject({ method: 'GET', url: '/api/admin/webapp/workers', headers: auth });
    expect(workers.statusCode).toBe(200);
    expect(dashboard.listWorkers).toHaveBeenCalledWith({ companyId: 'comp_novda' });

    const crossCompany = await server.inject({
      method: 'GET', url: '/api/admin/webapp/workers?companyId=other_company', headers: auth
    });
    expect(crossCompany.statusCode).toBe(403);
    expect(crossCompany.json().error.code).toBe('ADMIN_COMPANY_SCOPE_REQUIRED');

    const overview = await server.inject({ method: 'GET', url: '/api/admin/webapp/overview', headers: auth });
    expect(overview.statusCode).toBe(200);
    expect(dashboard.overview).toHaveBeenCalledWith({ companyId: 'comp_novda' });

    const devices = await server.inject({ method: 'GET', url: '/api/admin/webapp/devices', headers: auth });
    expect(devices.statusCode).toBe(200);
    expect(dashboard.listDevices).toHaveBeenCalledWith({ companyId: 'comp_novda' });

    const activations = await server.inject({ method: 'GET', url: '/api/admin/webapp/activations', headers: auth });
    expect(activations.statusCode).toBe(404);
    expect(dashboard.listActivations).not.toHaveBeenCalled();

    const globalSystem = await server.inject({ method: 'GET', url: '/api/admin/webapp/system', headers: auth });
    expect(globalSystem.statusCode).toBe(404);
  });

  it('authorizes the internal bot webapp exchange from database company grants', async () => {
    const pool = {
      query: vi.fn(async (_sql: string, params: unknown[]) => ({
        rows: params[0] === '274466315' ? [{ company_id: 'comp_novda' }] : []
      }))
    };
    const { app: server } = startApp({ pool });
    await server.ready();

    const allowed = await server.inject({
      method: 'POST', url: '/internal/admin/webapp/authorize',
      headers: { 'x-novda-admin-token': 'internal-admin-service-token' },
      payload: { telegramId: '274466315', companyId: 'comp_novda' }
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().access).toEqual({ companyIds: ['comp_novda'] });

    const denied = await server.inject({
      method: 'POST', url: '/internal/admin/webapp/authorize',
      headers: { 'x-novda-admin-token': 'internal-admin-service-token' },
      payload: { telegramId: '274466315', companyId: 'other_company' }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('ADMIN_COMPANY_SCOPE_REQUIRED');
  });

  it('routes service-authenticated worker unbind commands through the authorized admin service', async () => {
    const dashboard = createDashboard();
    const { app: server } = startApp({ dashboard });
    await server.ready();

    const response = await server.inject({
      method: 'POST', url: '/internal/admin/webapp/unbind-worker',
      headers: { 'x-novda-admin-token': 'internal-admin-service-token' },
      payload: {
        adminTelegramId: '274466315', companyId: 'comp_novda', workerId: 180, telegramId: '8363499557'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(dashboard.unbindWorkerTelegram).toHaveBeenCalledWith('274466315', {
      adminTelegramId: '274466315', companyId: 'comp_novda', workerId: 180, telegramId: '8363499557'
    });
    expect(response.json().binding).toMatchObject({ companyId: 'comp_novda', workerId: 180 });
  });

  it('routes scoped worker edits and binding unbinds through the authenticated company scope', async () => {
    const dashboard = createDashboard();
    const pool = { query: vi.fn(async (_sql: string, params: unknown[]) => ({
      rows: params[0] === '274466315' ? [{ company_id: 'comp_novda' }] : []
    })) };
    const { app: server } = startApp({ dashboard, pool });
    await server.ready();
    const headers = { authorization: `Bearer ${createSession('274466315')}` };

    const edit = await server.inject({
      method: 'PUT', url: '/api/admin/webapp/companies/comp_novda/workers/180', headers,
      payload: { companyId: 'other_company', workerId: 900, name: 'Ali', baseRevision: 1 }
    });
    const unbind = await server.inject({
      method: 'POST', url: '/api/admin/webapp/companies/comp_novda/workers/180/unbind', headers,
      payload: { companyId: 'other_company', workerId: 900, telegramId: '8363499557' }
    });

    expect(edit.statusCode).toBe(200);
    expect(dashboard.updateWorker).toHaveBeenCalledWith('274466315', expect.objectContaining({ companyId: 'comp_novda', workerId: '180' }));
    expect(unbind.statusCode).toBe(200);
    expect(dashboard.unbindWorkerTelegram).toHaveBeenCalledWith('274466315', expect.objectContaining({
      companyId: 'comp_novda', workerId: '180', telegramId: '8363499557'
    }));
  });

  it('serves the static app and assets with no-store security headers', async () => {
    const { app: server } = startApp();
    await server.ready();

    const page = await server.inject({ method: 'GET', url: '/admin-app' });
    const script = await server.inject({ method: 'GET', url: '/admin-app/admin.js' });
    const financialIntent = await server.inject({ method: 'GET', url: '/admin-app/financial-intent.js' });
    const companyStyles = await server.inject({ method: 'GET', url: '/admin-app/company-admin.css' });

    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.body).toContain('novda-admin-webapp-version');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    expect(page.body).toContain('<script src="/admin-app/financial-intent.js" defer></script>');
    expect(financialIntent.statusCode).toBe(200);
    expect(financialIntent.headers['content-type']).toContain('javascript');
    expect(financialIntent.headers['content-security-policy']).toContain("script-src 'self'");
    expect(financialIntent.body).toContain("locks?.request");
    expect(companyStyles.statusCode).toBe(200);
    expect(companyStyles.headers['content-type']).toContain('text/css');
    expect(companyStyles.body).toContain('.company-app');
    for (const name of ['IBMPlexSans[wdth,wght].ttf', 'Onest[wght].ttf']) {
      const font = await server.inject({ method: 'GET', url: `/admin-app/${encodeURIComponent(name)}` });
      expect(font.statusCode).toBe(200);
      expect(font.headers['content-type']).toContain('font/ttf');
      expect(font.rawPayload).toEqual(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '../../../../packages/assets/fonts', name)));
    }
    expect((await server.inject({ method: 'GET', url: '/admin-app/private.txt' })).statusCode).toBe(404);
  });
  it('serves daily production report to authorized service callers and rejects unauthenticated requests', async () => {
    const dashboard = createDashboard();
    const { app: server } = startApp({ dashboard });
    await server.ready();

    const unauthorized = await server.inject({
      method: 'GET',
      url: '/internal/admin/daily-report'
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await server.inject({
      method: 'GET',
      url: '/internal/admin/daily-report?date=2026-11-10&companyId=comp_novda',
      headers: { 'x-novda-admin-token': 'internal-admin-service-token' }
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().success).toBe(true);
    expect(dashboard.dailyProductionReport).toHaveBeenCalledWith({
      date: '2026-11-10',
      companyId: 'comp_novda'
    });
  });

  it('serves daily production report to authenticated webapp sessions with company scope', async () => {
    const dashboard = createDashboard();
    const pool = { query: vi.fn(async (_sql: string, params: unknown[]) => ({
      rows: params[0] === '274466315' ? [{ company_id: 'comp_novda' }] : []
    })) };
    const { app: server } = startApp({ dashboard, pool });
    await server.ready();

    const unauth = await server.inject({
      method: 'GET',
      url: '/api/admin/webapp/daily-report'
    });
    expect(unauth.statusCode).toBe(401);

    const sessionToken = createSession('274466315');
    const auth = await server.inject({
      method: 'GET',
      url: '/api/admin/webapp/daily-report?date=2026-11-10',
      headers: { authorization: `Bearer ${sessionToken}` }
    });
    expect(auth.statusCode).toBe(200);
    expect(auth.json().success).toBe(true);
    expect(dashboard.dailyProductionReport).toHaveBeenCalledWith({
      companyId: 'comp_novda',
      date: '2026-11-10'
    });
  });
});
