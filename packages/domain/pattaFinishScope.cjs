'use strict';

const crypto = require('crypto');

// Both runtimes hash the same bounded, exact-ID scope; no display numbers are identities.
function finishScopeHash({ companyId, periodId, parties, batchSettingsRevision, nextPattaNumber }) {
  const sorted = parties.map(({ id, expectedRevision }) => ({ id, expectedRevision: Number(expectedRevision) }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (sorted.some((party, index) => !party.id || !Number.isSafeInteger(party.expectedRevision)
    || (index > 0 && party.id === sorted[index - 1].id))) throw new Error('INVALID_FINISH_SCOPE');
  const json = JSON.stringify({ companyId, periodId, parties: sorted, batchSettingsRevision: Number(batchSettingsRevision), nextPattaNumber: Number(nextPattaNumber) });
  return crypto.createHash('sha256').update(json).digest('hex');
}

module.exports = { finishScopeHash };
