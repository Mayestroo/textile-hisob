'use strict';

// Entry identity is part of the desktop/server contract, not a projection detail.
function ticketEntryId(ticketId, index) {
  return `${ticketId}_entry_${index + 1}`;
}

function legacyLocalTicketEntryId(ticketId, index, opName, workerId) {
  return `entry_${ticketId}_${index}_${opName}_${workerId}`;
}

module.exports = { ticketEntryId, legacyLocalTicketEntryId };
