'use strict';

function mutationFenceEnabled(env = process.env) {
  return env.NOVDA_BUSINESS_MUTATIONS_ENABLED === 'true'
    || env.NOVDA_BUSINESS_MUTATIONS_ENABLED === '1';
}

function createBusinessMutationFence(options = {}) {
  const enabled = options.enabled === true;
  return async function requireBusinessMutationsEnabled(_request, reply) {
    if (enabled) return;
    return reply.code(503).send({
      success: false,
      error: {
        code: 'BUSINESS_MUTATIONS_DISABLED',
        message: 'Business writes are temporarily disabled'
      }
    });
  };
}

module.exports = { mutationFenceEnabled, createBusinessMutationFence };
