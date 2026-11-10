'use strict';

const crypto = require('crypto');

const SESSION_SECONDS = 15 * 60;
const FUTURE_SKEW_SECONDS = 60;
const TELEGRAM_ID_PATTERN = /^\d{1,24}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function adminWebAuthError(code, statusCode = 401) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw adminWebAuthError('ADMIN_SESSION_INVALID');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw adminWebAuthError('ADMIN_SESSION_INVALID');
  return decoded;
}

function verifyAdminWebSession(token, sessionSecret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const secret = typeof sessionSecret === 'string' ? sessionSecret : '';
  if (typeof token !== 'string' || token.length > 4096 || Buffer.byteLength(secret, 'utf8') < 32) {
    throw adminWebAuthError('ADMIN_SESSION_INVALID');
  }
  const parts = token.split('.');
  if (parts.length !== 2) throw adminWebAuthError('ADMIN_SESSION_INVALID');
  const [encodedClaims, encodedSignature] = parts;
  const suppliedSignature = decodeBase64Url(encodedSignature);
  const expectedSignature = crypto.createHmac('sha256', secret).update(encodedClaims, 'ascii').digest();
  if (suppliedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw adminWebAuthError('ADMIN_SESSION_INVALID');
  }

  let claims;
  try {
    claims = JSON.parse(decodeBase64Url(encodedClaims).toString('utf8'));
  } catch (error) {
    if (error?.code === 'ADMIN_SESSION_INVALID') throw error;
    throw adminWebAuthError('ADMIN_SESSION_INVALID');
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)
      || Object.keys(claims).sort().join(',') !== 'exp,iat,nonce,sub'
      || !TELEGRAM_ID_PATTERN.test(String(claims.sub || ''))
      || !Number.isSafeInteger(claims.iat)
      || !Number.isSafeInteger(claims.exp)
      || claims.exp - claims.iat !== SESSION_SECONDS
      || typeof claims.nonce !== 'string'
      || claims.nonce.length < 16) {
    throw adminWebAuthError('ADMIN_SESSION_INVALID');
  }
  if (!Number.isSafeInteger(nowSeconds) || claims.iat > nowSeconds + FUTURE_SKEW_SECONDS) {
    throw adminWebAuthError('ADMIN_SESSION_INVALID');
  }
  if (nowSeconds >= claims.exp) throw adminWebAuthError('ADMIN_SESSION_EXPIRED');
  const telegramId = String(claims.sub);
  return { telegramId, expiresAt: claims.exp };
}

module.exports = {
  SESSION_SECONDS,
  adminWebAuthError,
  verifyAdminWebSession
};
