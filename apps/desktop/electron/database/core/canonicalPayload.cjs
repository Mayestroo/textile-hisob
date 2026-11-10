'use strict';

const crypto = require('crypto');

/**
 * Deterministically serializes a JavaScript value to canonical JSON.
 *
 * Rules:
 * - Recursively sorts all object keys alphabetically.
 * - Preserves arrays in their stable semantic order.
 * - Removes undefined properties from objects (matching JSON semantics).
 * - Serializes undefined elements in arrays as null.
 * - Rejects Date objects directly (dates must be normalized to ISO strings beforehand).
 * - Rejects BigInt, Function, and Symbol types.
 * - Detects and rejects cyclic objects.
 * - Preserves finite numbers exactly; rejects NaN, Infinity, and -Infinity.
 *
 * @param {unknown} value
 * @param {Set<object>} [seen=new Set()]
 * @returns {string} Canonical JSON representation
 */
function canonicalStringify(value, seen = new Set()) {
  if (value === null) {
    return 'null';
  }

  const valType = typeof value;

  if (valType === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (valType === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`[CanonicalSerializationError] Non-finite number (${value}) cannot be serialized`);
    }
    // Preserves standard numeric JSON representation (e.g. 0, -0 -> 0)
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }

  if (valType === 'string') {
    return JSON.stringify(value);
  }

  if (valType === 'bigint') {
    throw new Error('[CanonicalSerializationError] BigInt values are rejected in canonical payload');
  }

  if (valType === 'function' || valType === 'symbol') {
    throw new Error(`[CanonicalSerializationError] Values of type "${valType}" are rejected in canonical payload`);
  }

  if (value instanceof Date) {
    throw new Error('[CanonicalSerializationError] Date objects are rejected; must be normalized to ISO strings');
  }

  if (valType === 'object') {
    if (seen.has(value)) {
      throw new Error('[CanonicalSerializationError] Cyclic objects are rejected in canonical payload');
    }
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        const items = value.map((item) => {
          if (item === undefined) {
            return 'null';
          }
          return canonicalStringify(item, seen);
        });
        return `[${items.join(',')}]`;
      }

      // Plain object
      const keys = Object.keys(value).sort();
      const parts = [];

      for (const k of keys) {
        const v = value[k];
        if (v === undefined) {
          continue; // omit undefined properties
        }
        const serializedProp = canonicalStringify(v, seen);
        parts.push(`${JSON.stringify(k)}:${serializedProp}`);
      }

      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(value);
    }
  }

  throw new Error(`[CanonicalSerializationError] Unsupported value type: ${valType}`);
}

/**
 * Computes SHA-256 fingerprint from a canonical JSON string.
 *
 * @param {string} canonicalJson
 * @returns {string} 64-character lowercase hex digest
 */
function computePayloadHash(canonicalJson) {
  if (typeof canonicalJson !== 'string') {
    throw new Error('[CanonicalPayloadError] Expected canonicalJson to be a string');
  }
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

module.exports = {
  canonicalStringify,
  computePayloadHash
};
