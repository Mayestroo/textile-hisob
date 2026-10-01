function isValidCompanyId(companyId) {
  return typeof companyId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(companyId) && companyId !== 'unassigned';
}

function validateRequestedCompanyId(requestedCompanyId, activeCompanyId) {
  if (!isValidCompanyId(requestedCompanyId) || !isValidCompanyId(activeCompanyId) || requestedCompanyId !== activeCompanyId) {
    throw new Error('Invalid or unauthorized company context');
  }
  return requestedCompanyId;
}

module.exports = { isValidCompanyId, validateRequestedCompanyId };
