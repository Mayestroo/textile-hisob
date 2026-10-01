'use strict';

/**
 * Compares two semantic version strings (e.g. "2.0.0" vs "1.7.4").
 * Returns:
 *   1 if v1 > sync
 *  -1 if v1 < sync
 *   0 if v1 === sync
 */
function compareVersions(v1, sync) {
  const parts1 = String(v1 || '0.0.0').split('-')[0].split('.').map((p) => parseInt(p, 10) || 0);
  const parts2 = String(sync || '0.0.0').split('-')[0].split('.').map((p) => parseInt(p, 10) || 0);

  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

function isVersionAtLeast(clientVersion, minVersion) {
  return compareVersions(clientVersion, minVersion) >= 0;
}

const DEFAULT_MIN_CLIENT_VERSION = process.env.NOVDA_MIN_CLIENT_VERSION || '0.0.0';

function checkClientVersionFence(clientVersion, minVersion = DEFAULT_MIN_CLIENT_VERSION) {
  if (!clientVersion || !isVersionAtLeast(clientVersion, minVersion)) {
    const err = new Error(`Client version "${clientVersion}" is below minimum supported  writer version "${minVersion}"`);
    err.statusCode = 426;
    err.code = 'CLIENT_VERSION_TOO_OLD';
    err.minVersion = minVersion;
    err.clientVersion = clientVersion;
    throw err;
  }
  return true;
}

module.exports = {
  compareVersions,
  isVersionAtLeast,
  DEFAULT_MIN_CLIENT_VERSION,
  checkClientVersionFence
};
