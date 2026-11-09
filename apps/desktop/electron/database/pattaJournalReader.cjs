'use strict';

const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');

function parseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Reads deterministic journal source facts for a company from local SQLite.
 * Preserves strict separation from open-period payroll hydration.
 * Includes hidden parties for all-time lookup and verified frozen archive facts.
 */
function readPattaJournalFacts(db, companyId, options = {}) {
  const mode = options.mode || 'current';
  const archivePeriodId = options.archivePeriodId || null;

  // 1. Read all parties (including is_archived = 1 for historical lifecycle resolution)
  const partyRows = db.prepare(`
    SELECT p.id, p.company_id, p.party_number,
           COALESCE(a.canonical_model_id, p.model_id) AS model_id,
           p.model_name, p.color,
           p.patta_count, p.cumulative_patta_count, p.ish_soni_per_patta,
           p.total_ish_soni, p.ish_soni, p.cumulative_ish_soni, p.sizes_json, p.size_order_json,
           p.printed_at, p.is_closed, p.closed_at, p.ended_at, p.ended_operation_id,
           p.month_closed_period_id, p.archived_patta_numbers_json, p.is_archived,
           p.status, p.server_revision,
           COALESCE(p.patta_start_number, r.patta_start_number) AS patta_start_number,
           COALESCE(p.patta_end_number, r.patta_end_number) AS patta_end_number
    FROM parties p
    LEFT JOIN model_id_aliases a ON a.company_id = p.company_id AND a.legacy_model_id = p.model_id
    LEFT JOIN protected_party_patta_ranges r ON r.company_id = p.company_id AND r.party_record_id = p.id
    WHERE p.company_id = ?
    ORDER BY p.created_at ASC, p.id ASC
  `).all(companyId);

  const parties = partyRows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    partyNumber: row.party_number,
    modelId: row.model_id,
    modelName: row.model_name || '',
    color: row.color || '',
    pattaCount: Number(row.patta_count || 0),
    cumulativePattaCount: Number(row.cumulative_patta_count || 0),
    pattaStartNumber: row.patta_start_number === null ? undefined : Number(row.patta_start_number),
    pattaEndNumber: row.patta_end_number === null ? undefined : Number(row.patta_end_number),
    ishSoniPerPatta: row.ish_soni_per_patta === null ? undefined : Number(row.ish_soni_per_patta),
    totalIshSoni: row.total_ish_soni === null ? undefined : Number(row.total_ish_soni),
    ishSoni: Number(row.ish_soni || 0),
    cumulativeIshSoni: Number(row.cumulative_ish_soni || 0),
    sizes: parseJson(row.sizes_json, {}),
    ...(row.size_order_json == null ? {} : { sizeOrder: parseJson(row.size_order_json, []) }),
    printedAt: row.printed_at || undefined,
    isClosed: Boolean(row.is_closed) || row.status === 'CLOSED',
    closedAt: row.closed_at || undefined,
    endedAt: row.ended_at || null,
    endedOperationId: row.ended_operation_id || null,
    monthClosedPeriodId: row.month_closed_period_id || null,
    archivedPattaNumbers: parseJson(row.archived_patta_numbers_json, []),
    isArchived: Boolean(row.is_archived),
    serverRevision: Number(row.server_revision || 0)
  }));

  // 2. Read periods
  const periodRows = db.prepare(`
    SELECT id, company_id, name, start_date, end_date, is_closed, closed_at,
           close_operation_id, notes, archive_filename, status, server_revision
    FROM periods
    WHERE company_id = ?
    ORDER BY start_date DESC, id DESC
  `).all(companyId);

  // 3. Load verified frozen archives for closed periods
  const archiveRows = db.prepare(`
    SELECT period_id, archive_json, sha256 FROM period_archives WHERE company_id = ?
  `).all(companyId);

  const archiveByPeriodId = new Map();
  for (const row of archiveRows) {
    const data = parseJson(row.archive_json, null);
    if (!data) continue;
    const computedHash = computePayloadHash(canonicalStringify(data));
    if (computedHash === row.sha256) {
      archiveByPeriodId.set(row.period_id, { data, sha256: row.sha256 });
    }
  }

  const periods = periodRows.map((row) => {
    const archiveInfo = archiveByPeriodId.get(row.id);
    const archivedTickets = archiveInfo?.data?.submittedTickets || [];
    const archivedTicketIds = archivedTickets.map((t) => t.id).filter(Boolean);
    return {
      id: row.id,
      name: row.name,
      startDate: row.start_date,
      endDate: row.end_date || undefined,
      isClosed: Boolean(row.is_closed),
      closedAt: row.closed_at || undefined,
      closeOperationId: row.close_operation_id || null,
      notes: row.notes || undefined,
      archiveFilename: row.archive_filename || undefined,
      archivedTicketIds,
      serverRevision: Number(row.server_revision || 0)
    };
  });

  // 4. Read tickets: union deduplicated tickets
  // Frozen archive tickets win for closed periods; live tickets supply open/pending facts
  const ticketMap = new Map();

  // First, add all closed period archive tickets (frozen authority)
  for (const [periodId, archiveInfo] of archiveByPeriodId.entries()) {
    const archivedTickets = archiveInfo.data?.submittedTickets || [];
    for (const at of archivedTickets) {
      if (!at.id) continue;
      ticketMap.set(at.id, {
        id: at.id,
        companyId,
        modelId: at.modelId,
        partyNumber: String(at.partyNumber || ''),
        partyRecordId: at.partyRecordId || null,
        pattaNumber: Number(at.pattaNumber || 0),
        periodId: at.periodId || periodId,
        status: at.status || 'CONFIRMED',
        qty: Number.isFinite(at.qty) ? Number(at.qty) : null,
        size: at.size || '',
        color: at.color || '',
        isClosed: true,
        submittedAt: at.submittedAt || ''
      });
    }
  }

  // Next, overlay or insert canonical tickets from SQLite
  const liveTicketRows = db.prepare(`
    SELECT t.id, t.company_id, t.model_id, t.party_number, t.party_record_id,
           t.patta_number, t.period_id, t.status, t.qty, t.size, t.color,
           t.is_closed, t.submitted_at, t.server_revision
    FROM tickets t
    WHERE t.company_id = ?
    ORDER BY t.submitted_at ASC, t.id ASC
  `).all(companyId);

  for (const lt of liveTicketRows) {
    if (!lt.id) continue;
    const existing = ticketMap.get(lt.id);
    if (!existing) {
      ticketMap.set(lt.id, {
        id: lt.id,
        companyId: lt.company_id,
        modelId: lt.model_id,
        partyNumber: String(lt.party_number || ''),
        partyRecordId: lt.party_record_id || null,
        pattaNumber: Number(lt.patta_number || 0),
        periodId: lt.period_id || null,
        status: lt.status || 'CONFIRMED',
        qty: lt.qty === null ? null : Number(lt.qty),
        size: lt.size || '',
        color: lt.color || '',
        isClosed: Boolean(lt.is_closed),
        submittedAt: lt.submitted_at || ''
      });
    } else {
      // If live ticket has partyRecordId and archive lacked it, enrich partyRecordId only
      if (!existing.partyRecordId && lt.party_record_id) {
        existing.partyRecordId = lt.party_record_id;
      }
    }
  }

  // 5. Read local pending effects
  const pendingOutbox = db.prepare(`
    SELECT operation_id, command_type, entity_id, payload_json, local_archive_json, status
    FROM local_outbox
    WHERE company_id = ? AND status IN ('PENDING', 'SENDING')
    ORDER BY rowid ASC
  `).all(companyId);

  const pendingFinishOps = pendingOutbox.filter((op) => op.command_type === 'CompletePartySeries');
  const pendingCloseOps = pendingOutbox.filter((op) => op.command_type === 'ClosePeriod');

  return {
    companyId,
    mode,
    archivePeriodId,
    parties,
    periods,
    tickets: Array.from(ticketMap.values()),
    pendingEffects: {
      hasPendingFinish: pendingFinishOps.length > 0,
      hasPendingClose: pendingCloseOps.length > 0,
      pendingFinishOpIds: pendingFinishOps.map((op) => op.operation_id),
      pendingClosePeriodIds: pendingCloseOps.map((op) => op.entity_id)
    }
  };
}

module.exports = {
  readPattaJournalFacts
};

