'use strict';

const { getBootstrapState, applyBootstrapSnapshot } = require('./bootstrapApplier.cjs');

async function ensureCompanyBootstrapped(db, companyId, syncClient, options = {}) {
  const before = getBootstrapState(db, companyId);
  if (before.status === 'COMPLETE') {
    return { status: 'ALREADY_BOOTSTRAPPED', cursor: before.cursor };
  }

  const response = await syncClient.getBootstrap();
  return applyBootstrapSnapshot(db, companyId, response, options);
}

module.exports = { ensureCompanyBootstrapped };
