'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_ATTEMPT_LIMIT = 5;
// This is only used to equalize rejected-login password work. Its plaintext is not stored.
const DUMMY_OPERATOR_PASSWORD_HASH = 'scrypt-v1$N=16384,r=8,p=1$NUmSUan4dO8g2r/NEj7pzA==$TsFam6neOGfHFerrLreuMXWN2K1ENr1IRmd0DxHW0jw9fAXIjQZWP5eNJlN8Q8pehfzwQ0S+mXtObRZxzjj5TQ==';

function hashSessionToken(token) {
  if (!token || typeof token !== 'string') throw new Error('Invalid session token');
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must contain at least 8 characters');
  }
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt-v1$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${Buffer.from(derived).toString('base64')}`;
}

async function verifyPassword(password, encoded) {
  try {
    const [version, params, saltText, digestText] = String(encoded || '').split('$');
    if (version !== 'scrypt-v1' || !params || !saltText || !digestText) return false;
    const values = Object.fromEntries(params.split(',').map((part) => part.split('=')));
    const N = Number(values.N);
    const r = Number(values.r);
    const p = Number(values.p);
    if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
    const actual = await scrypt(password, Buffer.from(saltText, 'base64'), SCRYPT_KEYLEN, { N, r, p });
    const expected = Buffer.from(digestText, 'base64');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function loginAttemptKey(companyId, deviceId, operatorId) {
  if (typeof operatorId !== 'string') throw new Error('operatorId must be a string');
  // server_operators.operator_id is case-sensitive; trim only so DB identity and limiter scope agree.
  return crypto.createHash('sha256').update(`${companyId}\u0000${deviceId}\u0000${operatorId.trim()}`, 'utf8').digest('hex');
}

async function reserveLoginAttempt(pool, companyId, deviceId, operatorId) {
  const key = loginAttemptKey(companyId, deviceId, operatorId);
  // The single UPSERT serializes conflicting primary-key updates across server instances.
  const result = await pool.query(`
    INSERT INTO operator_login_attempts (company_id, device_id, operator_key, failed_count, window_expires_at, updated_at)
    VALUES ($1, $2, $3, 1, NOW() + ($4 * INTERVAL '1 second'), NOW())
    ON CONFLICT (company_id, device_id, operator_key) DO UPDATE SET
      failed_count = CASE
        WHEN operator_login_attempts.window_expires_at <= NOW() THEN 1
        ELSE operator_login_attempts.failed_count + 1
      END,
      window_expires_at = CASE
        WHEN operator_login_attempts.window_expires_at <= NOW() THEN NOW() + ($4 * INTERVAL '1 second')
        ELSE operator_login_attempts.window_expires_at
      END,
      updated_at = NOW()
    RETURNING failed_count, window_expires_at
  `, [companyId, deviceId, key, LOGIN_WINDOW_SECONDS]);
  await pool.query(`DELETE FROM operator_login_attempts WHERE window_expires_at <= NOW()`);
  return Number(result.rows[0]?.failed_count || 1) > LOGIN_ATTEMPT_LIMIT;
}

async function clearLoginAttempt(pool, companyId, deviceId, operatorId) {
  await pool.query(`DELETE FROM operator_login_attempts WHERE company_id = $1 AND device_id = $2 AND operator_key = $3`, [companyId, deviceId, loginAttemptKey(companyId, deviceId, operatorId)]);
}

async function provisionOperator(pool, params) {
  const operatorId = String(params.operatorId || '').trim();
  const companyId = String(params.companyId || '').trim();
  const displayName = String(params.displayName || '').trim();
  const role = String(params.role || '').trim().toLowerCase();
  if (!operatorId || !companyId || !displayName || !['admin', 'accountant'].includes(role)) {
    throw new Error('operatorId, companyId, displayName, and role (admin or accountant) are required');
  }
  const passwordHash = await hashPassword(params.password);
  await pool.query(`
    INSERT INTO server_operators (operator_id, company_id, display_name, role, password_hash, is_active, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())
    ON CONFLICT (operator_id) DO UPDATE SET
      company_id = EXCLUDED.company_id, display_name = EXCLUDED.display_name,
      role = EXCLUDED.role, password_hash = EXCLUDED.password_hash,
      is_active = TRUE, revoked_at = NULL, updated_at = NOW()
  `, [operatorId, companyId, displayName, role, passwordHash]);
  return { operatorId, companyId, displayName, role };
}

async function authenticateOperator(pool, deviceAuth, params, dependencies = {}) {
  const operatorId = typeof params.operatorId === 'string' ? params.operatorId.trim() : '';
  const password = params.password;
  if (!operatorId || typeof password !== 'string') {
    const error = new Error('operatorId and password are required'); error.code = 'OPERATOR_AUTH_REQUIRED'; throw error;
  }
  if (await reserveLoginAttempt(pool, deviceAuth.companyId, deviceAuth.deviceId, operatorId)) {
    const error = new Error('Too many failed operator login attempts'); error.code = 'OPERATOR_LOGIN_THROTTLED'; throw error;
  }
  const result = await pool.query(
    `SELECT operator_id, company_id, display_name, role, password_hash, is_active, revoked_at
     FROM server_operators WHERE operator_id = $1`, [operatorId]
  );
  const row = result.rows[0];
  const eligible = Boolean(row && row.is_active && !row.revoked_at && row.company_id === deviceAuth.companyId);
  const passwordVerifier = dependencies.verifyPassword || verifyPassword;
  const passwordHash = eligible ? row.password_hash : DUMMY_OPERATOR_PASSWORD_HASH;
  const passwordValid = await passwordVerifier(password, passwordHash);
  if (!eligible || !passwordValid) {
    const error = new Error('Invalid operator credentials'); error.code = 'OPERATOR_AUTH_REJECTED'; throw error;
  }
  await clearLoginAttempt(pool, deviceAuth.companyId, deviceAuth.deviceId, operatorId);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(`
    INSERT INTO operator_sessions (session_id, token_hash, operator_id, company_id, device_id, expires_at, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
  `, [crypto.randomUUID(), hashSessionToken(token), row.operator_id, row.company_id, deviceAuth.deviceId, expiresAt]);
  return { token, expiresAt: expiresAt.toISOString(), operatorId: row.operator_id, companyId: row.company_id };
}

async function resolveOperatorSession(pool, token, deviceAuth) {
  if (!token) return null;
  const result = await pool.query(`
    SELECT s.session_id, s.operator_id, s.company_id, s.device_id, s.expires_at, s.revoked_at,
           o.company_id AS current_company_id, o.role AS current_role, o.is_active, o.revoked_at AS operator_revoked_at
    FROM operator_sessions s
    JOIN server_operators o ON o.operator_id = s.operator_id
    WHERE s.token_hash = $1
  `, [hashSessionToken(token)]);
  const row = result.rows[0];
  if (!row || row.revoked_at || row.device_id !== deviceAuth.deviceId || row.company_id !== deviceAuth.companyId ||
      row.current_company_id !== deviceAuth.companyId || !row.is_active || row.operator_revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
    return null;
  }
  return {
    operatorId: row.operator_id,
    companyId: row.current_company_id,
    deviceId: row.device_id,
    role: String(row.current_role).toLowerCase(),
    isActive: Boolean(row.is_active),
    expiresAt: row.expires_at
  };
}

async function revokeOperatorSession(pool, token, deviceAuth) {
  const result = await pool.query(`
    UPDATE operator_sessions SET revoked_at = NOW()
    WHERE token_hash = $1 AND device_id = $2 AND company_id = $3 AND revoked_at IS NULL
    RETURNING session_id
  `, [hashSessionToken(token), deviceAuth.deviceId, deviceAuth.companyId]);
  return result.rows.length > 0;
}

module.exports = {
  SESSION_TTL_MS,
  LOGIN_WINDOW_SECONDS,
  LOGIN_ATTEMPT_LIMIT,
  hashSessionToken,
  hashPassword,
  verifyPassword,
  loginAttemptKey,
  reserveLoginAttempt,
  provisionOperator,
  authenticateOperator,
  resolveOperatorSession,
  revokeOperatorSession
};
