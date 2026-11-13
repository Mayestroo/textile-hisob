'use strict';

// Before print-settings CAS, completed batches captured the printed range as
// cumulativePattaCount (the last printed number). Never invent a new range for
// already printed paper when replaying that immutable command.
function isLegacyPattaBatch(payload) {
  return payload?.batchSettingsBaseRevision == null;
}

function capturedPattaRange(party) {
  const count = party?.pattaCount;
  const end = party?.cumulativePattaCount;
  const start = end - count + 1;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(start) || start < 1
    || (party.pattaStartNumber != null && party.pattaStartNumber !== start)
    || (party.pattaEndNumber != null && party.pattaEndNumber !== end)) return null;
  return { start, end };
}

module.exports = { isLegacyPattaBatch, capturedPattaRange };
