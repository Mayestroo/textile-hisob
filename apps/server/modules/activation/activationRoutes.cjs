'use strict';

const crypto = require('crypto');
const {
  activationError,
  createActivationRequest,
  getActivationRequest,
  parseAdminTelegramIds,
  upsertActivationCompany,
  listActivationCompanies,
  listPendingActivationRequests,
  getAdminActivationRequest,
  approveActivationRequest,
  rejectActivationRequest,
  revokeActivationRequest
} = require('./activationRequests.cjs');

function readSecret(env, name) {
  const filePath = env[`${name}_FILE`];
  if (filePath) {
    try { return require('fs').readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
  }
  return String(env[name] || '').trim();
}

function constantTimeEquals(expected, supplied) {
  if (!expected || typeof supplied !== 'string') return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function serviceTokenGuard(tokenName, configuredToken) {
  return async (request, reply) => {
    const supplied = request.headers[tokenName];
    if (!configuredToken) {
      return reply.code(503).send({ success: false, error: { code: 'SERVICE_CREDENTIAL_NOT_CONFIGURED', message: 'Service is unavailable' } });
    }
    if (!constantTimeEquals(configuredToken, typeof supplied === 'string' ? supplied : '')) {
      return reply.code(401).send({ success: false, error: { code: 'SERVICE_AUTH_REQUIRED', message: 'Authentication required' } });
    }
  };
}

function sendActivationError(reply, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  return reply.code(statusCode).send({
    success: false,
    error: {
      code: error?.code || 'ACTIVATION_REQUEST_FAILED',
      message: statusCode < 500 ? (error?.message || error?.code) : 'Activation service unavailable'
    }
  });
}

function registerActivationRoutes(app, options = {}) {
  const pool = options.pool;
  const adminApiToken = options.adminApiToken ?? readSecret(options.env || process.env, 'NOVDA_ADMIN_API_TOKEN');
  const allowedAdminIds = options.allowedAdminIds instanceof Set
    ? options.allowedAdminIds
    : parseAdminTelegramIds(options.adminTelegramIds ?? readSecret(options.env || process.env, 'NOVDA_ADMIN_TELEGRAM_IDS'));
  const publicKey = options.publicKey;

  app.post('/api/activation/requests', async (request, reply) => {
    try {
      const created = await createActivationRequest(pool, request.body);
      return reply.code(created.replay ? 200 : 201).header('Cache-Control', 'no-store').send({ success: true, request: created });
    } catch (error) {
      return sendActivationError(reply, error);
    }
  });

  app.get('/api/activation/requests/:requestId', async (request, reply) => {
    try {
      const requestToken = typeof request.headers['x-activation-request-token'] === 'string'
        ? request.headers['x-activation-request-token']
        : '';
      const machineId = typeof request.headers['x-machine-id'] === 'string' ? request.headers['x-machine-id'] : '';
      const result = await getActivationRequest(pool, request.params.requestId, requestToken, machineId);
      return reply.header('Cache-Control', 'no-store').send({ success: true, request: result });
    } catch (error) {
      return sendActivationError(reply, error);
    }
  });

  app.register(async (admin) => {
    admin.addHook('preHandler', serviceTokenGuard('x-novda-admin-token', adminApiToken));

    admin.get('/api/admin/activation/companies', async (_request, reply) => {
      try { return reply.send({ success: true, companies: await listActivationCompanies(pool) }); }
      catch (error) { return sendActivationError(reply, error); }
    });

    admin.post('/api/admin/activation/companies', async (request, reply) => {
      try {
        const company = await upsertActivationCompany(pool, request.body, request.body?.adminTelegramId, allowedAdminIds);
        return reply.code(201).send({ success: true, company });
      } catch (error) { return sendActivationError(reply, error); }
    });

    admin.get('/api/admin/activation/requests', async (_request, reply) => {
      try { return reply.send({ success: true, requests: await listPendingActivationRequests(pool) }); }
      catch (error) { return sendActivationError(reply, error); }
    });

    admin.get('/api/admin/activation/requests/:requestId', async (request, reply) => {
      try { return reply.send({ success: true, request: await getAdminActivationRequest(pool, request.params.requestId) }); }
      catch (error) { return sendActivationError(reply, error); }
    });

    admin.post('/api/admin/activation/requests/:requestId/approve', async (request, reply) => {
      try {
        const approved = await approveActivationRequest(pool, request.params.requestId, request.body, { allowedAdminIds, publicKey });
        return reply.send({ success: true, request: approved });
      } catch (error) { return sendActivationError(reply, error); }
    });

    admin.post('/api/admin/activation/requests/:requestId/reject', async (request, reply) => {
      try {
        const rejected = await rejectActivationRequest(pool, request.params.requestId, request.body, allowedAdminIds);
        return reply.send({ success: true, request: rejected });
      } catch (error) { return sendActivationError(reply, error); }
    });

    admin.post('/api/admin/activation/requests/:requestId/revoke', async (request, reply) => {
      try {
        const revoked = await revokeActivationRequest(pool, request.params.requestId, request.body, { allowedAdminIds, publicKey });
        return reply.send({ success: true, request: revoked });
      } catch (error) { return sendActivationError(reply, error); }
    });
  });
}

module.exports = { readSecret, constantTimeEquals, serviceTokenGuard, registerActivationRoutes };
