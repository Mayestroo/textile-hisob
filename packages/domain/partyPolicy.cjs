'use strict';

function isAllowedGrandfatheredPair(rows, candidate) {
  if (!Array.isArray(rows) || !candidate || !candidate.collision_group_id) return false;
  const otherActiveRows = rows.filter((row) =>
    row && row.id !== candidate.id
    && row.company_id === candidate.company_id
    && row.party_number === candidate.party_number
    && typeof row.status === 'string'
    && row.status !== 'CLOSED'
  );
  return otherActiveRows.length === 1
    && otherActiveRows[0].collision_group_id === candidate.collision_group_id
    && otherActiveRows[0].collision_group_id !== null
    && otherActiveRows[0].status !== 'CLOSED';
}

module.exports = {
  isAllowedGrandfatheredPair
};
