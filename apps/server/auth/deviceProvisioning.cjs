'use strict';

const crypto = require('crypto');

/**
 * Generates a cryptographically secure 256-bit bearer token.
 * Uses Node crypto.randomBytes(32) providing 256 bits of CSPRNG entropy.
 *
 * @returns {string} 64-character hex-encoded token
 */
function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Computes the SHA-256 hash of a device bearer token.
 * The server MUST only persist this hash, never the plaintext token.
 *
 * @param {string} token Plaintext bearer token
 * @returns {string} 64-character hex hash
 */
function hashDeviceToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Cannot hash empty or invalid device token');
  }
  return crypto.createHash('sha256').update(token.trim(), 'utf8').digest('hex');
}

/**
 * Provisions a new production device identity bound to a company tenant.
 *
 * @param {import('pg').Pool} pool
 * @param {object} params
 * @param {string} params.deviceId Unique device identifier (e.g. machine hardware ID)
 * @param {string} params.companyId Tenant company identifier
 * @param {string} [params.clientVersion='0.0.0'] Initial approved client version
 * @returns {Promise<{ deviceId: string, companyId: string, clientVersion: string, token: string, tokenHash: string }>}
 */
async function provisionDevice(pool, params) {
  const { deviceId, companyId, clientVersion = '0.0.0' } = params;

  if (!deviceId || typeof deviceId !== 'string' || !deviceId.trim()) {
    throw new Error('deviceId is required for provisioning');
  }
  if (!companyId || typeof companyId !== 'string' || !companyId.trim()) {
    throw new Error('companyId is required for provisioning');
  }

  const plainToken = generateDeviceToken();
  const tokenHash = hashDeviceToken(plainToken);

  await pool.query(`
    INSERT INTO server_devices (device_id, company_id, token_hash, client_version, is_revoked, registered_at)
    VALUES ($1, $2, $3, $4, false, NOW())
    ON CONFLICT (device_id) DO UPDATE SET
      company_id = EXCLUDED.company_id,
      token_hash = EXCLUDED.token_hash,
      client_version = EXCLUDED.client_version,
      is_revoked = false,
      registered_at = NOW()
  `, [deviceId.trim(), companyId.trim(), tokenHash, clientVersion.trim()]);

  return {
    deviceId: deviceId.trim(),
    companyId: companyId.trim(),
    clientVersion: clientVersion.trim(),
    token: plainToken,
    tokenHash
  };
}

/**
 * Rotates credentials for an existing device.
 * Generates a new 256-bit token and replaces the stored hash.
 *
 * @param {import('pg').Pool} pool
 * @param {object} params
 * @param {string} params.deviceId
 * @param {string} params.companyId
 * @returns {Promise<{ deviceId: string, companyId: string, token: string, tokenHash: string }>}
 */
async function rotateDeviceCredential(pool, params) {
  const { deviceId, companyId } = params;

  const res = await pool.query(
    'SELECT device_id FROM server_devices WHERE device_id = $1 AND company_id = $2',
    [deviceId, companyId]
  );
  if (res.rows.length === 0) {
    throw new Error(`Device not found for rotation: deviceId="${deviceId}", companyId="${companyId}"`);
  }

  const newToken = generateDeviceToken();
  const newTokenHash = hashDeviceToken(newToken);

  await pool.query(`
    UPDATE server_devices
    SET token_hash = $1, is_revoked = false
    WHERE device_id = $2 AND company_id = $3
  `, [newTokenHash, deviceId, companyId]);

  return {
    deviceId,
    companyId,
    token: newToken,
    tokenHash: newTokenHash
  };
}

/**
 * Revokes a device immediately.
 * All subsequent authenticated requests by this device will be rejected with 403 DEVICE_REVOKED.
 *
 * @param {import('pg').Pool} pool
 * @param {object} params
 * @param {string} params.deviceId
 * @param {string} params.companyId
 * @returns {Promise<{ deviceId: string, companyId: string, is_revoked: boolean }>}
 */
async function revokeDevice(pool, params) {
  const { deviceId, companyId } = params;

  const res = await pool.query(`
    UPDATE server_devices
    SET is_revoked = true
    WHERE device_id = $1 AND company_id = $2
    RETURNING device_id, is_revoked
  `, [deviceId, companyId]);

  if (res.rows.length === 0) {
    throw new Error(`Device not found for revocation: deviceId="${deviceId}", companyId="${companyId}"`);
  }

  return {
    deviceId,
    companyId,
    is_revoked: true
  };
}

/**
 * Retrieves registration and revocation status for a device.
 *
 * @param {import('pg').Pool} pool
 * @param {string} deviceId
 * @returns {Promise<object|null>}
 */
async function getDeviceStatus(pool, deviceId) {
  const res = await pool.query(`
    SELECT device_id, company_id, token_hash, client_version, is_revoked, registered_at
    FROM server_devices
    WHERE device_id = $1
  `, [deviceId]);

  return res.rows.length > 0 ? res.rows[0] : null;
}

module.exports = {
  generateDeviceToken,
  hashDeviceToken,
  provisionDevice,
  rotateDeviceCredential,
  revokeDevice,
  getDeviceStatus
};
