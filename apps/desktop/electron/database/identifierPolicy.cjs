'use strict';

const crypto = require('crypto');

// Base namespace UUID for Novda  deterministic identifier derivation
const NOVDA_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * Creates a custom deterministic SHA-256 UUID-shaped identifier from a namespace and key components.
 * Uses SHA-256 for cryptographic collision resistance and formats into 8-4-4-4-12 UUID layout.
 * Note: RFC-4122 UUIDv5 strictly mandates SHA-1; this implementation intentionally uses SHA-256
 * formatted into a UUID structure for high collision resistance and compatibility.
 *
 * @param {string} namespace
 * @param {...string} components
 * @returns {string} Custom deterministic SHA-256 UUID-shaped identifier
 */
function createDeterministicUuid(namespace, ...components) {
  const seed = `${namespace}:${components.map(c => String(c ?? '')).join(':')}`;
  const hash = crypto.createHash('sha256').update(seed, 'utf8').digest('hex');

  // Format into 8-4-4-4-12 format setting version (5) and variant (RFC4122) bits
  const p1 = hash.slice(0, 8);
  const p2 = hash.slice(8, 12);
  const p3 = '5' + hash.slice(13, 16); // version 5
  const hexVariant = (parseInt(hash.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0');
  const p4 = hexVariant + hash.slice(18, 20);
  const p5 = hash.slice(20, 32);

  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

function createCanonicalEntityUuid(entityType, companyId, oldId) {
  const seed = `${String(entityType)}\u001f${String(companyId)}\u001f${String(oldId)}`;
  const hash = crypto.createHash('md5').update(seed, 'utf8').digest('hex');
  const variantByte = (parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80;
  const variant = variantByte.toString(16).padStart(2, '0');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-3${hash.slice(13, 16)}-${variant}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Derives a deterministic ID for a worker adjustment fact.
 *
 * @param {string} companyId
 * @param {string} type ('AVANS' | 'JARIMA')
 * @param {number|string} workerId
 * @param {string} [periodId='opening']
 * @returns {string}
 */
function getWorkerAdjustmentId(companyId, type, workerId, periodId = 'opening') {
  return createDeterministicUuid(NOVDA_NAMESPACE, 'adj', companyId, type, workerId, periodId);
}

/**
 * Derives a deterministic ID for a ticket entry.
 *
 * @param {string} ticketId
 * @param {number} entryIndex
 * @param {string} opName
 * @param {number|string} workerId
 * @returns {string}
 */
function getTicketEntryId(ticketId, entryIndex, opName, workerId) {
  return createDeterministicUuid(NOVDA_NAMESPACE, 'entry', ticketId, entryIndex, opName, workerId);
}

/**
 * Derives a deterministic ID for a migration reconciliation candidate (unexplained hisob difference).
 *
 * @param {string} companyId
 * @param {string} modelId
 * @param {number|string} workerId
 * @param {string} opName
 * @returns {string}
 */
function getReconciliationCandidateId(companyId, modelId, workerId, opName) {
  return createDeterministicUuid(NOVDA_NAMESPACE, 'reconcile_cand', companyId, modelId, workerId, opName);
}

/**
 * Derives a deterministic ID for quarantine items.
 *
 * @param {string} entityType ('party' | 'ticket' | 'entry')
 * @param {string} companyId
 * @param {string} legacyKey
 * @returns {string}
 */
function getQuarantineId(entityType, companyId, legacyKey) {
  return createDeterministicUuid(NOVDA_NAMESPACE, 'quarantine', entityType, companyId, legacyKey);
}

/**
 * Preserves a legacy ID if valid non-empty string or number, otherwise derives a deterministic fallback.
 *
 * @param {any} legacyId
 * @param {string} fallbackEntity
 * @param {...any} fallbackComponents
 * @returns {string}
 */
function resolveEntityId(legacyId, fallbackEntity, ...fallbackComponents) {
  if (legacyId !== null && legacyId !== undefined) {
    const str = String(legacyId).trim();
    if (str.length > 0) {
      return str;
    }
  }
  return createDeterministicUuid(NOVDA_NAMESPACE, fallbackEntity, ...fallbackComponents);
}

module.exports = {
  NOVDA_NAMESPACE,
  createDeterministicUuid,
  createCanonicalEntityUuid,
  getWorkerAdjustmentId,
  getTicketEntryId,
  getReconciliationCandidateId,
  getQuarantineId,
  resolveEntityId
};
