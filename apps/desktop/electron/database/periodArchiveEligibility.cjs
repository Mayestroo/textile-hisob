'use strict';

/** Shared local journal/IPC admission for retained archive rows. */
function classifyRetainedPeriodArchive({ outboxRows = [], period, archiveSha256, acceptedSha256 }) {
  if (outboxRows.length > 1) return { eligible: false, problem: 'ARCHIVE_CLOSE_CONTEXT_AMBIGUOUS' };
  if (outboxRows.length === 0) {
    return { eligible: true, provenance: 'UNKNOWN_RETAINED_ARCHIVE', closeCertificate: 'UNKNOWN' };
  }
  const close = outboxRows[0];
  let record;
  try { record = JSON.parse(close.local_archive_json); }
  catch { return { eligible: false, problem: 'ARCHIVE_CLOSE_CONTEXT_MALFORMED' }; }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { eligible: false, problem: 'ARCHIVE_CLOSE_CONTEXT_MALFORMED' };
  }
  if (record.kind === 'period-close-effects') {
    if (close.status !== 'SYNCED' || close.operation_id !== period?.close_operation_id ||
        !acceptedSha256 || acceptedSha256 !== archiveSha256) {
      return { eligible: false, problem: 'PERIOD_ARCHIVE_AWAITING_AUTHORITY' };
    }
    return { eligible: true, provenance: 'ACCEPTED_TAGGED_CLOSE', closeCertificate: 'LOCAL_ACCEPTED_MARKER_ONLY' };
  }
  if (close.status !== 'SYNCED') {
    return { eligible: false, problem: 'PERIOD_ARCHIVE_CLOSE_NOT_SYNCED' };
  }
  return { eligible: true, provenance: 'LEGACY_RETAINED_UNVERIFIED', closeCertificate: 'UNKNOWN' };
}

module.exports = { classifyRetainedPeriodArchive };
