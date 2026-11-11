'use strict';

const { canonicalStringify, computePayloadHash } = require('../core/canonicalPayload.cjs');

function validatePeriodArchive(archive, sha256, companyId, periodId, options = {}) {
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) return 'ARCHIVE_INVALID_JSON';
  let computed;
  try { computed = computePayloadHash(canonicalStringify(archive)); } catch { return 'ARCHIVE_INVALID_JSON'; }
  if (!/^[a-f0-9]{64}$/.test(sha256 || '') || computed !== sha256) {
    return 'ARCHIVE_DIGEST_MISMATCH';
  }
  const legacyBound = options.binding === 'authenticated-request-scope' || options.binding === 'retained-local-owner';
  const matchesOptionalOwner = (value) => value === companyId || (legacyBound && value === undefined);
  if (!archive.period || typeof archive.period !== 'object' || Array.isArray(archive.period) ||
      !matchesOptionalOwner(archive.companyId) || !matchesOptionalOwner(archive.period.companyId) || archive.period.id !== periodId) {
    return 'ARCHIVE_IDENTITY_MISMATCH';
  }
  if (!Array.isArray(archive.submittedTickets) || !Array.isArray(archive.printedPartyHistory)) {
    return 'ARCHIVE_COLLECTIONS_UNAVAILABLE';
  }
  if (archive.submittedTickets.some((ticket) => !ticket || typeof ticket !== 'object' || Array.isArray(ticket) ||
      typeof ticket.id !== 'string' || !ticket.id.trim() ||
      !Number.isSafeInteger(Number(ticket.pattaNumber)) || Number(ticket.pattaNumber) < 0 ||
      !Number.isFinite(Number(ticket.qty)) || (ticket.status !== undefined &&
        (typeof ticket.status !== 'string' || !ticket.status.trim())))) return 'ARCHIVE_TICKET_MALFORMED';
  if (archive.printedPartyHistory.some((party) => !party || typeof party !== 'object' || Array.isArray(party) ||
      !((typeof party.id === 'string' && party.id.trim()) || (typeof party.partyRecordId === 'string' && party.partyRecordId.trim())))) {
    return 'ARCHIVE_HISTORY_FACT_MALFORMED';
  }
  const canonicalById = new Map((options.canonicalTickets || []).filter((ticket) => ticket?.id)
    .map((ticket) => [ticket.id, ticket]));
  const duplicateById = new Map();
  for (const ticket of archive.submittedTickets) {
    if (!matchesOptionalOwner(ticket.companyId)) return 'ARCHIVE_CONTAINED_FACT_MISMATCH';
    const resolved = classifyArchiveTicket(ticket, companyId, periodId, canonicalById.get(ticket.id));
    if (resolved.problem) return resolved.problem;
    const previous = duplicateById.get(ticket.id);
    if (previous && canonicalStringify(previous) !== canonicalStringify(ticket)) return 'ARCHIVE_TICKET_DUPLICATE_CONFLICT';
    duplicateById.set(ticket.id, ticket);
  }
  if (archive.printedPartyHistory.some((party) => !matchesOptionalOwner(party.companyId))) return 'ARCHIVE_CONTAINED_FACT_MISMATCH';
  return null;
}

function classifyArchiveTicket(ticket, companyId, periodId, canonicalTicket = null) {
  if (ticket.periodId !== undefined && ticket.periodId !== null && ticket.periodId !== periodId) {
    return { problem: 'ARCHIVE_CONTAINED_FACT_MISMATCH' };
  }
  const exactCanonical = canonicalTicket?.company_id === companyId && canonicalTicket.period_id === periodId &&
    sameCanonicalTicket(ticket, canonicalTicket);
  if ((ticket.periodId === undefined || ticket.periodId === null) && !exactCanonical) {
    return { problem: 'ARCHIVE_TICKET_PERIOD_UNKNOWN' };
  }
  const statusInherited = ticket.status === undefined && exactCanonical && typeof canonicalTicket.status === 'string';
  return {
    ticketId: ticket.id,
    periodId: ticket.periodId === undefined || ticket.periodId === null ? periodId : ticket.periodId,
    ...(ticket.periodId === undefined || ticket.periodId === null
      ? { periodMembershipSource: 'canonical-ticket-exact-match' } : {}),
    status: statusInherited ? canonicalTicket.status : (ticket.status === undefined ? 'UNKNOWN' : ticket.status),
    statusSource: statusInherited ? 'canonical-ticket-exact-match' :
      (ticket.status === undefined ? 'unknown' : 'archive-explicit')
  };
}

