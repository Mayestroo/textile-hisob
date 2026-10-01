'use strict';

const crypto = require('crypto');
const { checkClientVersionFence } = require('../modules/sync/versionFence.cjs');
const { resolveOperatorSession } = require('./operatorAuth.cjs');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/**
 * Server Authentication Middleware.
 *
 * Resolves:
 * - Device identity
 * - Company scope (authoritative tenant boundary)
 * - Client version verification (write fence)
 *
 * Device authentication is always required. Operator sessions are resolved
 * separately and are only used as a server-side context for sensitive calls.
 *
 * Fails closed on:
 * - Missing/invalid authorization credentials (401 AUTH_REQUIRED)
 * - Revoked device (403 DEVICE_REVOKED)
 * - Client version below minimum supported  writer (426 CLIENT_VERSION_TOO_OLD)
 *
 * @param {import('pg').Pool} pool
 * @param {object} [options={}]
 * @param {string} [options.minClientVersion]
 * @param {boolean} [options.allowTestTokens=false]
 */
function createAuthMiddleware(pool, options = {}) {
  const allowTestTokens = options.allowTestTokens === true;

  return async function authenticateRequest(req, reply) {
    // 1. Extract credentials from headers
    const authHeader = req.headers['authorization'] || '';
    let token = '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (req.headers['x-device-token']) {
      token = String(req.headers['x-device-token']).trim();
    }

    if (!token) {
      reply.code(401).send({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required. Missing Bearer token or x-device-token.' }
      });
      return reply;
    }

    const deviceIdHeader = req.headers['x-device-id'] ? String(req.headers['x-device-id']).trim() : null;
    const clientVersionHeader = req.headers['x-client-version'] ? String(req.headers['x-client-version']).trim() : '2.0.0';

    // 2. Check client version fence first
    try {
      checkClientVersionFence(clientVersionHeader, options.minClientVersion);
    } catch (fenceErr) {
      reply.code(fenceErr.statusCode || 426).send({
        success: false,
        error: {
          code: fenceErr.code || 'CLIENT_VERSION_TOO_OLD',
          message: fenceErr.message,
          minVersion: fenceErr.minVersion,
          clientVersion: fenceErr.clientVersion
        }
      });
      return reply;
    }

    // 3. Resolve device & company context
    // Test token pattern is ONLY evaluated if allowTestTokens is explicitly enabled (test harness opt-in)
    if (allowTestTokens && token.startsWith('novda-test-token:')) {
      const parts = token.split(':');
      if (parts.length === 3 && parts[1].trim() && parts[2].trim()) {
        const companyId = parts[1].trim();
        const deviceId = parts[2].trim();
      req.auth = {
          companyId,
          deviceId,
          clientVersion: clientVersionHeader
        };
        await attachOperatorContext(pool, req);
        return;
      }

      // Malformed test token under allowTestTokens: fail closed
      reply.code(401).send({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Malformed test authentication token' }
      });
      return reply;
    }

    // Second, query server_devices table in PostgreSQL
    const tokenHash = hashToken(token);
    let deviceRow = null;

    try {
      const res = await pool.query(
        `SELECT device_id, company_id, client_version, is_revoked 
         FROM server_devices 
         WHERE token_hash = $1`,
        [tokenHash]
      );
      if (res.rows.length > 0) {
        deviceRow = res.rows[0];
      }
    } catch (dbErr) {
      reply.code(500).send({
        success: false,
        error: { code: 'AUTH_DATABASE_ERROR', message: 'Failed to verify credentials' }
      });
      return reply;
    }

    if (!deviceRow) {
      reply.code(401).send({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Invalid or unrecognized authentication token' }
      });
      return reply;
    }

    if (deviceRow.is_revoked) {
      reply.code(403).send({
        success: false,
        error: { code: 'DEVICE_REVOKED', message: 'This device credentials have been revoked' }
      });
      return reply;
    }

    req.auth = {
      companyId: deviceRow.company_id,
      deviceId: deviceRow.device_id,
      clientVersion: clientVersionHeader
    };
    await attachOperatorContext(pool, req);
  };
}

async function attachOperatorContext(pool, req) {
  const operatorToken = req.headers['x-operator-token'] ? String(req.headers['x-operator-token']).trim() : '';
  if (!operatorToken) return;
  try {
    req.auth.operator = await resolveOperatorSession(pool, operatorToken, req.auth);
  } catch (err) {
    const authErr = new Error('Failed to verify operator session');
    authErr.statusCode = 500;
    authErr.code = 'OPERATOR_AUTH_DATABASE_ERROR';
    throw authErr;
  }
}

/**
 * Validates that the request payload companyId strictly matches the authenticated companyId.
 * Fails closed with 403 COMPANY_SCOPE_MISMATCH if they do not match.
 */
function validateCompanyScope(req, payloadCompanyId) {
  if (!req.auth || !req.auth.companyId) {
    const err = new Error('Unauthenticated request context');
    err.statusCode = 401;
    err.code = 'AUTH_REQUIRED';
    throw err;
  }

  if (payloadCompanyId && payloadCompanyId !== req.auth.companyId) {
    const err = new Error(
      `Authenticated company context ("${req.auth.companyId}") does not match request companyId ("${payloadCompanyId}")`
    );
    err.statusCode = 403;
    err.code = 'COMPANY_SCOPE_MISMATCH';
    throw err;
  }
}

module.exports = {
  hashToken,
  createAuthMiddleware,
  validateCompanyScope
};
