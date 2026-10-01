'use strict';

const { validateCompanyScope } = require('../../../auth/auth.cjs');
const { withCompanyBootstrapSnapshot } = require('../bootstrapSnapshot.cjs');

function createBootstrapHandler(pool, options = {}) {
  return async function handleGetBootstrap(req, reply) {
    const companyId = req.auth?.companyId;
    if (!companyId) {
      return reply.code(401).send({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required' }
      });
    }
    try {
      if (req.query?.companyId) validateCompanyScope(req, String(req.query.companyId));
      const result = await withCompanyBootstrapSnapshot(pool, companyId, {
        testHookAfterSnapshot: options.testHook
          ? (snapshot, cursor) => options.testHook(snapshot, cursor)
          : undefined
      });
      return reply.header('cache-control', 'no-store').send({
        success: true,
        snapshot: result.snapshot,
        cursor: result.cursor,
        counts: result.counts
      });
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      return reply.code(statusCode).send({
        success: false,
        error: {
          code: error?.code || 'BOOTSTRAP_UNAVAILABLE',
          message: statusCode < 500 ? error.message : 'Authoritative bootstrap is unavailable'
        }
      });
    }
  };
}

module.exports = { createBootstrapHandler };
