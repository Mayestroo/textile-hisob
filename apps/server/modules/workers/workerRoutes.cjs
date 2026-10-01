'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readSecret, constantTimeEquals, serviceTokenGuard } = require('../activation/activationRoutes.cjs');
const workerService = require('./workerService.cjs');

function sendWorkerError(reply, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  return reply.code(statusCode).send({
    success: false,
    error: {
      code: error?.code || 'WORKER_SERVICE_FAILED',
      message: statusCode < 500 ? (error?.message || error?.code) : 'Worker service unavailable'
    }
  });
}

function signableWorkerRequest(params) {
  return `v1:${params.companyId}:${params.workerId}:${params.telegramId}:${params.expiresAt}`;
}

function verifyWorkerWebToken(params, suppliedToken, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof suppliedToken !== 'string' || !/^[a-f0-9]{64}$/.test(suppliedToken)) return false;
  const expiresAt = Number(params.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < nowSeconds || expiresAt > nowSeconds + 20 * 60) return false;
  const normalized = {
    companyId: String(params.companyId || ''),
    workerId: String(params.workerId || ''),
    telegramId: String(params.telegramId || ''),
    expiresAt
  };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(normalized.companyId)
    || !/^\d+$/.test(normalized.workerId)
    || !/^\d{1,24}$/.test(normalized.telegramId)) return false;
  const expected = crypto.createHmac('sha256', secret).update(signableWorkerRequest(normalized), 'utf8').digest('hex');
  return constantTimeEquals(expected, suppliedToken);
}

function queryWorkerInput(query) {
  return {
    companyId: String(query?.companyId || ''),
    workerId: Number(query?.workerId),
    telegramId: String(query?.telegramId || '')
  };
}

function registerWorkerRoutes(app, options = {}) {
  const pool = options.pool;
  const env = options.env || process.env;
  const workerApiToken = options.workerApiToken ?? readSecret(env, 'NOVDA_WORKER_API_TOKEN');
  const workerHmacSecret = options.workerAuthHmacSecret ?? readSecret(env, 'WORKER_AUTH_HMAC_SECRET');
  const workerWebAppPath = options.workerWebAppPath || path.join(__dirname, '..', '..', 'worker-bot', 'webapp', 'index.html');

  app.get('/worker-app', async (_request, reply) => {
    try {
      const html = fs.readFileSync(workerWebAppPath, 'utf8');
      return reply.type('text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .send(html);
    } catch {
      return reply.code(503).send({ success: false, error: { code: 'WORKER_WEBAPP_UNAVAILABLE', message: 'Worker app unavailable' } });
    }
  });

  app.register(async (workerApi) => {
    workerApi.addHook('preHandler', serviceTokenGuard('x-novda-worker-token', workerApiToken));

    workerApi.get('/api/worker/bindings/by-telegram/:telegramId', async (request, reply) => {
      try {
        const binding = await workerService.getWorkerBindingByTelegram(pool, request.params.telegramId);
        return reply.send({ success: true, binding });
      } catch (error) { return sendWorkerError(reply, error); }
    });

    workerApi.get('/api/worker/bindings/by-worker', async (request, reply) => {
      try {
        const binding = await workerService.getWorkerBindingByWorker(pool, request.query.companyId, request.query.workerId);
        return reply.send({ success: true, binding });
      } catch (error) { return sendWorkerError(reply, error); }
    });

    workerApi.get('/api/worker/enrollment', async (request, reply) => {
      try {
        const worker = await workerService.getWorkerForEnrollment(pool, request.query.companyId, request.query.workerId);
        return reply.send({ success: true, worker });
      } catch (error) { return sendWorkerError(reply, error); }
    });

    workerApi.post('/api/worker/bindings', async (request, reply) => {
      try {
        const binding = await workerService.claimWorkerBinding(pool, request.body);
        return reply.code(201).send({ success: true, binding });
      } catch (error) { return sendWorkerError(reply, error); }
    });
  });

  async function authorizeWorkerRead(request) {
    const input = queryWorkerInput(request.query);
    const suppliedServiceToken = typeof request.headers['x-novda-worker-token'] === 'string'
      ? request.headers['x-novda-worker-token']
      : '';
    if (workerApiToken && constantTimeEquals(workerApiToken, suppliedServiceToken)) return input;
    const suppliedWebToken = typeof request.headers['x-worker-auth-token'] === 'string'
      ? request.headers['x-worker-auth-token']
      : '';
    if (!workerHmacSecret) {
      const error = new Error('WORKER_WEB_AUTH_NOT_CONFIGURED');
      error.code = 'WORKER_WEB_AUTH_NOT_CONFIGURED';
      error.statusCode = 503;
      throw error;
    }
    if (!verifyWorkerWebToken({ ...request.query, ...input }, suppliedWebToken, workerHmacSecret)) {
      const error = new Error('WORKER_AUTH_REQUIRED');
      error.code = 'WORKER_AUTH_REQUIRED';
      error.statusCode = 401;
      throw error;
    }
    return input;
  }

  app.get('/api/worker/profile', async (request, reply) => {
    try {
      const input = await authorizeWorkerRead(request);
      const profile = await workerService.getWorkerProfile(pool, input);
      return reply.header('Cache-Control', 'no-store').send({ success: true, profile });
    } catch (error) { return sendWorkerError(reply, error); }
  });

  app.get('/api/worker/tickets', async (request, reply) => {
    try {
      const input = await authorizeWorkerRead(request);
      const result = await workerService.getWorkerTickets(pool, input, request.query.limit);
      return reply.header('Cache-Control', 'no-store').send({ success: true, ...result });
    } catch (error) { return sendWorkerError(reply, error); }
  });
}

module.exports = { signableWorkerRequest, verifyWorkerWebToken, registerWorkerRoutes };
