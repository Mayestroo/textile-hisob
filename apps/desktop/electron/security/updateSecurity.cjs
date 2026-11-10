const TRUSTED_UPDATE_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'release.novda.uz'
]);

function blockUnverifiedUpdate(runtimeMode) {
  if (runtimeMode !== 'sync') return null;
  return {
    success: false,
    code: 'UPDATE_AUTHENTICITY_REQUIRED',
    error: ' updates require a verified release manifest; executable installation is disabled.'
  };
}

function isAllowedUpdateUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && TRUSTED_UPDATE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function resolveAllowedRedirect(rawUrl, location) {
  let nextUrl;
  try {
    nextUrl = new URL(location, rawUrl).toString();
  } catch {
    return null;
  }
  return isAllowedUpdateUrl(nextUrl) ? nextUrl : null;
}

module.exports = { isAllowedUpdateUrl, resolveAllowedRedirect, blockUnverifiedUpdate, TRUSTED_UPDATE_HOSTS };
