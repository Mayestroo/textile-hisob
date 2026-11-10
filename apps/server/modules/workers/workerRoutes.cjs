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
  const workerPinRequired = String(env.NOVDA_WORKER_PIN_REQUIRED ?? 'true').toLowerCase() !== 'false';
  const workerWebAppPath = options.workerWebAppPath || path.join(__dirname, '..', '..', '..', 'webapps', 'worker', 'index.html');
  const fontPath = path.join(__dirname, '..', '..', '..', '..', 'packages', 'assets', 'fonts');

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

  app.get('/worker-app-assets/:asset', async (request, reply) => {
    const assets = {
      'worker.css': { file: 'styles/worker.css', type: 'text/css; charset=utf-8' },
      'worker.js': { file: 'scripts/worker.js', type: 'application/javascript; charset=utf-8' }
    };
    const asset = Object.hasOwn(assets, request.params.asset) ? assets[request.params.asset] : null;
    if (!asset) return reply.code(404).send({ success: false, error: { code: 'WORKER_ASSET_NOT_FOUND' } });
    try {
      return reply.type(asset.type).header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(fs.readFileSync(path.join(path.dirname(workerWebAppPath), asset.file), 'utf8'));
    } catch {
      return reply.code(503).send({ success: false, error: { code: 'WORKER_ASSET_UNAVAILABLE' } });
    }
  });

  app.get('/worker-app-font/:asset', async (request, reply) => {
    const asset = request.params.asset;
    if (asset !== 'IBMPlexSans[wdth,wght].ttf' && asset !== 'Onest[wght].ttf')
      return reply.code(404).send({ success: false, error: { code: 'WORKER_FONT_NOT_FOUND' } });
    try {
      return reply.type('font/ttf').header('Cache-Control', 'public, max-age=86400')
        .header('X-Content-Type-Options', 'nosniff')
        .send(fs.readFileSync(path.join(fontPath, asset)));
    } catch {
      return reply.code(503).send({ success: false, error: { code: 'WORKER_FONT_UNAVAILABLE' } });
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
        const worker = await workerService.getWorkerForEnrollment(
          pool, request.query.companyId, request.query.workerId, { pinRequired: workerPinRequired }
        );
        return reply.send({ success: true, worker });
      } catch (error) { return sendWorkerError(reply, error); }
    });

    workerApi.post('/api/worker/bindings', async (request, reply) => {
      try {
        const binding = await workerService.claimWorkerBinding(pool, request.body, { pinRequired: workerPinRequired });
        return reply.code(201).send({ success: true, binding });
      } catch (error) { return sendWorkerError(reply, error); }
    });

    workerApi.post('/api/worker/onboarding-contact', async (request, reply) => {
      try {
        const telegramId = String(request.body?.telegramId || '');
        const companyId = String(request.body?.companyId || '');
        const phone = String(request.body?.phoneNumber || '').trim();
        const contactName = String(request.body?.contactName || '').trim().slice(0, 160);
        if (!/^\d{1,24}$/.test(telegramId) || !/^[A-Za-z0-9_-]{1,64}$/.test(companyId)
          || !/^\+?[0-9 ()-]{7,24}$/.test(phone)) {
          return reply.code(400).send({ success: false, error: { code: 'INVALID_WORKER_CONTACT' } });
        }
        await pool.query(
          `INSERT INTO worker_onboarding_contacts (telegram_id, company_id, phone_number, contact_name, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (telegram_id) DO UPDATE SET company_id = EXCLUDED.company_id,
             phone_number = EXCLUDED.phone_number, contact_name = EXCLUDED.contact_name, updated_at = NOW()`,
          [telegramId, companyId, phone, contactName]
        );
        return reply.code(201).send({ success: true });
      } catch (error) { return sendWorkerError(reply, error); }
    });
  });

  app.post('/api/worker/onboarding-bind', async (request, reply) => {
    try {
      const companyId = String(request.body?.companyId || '');
      const telegramId = String(request.body?.telegramId || '');
      const workerId = Number(request.body?.workerId);
      const expiresAt = request.body?.expiresAt;
      const suppliedToken = typeof request.headers['x-worker-auth-token'] === 'string'
        ? request.headers['x-worker-auth-token'] : '';
      if (!verifyWorkerWebToken({ companyId, workerId: 0, telegramId, expiresAt }, suppliedToken, workerHmacSecret)) {
        return reply.code(401).send({ success: false, error: { code: 'WORKER_AUTH_REQUIRED' } });
      }
      if (!Number.isSafeInteger(workerId) || workerId < 1) {
        return reply.code(400).send({ success: false, error: { code: 'INVALID_WORKER_ID' } });
      }
      const photoMatch = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(request.body?.photo || ''));
      if (!photoMatch) return reply.code(400).send({ success: false, error: { code: 'WORKER_PHOTO_REQUIRED' } });
      const photo = Buffer.from(photoMatch[1], 'base64');
      if (!photo.length || photo.length > 300 * 1024) return reply.code(413).send({ success: false, error: { code: 'WORKER_PHOTO_SIZE_INVALID' } });
      const contact = await pool.query(
        'SELECT phone_number FROM worker_onboarding_contacts WHERE telegram_id = $1 AND company_id = $2',
        [telegramId, companyId]
      );
      if (!contact.rows[0]) return reply.code(409).send({ success: false, error: { code: 'WORKER_CONTACT_REQUIRED' } });
      const binding = await workerService.claimWorkerBinding(pool, {
        telegramId, companyId, workerId, username: String(request.body?.username || '')
      }, { pinRequired: false });
      await pool.query(
        `UPDATE workers SET phone_number = $3, profile_photo = $4, profile_photo_updated_at = NOW()
         WHERE company_id = $1 AND id = $2`,
        [companyId, workerId, contact.rows[0].phone_number, photo]
      );
      await pool.query('DELETE FROM worker_onboarding_contacts WHERE telegram_id = $1', [telegramId]);
      return reply.code(201).header('Cache-Control', 'no-store').send({ success: true, binding });
    } catch (error) { return sendWorkerError(reply, error); }
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

  app.get('/api/worker/enrollment-check', async (request, reply) => {
    try {
      const companyId = typeof request.query?.companyId === 'string' ? request.query.companyId.trim() : '';
      if (!companyId) {
        return reply.code(400).send({ success: false, error: { code: 'COMPANY_ID_REQUIRED' } });
      }
      const workerId = Number(request.query?.workerId);
      if (!workerId || !Number.isSafeInteger(workerId)) {
        return reply.code(400).send({ success: false, error: { code: 'INVALID_WORKER_ID' } });
      }
      const worker = await workerService.getWorkerForEnrollment(pool, companyId, workerId, { pinRequired: false });
      return reply.header('Cache-Control', 'no-store').send({
        success: true,
        worker: { worker_id: worker.worker_id, worker_name: worker.worker_name }
      });
    } catch (error) { return sendWorkerError(reply, error); }
  });

  app.get('/api/worker/profile', async (request, reply) => {
    try {
      const input = await authorizeWorkerRead(request);
      const profile = await workerService.getWorkerProfile(pool, { ...input, periodId: request.query?.periodId });
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
