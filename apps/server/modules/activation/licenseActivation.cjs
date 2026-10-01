'use strict';

const crypto = require('crypto');
const { NOVDA_LICENSE_ED25519_PUBLIC_KEY } = require('../../../../packages/contracts/keys/licensePublicKey.cjs');

const PINNED_PUBLIC_KEY_FINGERPRINT = '8b563c50537fc5b44852626f8da69bb69c1ce4a72d3dec3ae0af20a557bf314c';
const ACTIVATION_FIELDS = Object.freeze([
  'activationId',
  'companyId',
  'companyName',
  'expiresAt',
  'issuedAt',
  'machineId',
  'requireTicketValidation',
  'role',
  'schema',
  'status'
]);
const VALID_ROLES = new Set(['admin', 'type', 'print']);

function canonicalActivationPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Activation payload must be an object');
  }
  return JSON.stringify(Object.fromEntries(ACTIVATION_FIELDS.map((field) => [field, payload[field]])));
}

function publicKeyFingerprint(publicKey = NOVDA_LICENSE_ED25519_PUBLIC_KEY) {
  const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function getPinnedPublicKey() {
  if (publicKeyFingerprint() !== PINNED_PUBLIC_KEY_FINGERPRINT) {
    const error = new Error('PINNED_LICENSE_PUBLIC_KEY_FINGERPRINT_MISMATCH');
    error.code = 'PINNED_LICENSE_PUBLIC_KEY_FINGERPRINT_MISMATCH';
    throw error;
  }
  return NOVDA_LICENSE_ED25519_PUBLIC_KEY;
}

function isIsoDate(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function verifySignedActivation(signedActivation, expected, publicKey = getPinnedPublicKey()) {
  const payload = signedActivation?.payload;
  const signature = signedActivation?.signature;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload).sort();
  if (keys.length !== ACTIVATION_FIELDS.length || keys.some((key, index) => key !== [...ACTIVATION_FIELDS].sort()[index])) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.activationId || '')) return false;
  if (payload.schema !== 'novda-license-v1' || !VALID_ROLES.has(payload.role)) return false;
  if (typeof payload.companyId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.companyId)) return false;
  if (typeof payload.companyName !== 'string' || !payload.companyName.trim() || payload.companyName.length > 160) return false;
  if (typeof payload.machineId !== 'string' || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(payload.machineId)) return false;
  if (!isIsoDate(payload.issuedAt)) return false;
  if (payload.expiresAt !== null && (!isIsoDate(payload.expiresAt) || Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt))) return false;
  if (typeof payload.requireTicketValidation !== 'boolean') return false;
  if (payload.status !== 'active' && payload.status !== 'revoked') return false;
  if (expected && Object.entries(expected).some(([field, value]) => payload[field] !== value)) return false;
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;

  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature) return false;
    return crypto.verify(null, Buffer.from(canonicalActivationPayload(payload), 'utf8'), publicKey, signatureBytes);
  } catch {
    return false;
  }
}

module.exports = {
  ACTIVATION_FIELDS,
  PINNED_PUBLIC_KEY_FINGERPRINT,
  canonicalActivationPayload,
  publicKeyFingerprint,
  getPinnedPublicKey,
  verifySignedActivation
};