function readCanonicalPeriodTickets(db, companyId, periodId) {
  const tickets = db.prepare(`SELECT id, company_id, model_id, party_number, party_record_id, patta_number,
    period_id, status, qty, size, color, submitted_at, is_closed FROM tickets WHERE company_id = ? AND period_id = ?`).all(companyId, periodId);
  // Old free-mode tickets legitimately have no printed party on either side.
  // Corroborate their immutable work, not a guessed party/date-range association.
  if (tickets.some(ticket => ticket.party_record_id == null)
    && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ticket_entries'").get()) {
    const entries = db.prepare(`SELECT e.ticket_id, e.op_name, e.worker_id, e.rate_snapshot, e.brak
      FROM ticket_entries e JOIN tickets t ON t.company_id=e.company_id AND t.id=e.ticket_id
      WHERE t.company_id=? AND t.period_id=?`).all(companyId, periodId);
    const byTicket = new Map();
    for (const entry of entries) {
      if (!byTicket.has(entry.ticket_id)) byTicket.set(entry.ticket_id, []);
      byTicket.get(entry.ticket_id).push(entry);
    }
    for (const ticket of tickets) ticket.historicalEntries = byTicket.get(ticket.id) || [];
  }
  return tickets;
}

function sameUnprintedHistoricalWork(ticket, canonical) {
  if (ticket.partyRecordId != null || canonical.party_record_id != null || !canonical.is_closed
    || !['CONFIRMED', 'VOIDED'].includes(canonical.status) || (ticket.status !== undefined && ticket.status !== canonical.status)
    || typeof ticket.modelId !== 'string' || ticket.modelId !== canonical.model_id
    || ticket.partyNumber == null || String(ticket.partyNumber) !== String(canonical.party_number)
    || !Number.isFinite(Date.parse(ticket.submittedAt))
    || Date.parse(ticket.submittedAt) !== Date.parse(canonical.submitted_at)
    || !Array.isArray(ticket.entries) || !ticket.entries.length || !Array.isArray(canonical.historicalEntries)) return false;
  const frozen = ticket.entries.map(entry => canonicalStringify([
    entry.opName, entry.workerId, entry.rateSnapshot ?? null, entry.brak || null
  ])).sort();
  const retained = canonical.historicalEntries.map(entry => canonicalStringify([
    entry.op_name, entry.worker_id, entry.rate_snapshot ?? null, entry.brak || null
  ])).sort();
  return canonicalStringify(frozen) === canonicalStringify(retained);
}

function sameCanonicalTicket(archiveTicket, canonical) {
  const sameIfPresent = (archiveValue, canonicalValue) => archiveValue === undefined || archiveValue === null ||
    String(archiveValue) === String(canonicalValue);
  const sameRequired = (archiveValue, canonicalValue) => archiveValue !== undefined && archiveValue !== null &&
    String(archiveValue) === String(canonicalValue);
  return sameRequired(archiveTicket.id, canonical.id) && sameIfPresent(archiveTicket.modelId, canonical.model_id) &&
    sameIfPresent(archiveTicket.partyNumber, canonical.party_number) &&
    (sameRequired(archiveTicket.partyRecordId, canonical.party_record_id) || sameUnprintedHistoricalWork(archiveTicket, canonical)) &&
    Number(archiveTicket.pattaNumber) === Number(canonical.patta_number) && Number(archiveTicket.qty) === Number(canonical.qty);
}

module.exports = { validatePeriodArchive, sameCanonicalTicket, classifyArchiveTicket, readCanonicalPeriodTickets };
