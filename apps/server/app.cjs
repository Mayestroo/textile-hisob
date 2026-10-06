'use strict';

const fastify = require('fastify');
const { getServerPool } = require('./infrastructure/db.cjs');
const { createAuthMiddleware } = require('./auth/auth.cjs');
const { createOperationsHandler, createOperationStatusHandler } = require('./modules/sync/handlers/operations.cjs');
const { createChangeFeedHandler } = require('./modules/sync/handlers/changeFeed.cjs');
const { createBootstrapHandler } = require('./modules/sync/handlers/bootstrap.cjs');
const { createLeasesHandler } = require('./modules/sync/handlers/leases.cjs');
const { authenticateOperator, revokeOperatorSession } = require('./auth/operatorAuth.cjs');
const { registerActivationRoutes } = require('./modules/activation/activationRoutes.cjs');
const { registerWorkerRoutes } = require('./modules/workers/workerRoutes.cjs');
const { registerAdminDashboardRoutes } = require('./modules/admin/adminDashboardRoutes.cjs');
const { getPeriodArchive } = require('./modules/sync/workbookOperations.cjs');
const { createWorker } = require('./modules/workers/workerCreation.cjs');
const { mutationFenceEnabled, createBusinessMutationFence } = require('./modules/sync/businessMutationFence.cjs');

/**
 * Builds and configures Fastify server for Authoritative Distributed Sync.
 *
 * @param {object} [options={}]
 * @param {import('pg').Pool} [options.pool]
 * @param {string} [options.minClientVersion]
 * @param {boolean} [options.allowTestTokens=false]
 * @param {boolean} [options.logger=false]
 */
function buildFastifyServer(options = {}) {
  const app = fastify({
    logger: options.logger || false,
    bodyLimit: 64 * 1024
  });

  const pool = options.pool || getServerPool();
  const authMiddleware = createAuthMiddleware(pool, {
    minClientVersion: options.minClientVersion,
    allowTestTokens: options.allowTestTokens === true
  });

  const operationsHandler = createOperationsHandler(pool);
  const operationStatusHandler = createOperationStatusHandler(pool);
  const changeFeedHandler = createChangeFeedHandler(pool);
  const bootstrapHandler = createBootstrapHandler(pool, { testHook: options.bootstrapTestHook });
  const leasesHandler = createLeasesHandler(pool);
  const env = options.env || process.env;
  const allowTestMutations = options.allowTestTokens === true;
  const businessMutationFence = createBusinessMutationFence({
    enabled: options.businessMutationsEnabled === undefined
      ? allowTestMutations || mutationFenceEnabled(env)
      : options.businessMutationsEnabled === true
  });

  registerActivationRoutes(app, {
    pool,
    env,
    adminApiToken: options.adminApiToken,
    adminTelegramIds: options.adminTelegramIds,
    allowedAdminIds: options.allowedAdminIds,
    publicKey: options.licensePublicKey
  });
  registerWorkerRoutes(app, {
    pool,
    env,
    workerApiToken: options.workerApiToken,
    workerAuthHmacSecret: options.workerAuthHmacSecret,
    workerWebAppPath: options.workerWebAppPath
  });
  registerAdminDashboardRoutes(app, {
    pool,
    env,
    adminApiToken: options.adminApiToken,
    allowedAdminIds: options.allowedAdminIds,
    sessionSecret: options.adminWebAppSessionSecret,
    adminBotInternalUrl: options.adminBotInternalUrl,
    adminWebAppPath: options.adminWebAppPath,
    fetchImpl: options.fetchImpl,
    signerClient: options.adminSignerClient,
    dashboard: options.adminDashboard,
    publicKey: options.licensePublicKey
  });

  // Health check endpoints (unauthenticated)
  const healthHandler = async (req, reply) => {
    return {
      status: 'ok',
      service: 'novda-authoritative-sync',
      timestamp: new Date().toISOString()
    };
  };
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // Protected API scope
  app.register(async (apiScope) => {
    apiScope.addHook('preHandler', authMiddleware);

    // Distributed Operations Endpoint
    apiScope.post('/api/sync/operations', { preHandler: businessMutationFence }, operationsHandler);
    apiScope.post('/api/sync/operations/status', operationStatusHandler);

    // Single atomic create: operationId is only idempotency; worker.id is assigned by PostgreSQL.
    apiScope.post('/api/workers', { preHandler: businessMutationFence }, async (req, reply) => {
      try {
        const result = await createWorker(pool, req.auth, req.body);
        return reply.code(result.replay ? 200 : 201).send({ success: true, ...result });
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        return reply.code(statusCode).send({
          success: false,
          error: {
            code: error?.code || 'WORKER_CREATE_FAILED',
            message: statusCode < 500 ? (error?.message || error?.code) : 'Worker creation unavailable'
          }
        });
      }
    });

    apiScope.post('/api/auth/operator/login', async (req, reply) => {
      try {
        const result = await authenticateOperator(pool, req.auth, req.body || {});
        return reply.send({ success: true, session: result });
      } catch (err) {
        const status = err.code === 'OPERATOR_LOGIN_THROTTLED' ? 429 : 401;
        return reply.code(status).send({ success: false, error: { code: err.code || 'OPERATOR_AUTH_REJECTED', message: err.message } });
      }
    });

    apiScope.post('/api/auth/operator/revoke', async (req, reply) => {
      const token = req.headers['x-operator-token'] ? String(req.headers['x-operator-token']).trim() : '';
      if (!token) return reply.code(401).send({ success: false, error: { code: 'OPERATOR_AUTH_REQUIRED', message: 'Operator session required' } });
      await revokeOperatorSession(pool, token, req.auth);
      return reply.send({ success: true });
    });

    // Append-Only Change Feed Endpoint
    apiScope.get('/api/sync/changes', changeFeedHandler);

    // Initial canonical PostgreSQL state and same-snapshot incremental cursor.
    apiScope.get('/api/sync/bootstrap', bootstrapHandler);

    apiScope.get('/api/periods/:periodId/archive', async (req, reply) => {
      const periodId = typeof req.params?.periodId === 'string' ? req.params.periodId : '';
      if (!periodId || periodId.length > 128 || /[\u0000-\u001f\u007f]/.test(periodId)) {
        return reply.code(400).send({ success: false, error: { code: 'INVALID_PERIOD_ID', message: 'periodId is invalid' } });
      }
      try {
        const archive = await getPeriodArchive(pool, req.auth.companyId, periodId);
        return reply.send({ success: true, archive });
      } catch (error) {
        const status = error.code === 'PERIOD_ARCHIVE_NOT_FOUND' ? 404 : 500;
        return reply.code(status).send({ success: false, error: { code: error.code || 'PERIOD_ARCHIVE_READ_FAILED', message: error.message } });
      }
    });

    // Party Sequence Leases Endpoints
    apiScope.post('/api/leases/party', { preHandler: businessMutationFence }, leasesHandler.acquirePartyLease);
    apiScope.post('/api/leases/party/revoke', { preHandler: businessMutationFence }, leasesHandler.revokePartyLease);
  });

  return app;
}

module.exports = {
  buildFastifyServer
};
