'use strict';

const fs = require('fs');
const path = require('path');
const { createAdminDashboardService } = require('./adminDashboard.cjs');
const { verifyAdminWebSession } = require('./adminWebAuth.cjs');
const { parseAdminTelegramIds } = require('../activation/activationRequests.cjs');
const { readSecret, constantTimeEquals } = require('../activation/activationRoutes.cjs');

const INTERNAL_SESSION_PATH = '/internal/admin/webapp/session';
const INTERNAL_SIGN_PATH = '/internal/admin/webapp/sign-activation';
const WEBAPP_VERSION_MARKER = 'novda-admin-webapp-version';
const MAX_INIT_DATA_LENGTH = 8192;
const MAX_SESSION_REQUESTS_PER_MINUTE = 20;

function sendAdminDashboardError(reply, error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : 'ADMIN_DASHBOARD_UNAVAILABLE';
  const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode
    : 500;
  return reply.code(statusCode).header('Cache-Control', 'no-store').send({
    success: false,
    error: { code }
  });
}

function createSessionRateLimiter(options = {}) {
  const maxRequests = options.maxRequests || MAX_SESSION_REQUESTS_PER_MINUTE;
  const windowMs = options.windowMs || 60_000;
  const now = options.now || Date.now;
  const entries = new Map();
  return function checkSessionRateLimit(key) {
    const currentTime = now();
    const current = entries.get(key);
    if (!current || current.startedAt + windowMs <= currentTime) {
      entries.set(key, { startedAt: currentTime, count: 1 });
      return true;
    }
    if (current.count >= maxRequests) return false;
    current.count += 1;
    return true;
  };
}

function isInternalAdminBotUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:'
      && parsed.hostname === 'novda-admin-bot'
      && parsed.port === '8080'
      && parsed.pathname === '/'
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function secureHtmlHeaders(reply) {
  return reply
    .type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org")
    .header('X-Novda-Admin-WebApp-Version', '1');
}

