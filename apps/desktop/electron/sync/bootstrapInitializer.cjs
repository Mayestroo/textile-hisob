'use strict';

const { getBootstrapState, applyBootstrapSnapshot } = require('./bootstrapApplier.cjs');

async function ensureCompanyBootstrapped(db, companyId, syncClient, options = {}) {
  const before = getBootstrapState(db, companyId);
  if (before.status === 'COMPLETE') {
    const storedGen = db.prepare("SELECT value FROM local_meta WHERE key = 'purge_generation'").get()?.value;
    if (storedGen && typeof syncClient?.setPurgeGeneration === 'function') {
      syncClient.setPurgeGeneration(storedGen);
    }
    return { status: 'ALREADY_BOOTSTRAPPED', cursor: before.cursor };
  }

  const response = await syncClient.getBootstrap();
  const applied = applyBootstrapSnapshot(db, companyId, response, options);
  if (response?.purgeEra?.purgeGeneration && typeof syncClient?.setPurgeGeneration === 'function') {
    syncClient.setPurgeGeneration(response.purgeEra.purgeGeneration);
  }
  return applied;
}

module.exports = { ensureCompanyBootstrapped };
