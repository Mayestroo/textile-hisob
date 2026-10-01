'use strict';

const crypto = require('crypto');

/**
 * Deterministically serializes a value into canonical JSON format.
 * - Object keys sorted lexicographically
 * - Undefined object values omitted
 * - Numbers serialized deterministically
 */
function canonicalStringify(val) {
  if (val === null || val === undefined) {
    return 'null';
  }
  const type = typeof val;
  if (type === 'number') {
    if (!Number.isFinite(val)) {
      throw new TypeError('Cannot canonicalize non-finite number');
    }
    return String(val);
  }
  if (type === 'boolean') {
    return val ? 'true' : 'false';
  }
  if (type === 'string') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    const items = val.map((item) => canonicalStringify(item === undefined ? null : item));
    return '[' + items.join(',') + ']';
  }
  if (type === 'object') {
    const sortedKeys = Object.keys(val)
      .filter((k) => val[k] !== undefined)
      .sort();
    const entries = sortedKeys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(val[k]));
    return '{' + entries.join(',') + '}';
  }
  throw new TypeError(`Cannot canonicalize unsupported type: ${type}`);
}

/**
 * Computes SHA-256 digest of canonical payload string.
 * @param {string} canonicalStr
 * @returns {string} 64-character lowercase hex digest
 */
function computePayloadHash(canonicalStr) {
  return crypto.createHash('sha256').update(canonicalStr, 'utf8').digest('hex').toLowerCase();
}

module.exports = {
  canonicalStringify,
  computePayloadHash
};
