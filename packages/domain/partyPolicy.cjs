'use strict';

const EXACT_PARTY_TWO_IDS = Object.freeze([
  'rec_1788774889449_vrbkv',
  'rec_1788930871307_cg1iv'
]);
const EXACT_PARTY_TWO_COMPANY_ID = 'comp_novda';

function isExactPartyTwoId(id) {
  return typeof id === 'string' && EXACT_PARTY_TWO_IDS.includes(id);
}

function isPersistedExactPartyTwoRow(row) {
  return Boolean(row) &&
    isExactPartyTwoId(row.id) &&
    row.company_id === EXACT_PARTY_TWO_COMPANY_ID &&
    row.party_number === '2' &&
    typeof row.status === 'string' && row.status !== 'CLOSED';
}

/**
 * Checks whether a candidate and the already persisted rows form the exact
 * historical Party #2 pair. Exception-table metadata is deliberately absent.
 */
function isAllowedGrandfatheredPair(rows, candidate) {
  if (!isPersistedExactPartyTwoRow(candidate) || !Array.isArray(rows)) return false;

  const otherActiveRows = rows.filter((row) =>
    row &&
    row.id !== candidate.id &&
    row.company_id === candidate.company_id &&
    row.party_number === '2' &&
    typeof row.status === 'string' &&
    row.status !== 'CLOSED'
  );

  return otherActiveRows.length === 1 && isPersistedExactPartyTwoRow(otherActiveRows[0]);
}

// Migration 010 is immutable and historically allowed the exact IDs under any
// company key. Migration 012 replaces that policy for new/current databases.
function isAllowedLegacyGrandfatheredPair(rows, candidate) {
  if (!candidate || !isExactPartyTwoId(candidate.id)
    || typeof candidate.company_id !== 'string' || !candidate.company_id
    || candidate.party_number !== '2'
    || typeof candidate.status !== 'string' || candidate.status === 'CLOSED'
    || !Array.isArray(rows)) return false;

  const otherActiveRows = rows.filter((row) =>
    row && row.id !== candidate.id && row.company_id === candidate.company_id
    && row.party_number === '2' && typeof row.status === 'string' && row.status !== 'CLOSED'
  );
  return otherActiveRows.length === 1
    && isExactPartyTwoId(otherActiveRows[0].id)
    && otherActiveRows[0].status !== 'CLOSED';
}

module.exports = {
  EXACT_PARTY_TWO_IDS,
  EXACT_PARTY_TWO_COMPANY_ID,
  isExactPartyTwoId,
  isAllowedGrandfatheredPair,
  isAllowedLegacyGrandfatheredPair
};
