const AUTHORIZATION_UNAVAILABLE = 'AUTHORIZATION_UNAVAILABLE';

function authorizationUnavailable(operation) {
  return {
    success: false,
    code: AUTHORIZATION_UNAVAILABLE,
    error: `Authorization unavailable for ${operation}; operation rejected`
  };
}

function rejectRendererCompanyAssignment() {
  return authorizationUnavailable('company assignment');
}

function rejectRendererLicenseSettings() {
  return authorizationUnavailable('license settings');
}

function rejectRemoteDeviceMutation() {
  return {
    accepted: false,
    code: AUTHORIZATION_UNAVAILABLE,
    reason: 'Untrusted device payload is not an authenticated command authority'
  };
}

module.exports = {
  AUTHORIZATION_UNAVAILABLE,
  authorizationUnavailable,
  rejectRendererCompanyAssignment,
  rejectRendererLicenseSettings,
  rejectRemoteDeviceMutation
};