function registerAdminDashboardRoutes(app, options = {}) {
  const env = options.env || process.env;
  const sessionSecret = options.sessionSecret ?? readSecret(env, 'NOVDA_ADMIN_WEBAPP_SESSION_SECRET');
  const adminApiToken = options.adminApiToken ?? readSecret(env, 'NOVDA_ADMIN_API_TOKEN');
  const adminBotInternalUrl = String(options.adminBotInternalUrl ?? env.NOVDA_ADMIN_BOT_INTERNAL_URL ?? '').trim().replace(/\/$/, '');
  const adminBotInternalUrlReady = isInternalAdminBotUrl(adminBotInternalUrl);
  const allowedAdminIds = options.allowedAdminIds instanceof Set
    ? options.allowedAdminIds
    : parseAdminTelegramIds(options.allowedAdminIds ?? readSecret(env, 'NOVDA_ADMIN_TELEGRAM_IDS'));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const adminWebAppPath = options.adminWebAppPath || path.join(__dirname, '..', '..', 'static', 'admin-webapp');
  const checkSessionRateLimit = options.checkSessionRateLimit || createSessionRateLimiter();

  const signerClient = options.signerClient || (async ({ sessionToken, payload }) => {
    if (!adminApiToken || !adminBotInternalUrlReady || typeof fetchImpl !== 'function') {
      const error = new Error('ACTIVATION_SIGNER_UNAVAILABLE');
      error.code = 'ACTIVATION_SIGNER_UNAVAILABLE';
      error.statusCode = 503;
      throw error;
    }
    const response = await fetchImpl(`${adminBotInternalUrl}${INTERNAL_SIGN_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-novda-admin-token': adminApiToken
      },
      body: JSON.stringify({ sessionToken, payload })
    });
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (!response.ok || result?.success !== true || result.telegramId == null) {
      const error = new Error('ACTIVATION_SIGNER_UNAVAILABLE');
      error.code = 'ACTIVATION_SIGNER_UNAVAILABLE';
      error.statusCode = 503;
      throw error;
    }
    return result;
  });

  const dashboard = options.dashboard || createAdminDashboardService({
    pool: options.pool,
    allowedAdminIds,
    signerClient,
    publicKey: options.publicKey
  });

  async function adminSessionGuard(request, reply) {
    const authorization = typeof request.headers.authorization === 'string'
      ? request.headers.authorization
      : '';
    const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(authorization);
    if (!match) {
      return reply.code(401).header('Cache-Control', 'no-store').send({
        success: false,
        error: { code: 'ADMIN_SESSION_REQUIRED' }
      });
    }
    try {
      request.adminSession = verifyAdminWebSession(match[1], sessionSecret, allowedAdminIds);
      request.adminSessionToken = match[1];
    } catch (error) {
      return sendAdminDashboardError(reply, error);
    }
  }

  async function invoke(request, reply, action) {
    try {
      const result = await action();
      return reply.header('Cache-Control', 'no-store').send({ success: true, ...result });
    } catch (error) {
      return sendAdminDashboardError(reply, error);
    }
  }

  app.get('/admin-app', async (_request, reply) => {
    try {
      const html = fs.readFileSync(path.join(adminWebAppPath, 'index.html'), 'utf8');
      if (!html.includes(`name="${WEBAPP_VERSION_MARKER}"`)) {
        return reply.code(503).header('Cache-Control', 'no-store').send({ success: false, error: { code: 'ADMIN_WEBAPP_NOT_READY' } });
      }
      return secureHtmlHeaders(reply).send(html);
    } catch {
      return reply.code(503).header('Cache-Control', 'no-store').send({ success: false, error: { code: 'ADMIN_WEBAPP_NOT_READY' } });
    }
  });

  app.get('/admin-app/:asset', async (request, reply) => {
    const assets = {
      'admin.css': { type: 'text/css; charset=utf-8', file: 'admin.css' },
      'admin.js': { type: 'application/javascript; charset=utf-8', file: 'admin.js' }
    };
    const asset = assets[request.params.asset];
    if (!asset) return reply.code(404).header('Cache-Control', 'no-store').send({ success: false, error: { code: 'ADMIN_WEBAPP_ASSET_NOT_FOUND' } });
    try {
      const content = fs.readFileSync(path.join(adminWebAppPath, asset.file), 'utf8');
      return reply.type(asset.type)
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org")
        .send(content);
    } catch {
      return reply.code(503).header('Cache-Control', 'no-store').send({ success: false, error: { code: 'ADMIN_WEBAPP_ASSET_UNAVAILABLE' } });
    }
  });

  app.post('/api/admin/webapp/session', async (request, reply) => {
    const initData = request.body?.initData;
    if (typeof initData !== 'string' || initData.length === 0 || initData.length > MAX_INIT_DATA_LENGTH) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ success: false, error: { code: 'WEBAPP_AUTH_INVALID' } });
    }
    const clientAddress = String(request.ip || 'unknown').slice(0, 128);
    if (!checkSessionRateLimit(clientAddress)) {
      return reply.code(429).header('Cache-Control', 'no-store').send({ success: false, error: { code: 'WEBAPP_AUTH_RATE_LIMITED' } });
    }
    if (!adminApiToken || !adminBotInternalUrlReady || Buffer.byteLength(sessionSecret, 'utf8') < 32 || typeof fetchImpl !== 'function') {
      return reply.code(503).header('Cache-Control', 'no-store').send({ success: false, error: { code: 'ADMIN_WEBAPP_AUTH_UNAVAILABLE' } });
    }
    try {
      const response = await fetchImpl(`${adminBotInternalUrl}${INTERNAL_SESSION_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-novda-admin-token': adminApiToken
        },
        body: JSON.stringify({ initData })
      });
      let result;
      try { result = await response.json(); } catch { result = null; }
      if (!response.ok || result?.success !== true || !result.session?.token || !result.user) {
        const code = typeof result?.error?.code === 'string' ? result.error.code : 'WEBAPP_AUTH_REJECTED';
        const status = response.status === 403 ? 403 : response.status === 429 ? 429 : response.status >= 500 ? 503 : 401;
        return reply.code(status).header('Cache-Control', 'no-store').send({ success: false, error: { code } });
      }
      const verified = verifyAdminWebSession(result.session.token, sessionSecret, allowedAdminIds);
      if (String(result.user.id || '') !== verified.telegramId || Number(result.session.expiresAt) !== verified.expiresAt) {
        return reply.code(401).header('Cache-Control', 'no-store').send({ success: false, error: { code: 'ADMIN_SESSION_INVALID' } });
      }
      const safeUser = {
        id: verified.telegramId,
        firstName: String(result.user.first_name || '').slice(0, 128),
        lastName: String(result.user.last_name || '').slice(0, 128),
        username: String(result.user.username || '').slice(0, 64)
      };
      return reply.header('Cache-Control', 'no-store').send({
        success: true,
        session: { token: result.session.token, expiresAt: verified.expiresAt },
        user: safeUser
      });
    } catch (error) {
      if (error?.code === 'ADMIN_SESSION_NOT_AUTHORIZED' || error?.code === 'ADMIN_SESSION_INVALID' || error?.code === 'ADMIN_SESSION_EXPIRED') {
        return sendAdminDashboardError(reply, error);
      }
      return reply.code(503).header('Cache-Control', 'no-store').send({
        success: false,
        error: { code: 'ADMIN_WEBAPP_AUTH_UNAVAILABLE' }
      });
    }
  });

  app.get('/api/admin/webapp/session', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ session: request.adminSession })));
  app.get('/api/admin/webapp/overview', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ overview: await dashboard.overview() })));
  app.get('/api/admin/webapp/companies', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ companies: await dashboard.listCompanies() })));
  app.get('/api/admin/webapp/devices', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ devices: await dashboard.listDevices() })));
  app.get('/api/admin/webapp/workers', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ ...await dashboard.listWorkers(request.query || {}) })));
  app.get('/api/admin/webapp/payroll', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ payroll: await dashboard.getPayroll(request.query || {}) })));
  app.get('/api/admin/webapp/activations', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ activations: await dashboard.listActivations(request.query || {}) })));
  app.get('/api/admin/webapp/models', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => dashboard.listModels(request.query || {})));
  app.get('/api/admin/webapp/parties', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => dashboard.listParties(request.query || {})));
  app.get('/api/admin/webapp/tickets', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => dashboard.listTickets(request.query || {})));
  app.get('/api/admin/webapp/balances', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => dashboard.getBalances(request.query || {})));
  app.get('/api/admin/webapp/system', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ system: await dashboard.getSystemHealth() })));
  app.get('/api/admin/webapp/activations/:requestId/events', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ events: await dashboard.getActivationEvents(request.params.requestId) })));

  app.post('/api/admin/webapp/companies', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ company: await dashboard.upsertCompany(request.adminSession.telegramId, request.body || {}) })));
  app.put('/api/admin/webapp/companies/:companyId/strict-mode', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ mode: await dashboard.updateCompanyStrictMode(request.adminSession.telegramId, {
      companyId: request.params.companyId,
      strictMode: request.body?.strictMode,
      sessionToken: request.adminSessionToken
    }) })));
  app.post('/api/admin/webapp/activations/:requestId/approve', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ activation: await dashboard.approveActivation(request.adminSession.telegramId, {
      ...(request.body || {}), requestId: request.params.requestId, sessionToken: request.adminSessionToken
    }) })));
  app.post('/api/admin/webapp/activations/:requestId/reject', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ activation: await dashboard.rejectActivation(request.adminSession.telegramId, {
      ...(request.body || {}), requestId: request.params.requestId
    }) })));
  app.post('/api/admin/webapp/activations/:requestId/revoke', { preHandler: adminSessionGuard }, async (request, reply) =>
    invoke(request, reply, async () => ({ activation: await dashboard.revokeActivation(request.adminSession.telegramId, {
      ...(request.body || {}), requestId: request.params.requestId, sessionToken: request.adminSessionToken
    }) })));
}

module.exports = {
  createSessionRateLimiter,
  isInternalAdminBotUrl,
  registerAdminDashboardRoutes,
  sendAdminDashboardError
};
