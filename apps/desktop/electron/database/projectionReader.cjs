'use strict';

/**
 * SQLite Projection Read Adapter (Narrow Test/Verification Seam)
 * Phase 2 — Step 2
 *
 * Provides read-only fact extraction from Step 1 SQLite database for parity
 * verification and deterministic projection testing.
 *
 * This module is read-only. It does not redirect legacy JSON reads or write
 * projection caches;  callers explicitly opt into its canonical projection.
 */

const { getCompanyDatabase } = require('./databaseManager.cjs');

/**
 * Loads normalized TicketFact objects from SQLite for a given company.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @returns {Array<object>} Array of TicketFact objects
 */
function loadTicketFactsFromSqlite(db, companyId, period = null) {
  const periodFilter = period
    ? ` AND (
        t.period_id = ? OR (
          t.period_id IS NULL AND date(t.submitted_at) >= date(?)
          AND (? IS NULL OR date(t.submitted_at) <= date(?))
        )
      )`
    : '';
  const periodParams = period
    ? [period.id, period.startDate, period.endDate || null, period.endDate || null]
    : [];
  const ticketsQuery = db.prepare(`
    SELECT t.id, t.model_id, t.party_number, t.party_record_id, t.patta_number, t.qty,
           t.size, t.color, t.konveyer, t.status, t.submitted_at
    FROM tickets t
    WHERE t.company_id = ?${periodFilter}
    ORDER BY t.id ASC
  `);
  const ticketRows = ticketsQuery.all(companyId, ...periodParams);

  const entriesQuery = db.prepare(`
    SELECT e.ticket_id, e.op_name, e.worker_id, e.worker_name_snapshot,
           e.rate_snapshot, e.brak, e.qty
    FROM ticket_entries e
    INNER JOIN tickets t ON t.id = e.ticket_id AND t.company_id = e.company_id
    WHERE e.company_id = ? AND t.company_id = ?${periodFilter}
    ORDER BY e.id ASC
  `);
  const entryRows = entriesQuery.all(companyId, companyId, ...periodParams);

  // Group entries by ticket_id
  const entriesByTicket = new Map();
  for (const e of entryRows) {
    let list = entriesByTicket.get(e.ticket_id);
    if (!list) {
      list = [];
      entriesByTicket.set(e.ticket_id, list);
    }
    list.push({
      workerId: e.worker_id,
      opName: e.op_name,
      workerNameSnapshot: e.worker_name_snapshot,
      rateSnapshot: e.rate_snapshot !== null ? Number(e.rate_snapshot) : undefined,
      brak: e.brak || undefined
    });
  }

  return ticketRows.map((t) => ({
    ticketId: t.id,
    companyId,
    modelId: t.model_id,
    partyNumber: t.party_number,
    partyRecordId: t.party_record_id,
    pattaNumber: t.patta_number,
    qty: Number(t.qty),
    size: t.size,
    color: t.color,
    konveyer: t.konveyer,
    status: t.status,
    submittedAt: t.submitted_at,
    entries: entriesByTicket.get(t.id) || []
  }));
}

/**
 * Loads ProductionAdjustmentFact objects from SQLite if available.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @returns {Array<object>} Array of ProductionAdjustmentFact objects
 */
function loadProductionAdjustmentFactsFromSqlite(db, companyId) {
  // Check if production_adjustments table exists
  const tableCheck = db.prepare(`
    SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='production_adjustments'
  `).get();

  if (!tableCheck || tableCheck.count === 0) {
    return [];
  }

  const query = db.prepare(`
    SELECT adjustment_id, company_id, model_id, worker_id, op_name, delta_qty,
           reason, status, provenance, created_at, created_by, original_adjustment_id
    FROM production_adjustments
    WHERE company_id = ?
    ORDER BY adjustment_id ASC
  `);
  const rows = query.all(companyId);

  return rows.map((r) => ({
    adjustmentId: r.adjustment_id,
    companyId: r.company_id,
    modelId: r.model_id,
    workerId: r.worker_id,
    opName: r.op_name,
    deltaQty: Number(r.delta_qty),
    reason: r.reason,
    status: r.status,
    provenance: r.provenance,
    createdAt: r.created_at,
    createdBy: r.created_by,
    originalAdjustmentId: r.original_adjustment_id || undefined
  }));
}

const { buildHisobProjections } = require('./projectionEngine.cjs');

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function loadModelsFromSqlite(db, companyId, projections) {
  const rows = db.prepare(`
    SELECT id, company_id, name, hisob_sheet_name, title, party, color, size,
           operations_json, patta_ops_order_json, server_revision
    FROM models
    WHERE company_id = ? AND status = 'ACTIVE'
    ORDER BY id ASC
  `).all(companyId);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    hisobSheetName: row.hisob_sheet_name || `${row.name}-hisob`,
    title: row.title || `Model- ${row.name}`,
    party: row.party || '',
    color: row.color || '',
    size: row.size || '',
    operations: parseJson(row.operations_json, []),
    pattaOpsOrder: parseJson(row.patta_ops_order_json, []),
    serverRevision: Number(row.server_revision || 0),
    hisobQuantities: projections.optimistic[row.id] || {}
  }));
}

function loadWorkersFromSqlite(db, companyId, periodId = null) {
  const rows = db.prepare(`
    SELECT id, company_id, name, staj, role, status, server_revision,
           COALESCE((
             SELECT SUM(a.amount)
             FROM worker_adjustments a
              WHERE a.company_id = w.company_id
                AND a.worker_id = w.id
                AND (? IS NULL OR a.period_id = ?)
                AND a.type = 'AVANS'
                AND a.status = 'POSTED'
           ), 0) AS avans,
           COALESCE((
             SELECT SUM(a.amount)
             FROM worker_adjustments a
              WHERE a.company_id = w.company_id
                AND a.worker_id = w.id
                AND (? IS NULL OR a.period_id = ?)
                AND a.type = 'JARIMA'
                AND a.status = 'POSTED'
           ), 0) AS jarima,
           updated_at
    FROM workers w
    WHERE company_id = ? AND status = 'ACTIVE'
    ORDER BY id ASC
  `).all(periodId, periodId, periodId, periodId, companyId);

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    staj: Number(row.staj || 0),
    role: row.role || undefined,
    status: row.status,
    serverRevision: Number(row.server_revision || 0),
    avans: Number(row.avans || 0),
    jarima: Number(row.jarima || 0),
    updatedAt: row.updated_at ? Date.parse(row.updated_at) || undefined : undefined
  }));
}

function loadPartiesFromSqlite(db, companyId) {
  const rows = db.prepare(`
     SELECT p.id, p.company_id, p.party_number,
            COALESCE(a.canonical_model_id, p.model_id) AS model_id,
            p.model_name, p.color,
            patta_count, cumulative_patta_count, ish_soni_per_patta,
            total_ish_soni, ish_soni, cumulative_ish_soni, sizes_json,
            printed_at, is_closed, closed_at, archived_patta_numbers_json,
            status, server_revision,
            COALESCE(p.patta_start_number, r.patta_start_number) AS patta_start_number,
            COALESCE(p.patta_end_number, r.patta_end_number) AS patta_end_number
     FROM parties p
     LEFT JOIN model_id_aliases a ON a.company_id = p.company_id AND a.legacy_model_id = p.model_id
     LEFT JOIN protected_party_patta_ranges r ON r.company_id = p.company_id AND r.party_record_id = p.id
     WHERE p.company_id = ? AND p.is_archived = 0
     ORDER BY p.created_at ASC, p.id ASC
  `).all(companyId);

  return rows.map((row) => ({
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
    printedAt: row.printed_at || undefined,
    isClosed: Boolean(row.is_closed) || row.status === 'CLOSED',
    closedAt: row.closed_at || undefined,
    archivedPattaNumbers: parseJson(row.archived_patta_numbers_json, []),
    serverRevision: Number(row.server_revision || 0)
  }));
}

function loadPeriodsFromSqlite(db, companyId) {
  const rows = db.prepare(`
    SELECT id, company_id, name, start_date, end_date, is_closed, closed_at,
           notes, archive_filename, status, server_revision
    FROM periods
    WHERE company_id = ?
    ORDER BY start_date DESC, id DESC
  `).all(companyId);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date || undefined,
    isClosed: Boolean(row.is_closed),
    closedAt: row.closed_at || undefined,
    notes: row.notes || undefined,
    archiveFilename: row.archive_filename || undefined,
    serverRevision: Number(row.server_revision || 0)
  }));
}

function loadBatchSettingsFromSqlite(db, companyId, models) {
  const companySettings = db.prepare(`
    SELECT available_sizes_json FROM company_batch_settings WHERE company_id = ?
  `).get(companyId);
  const configRows = db.prepare(`
    SELECT model_id, party_number, is_custom_party, total_ish_soni, color, sizes_json
    FROM patta_batch_settings WHERE company_id = ?
  `).all(companyId);
  const configs = Object.fromEntries(configRows.map((row) => [row.model_id, {
    partyNumber: row.party_number || '',
    isCustomParty: Boolean(row.is_custom_party),
    totalIshSoni: row.total_ish_soni || '',
    color: row.color || undefined,
    sizes: parseJson(row.sizes_json, {})
  }]));
  for (const model of models) {
    if (!configs[model.id]) {
      configs[model.id] = {
        partyNumber: '',
        isCustomParty: false,
        totalIshSoni: '',
        color: model.color || undefined,
        sizes: {}
      };
    }
  }
  return {
    availableSizes: parseJson(companySettings?.available_sizes_json, []),
    pattaBatchConfigs: configs
  };
}

function loadPeriodArchiveFromSqlite(db, companyId, periodId) {
  const row = db.prepare(`
    SELECT archive_json, sha256, archived_at
    FROM period_archives WHERE company_id = ? AND period_id = ?
  `).get(companyId, periodId);
  if (!row) return null;
  return {
    data: parseJson(row.archive_json, null),
    sha256: row.sha256,
    archivedAt: row.archived_at
  };
}

function loadTicketFormsFromSqlite(db, companyId) {
  const rows = db.prepare(`
    SELECT model_id, form_json FROM local_ticket_forms WHERE company_id = ?
  `).all(companyId);
  return Object.fromEntries(rows.map((row) => [row.model_id, parseJson(row.form_json, {})]));
}

function toSubmittedTicket(fact) {
  return {
    id: fact.ticketId,
    companyId: fact.companyId,
    modelId: fact.modelId,
    partyNumber: fact.partyNumber,
    partyRecordId: fact.partyRecordId || undefined,
    pattaNumber: Number(fact.pattaNumber),
    qty: Number(fact.qty),
    size: fact.size || undefined,
    color: fact.color || undefined,
    konveyer: fact.konveyer || undefined,
    status: fact.status,
    submittedAt: fact.submittedAt,
    entries: (fact.entries || []).map((entry) => ({
      opName: entry.opName,
      workerId: entry.workerId,
      workerName: entry.workerNameSnapshot || '',
      workerNameSnapshot: entry.workerNameSnapshot || undefined,
      rateSnapshot: entry.rateSnapshot,
      brak: entry.brak
    }))
  };
}

/**
 * Loads the legacy-shaped workbook projection from canonical SQLite facts.
 * Every query is company-scoped and this function performs no SQLite writes.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @returns {object}
 */
function loadWorkbookProjectionFromSqlite(db, companyId) {
  const periods = loadPeriodsFromSqlite(db, companyId);
  const openPeriod = periods.find((period) => !period.isClosed);
  const tickets = loadTicketFactsFromSqlite(db, companyId, openPeriod);
  const visibleTickets = tickets.filter((ticket) => ticket.status !== 'VOIDED');
  const productionAdjustments = loadProductionAdjustmentFactsFromSqlite(db, companyId);
  const projections = buildHisobProjections({ tickets: visibleTickets, productionAdjustments });
  const models = loadModelsFromSqlite(db, companyId, projections);
  const workers = loadWorkersFromSqlite(db, companyId, openPeriod?.id || null);
  const printedPartyHistory = loadPartiesFromSqlite(db, companyId);
  const batchSettings = loadBatchSettingsFromSqlite(db, companyId, models);
  const submittedTickets = visibleTickets.map(toSubmittedTicket);
  const currentPeriod = openPeriod || periods[0] || {
    id: 'period_default',
    name: 'Default period',
    startDate: new Date().toISOString().slice(0, 10),
    isClosed: false
  };
  const activePartyNumbers = printedPartyHistory
    .filter((party) => !party.isClosed)
    .map((party) => Number.parseInt(String(party.partyNumber), 10))
    .filter((partyNumber) => Number.isSafeInteger(partyNumber) && partyNumber > 0);
  const activePartyNumberSet = new Set(activePartyNumbers);
  let nextPartyNumber = 1;
  while (activePartyNumberSet.has(nextPartyNumber)) nextPartyNumber += 1;

  return {
    companyId,
    workers,
    models,
    printedPartyHistory,
    submittedTickets,
    currentPeriod,
    periods,
    nextPartyNumber,
    ticketForms: loadTicketFormsFromSqlite(db, companyId),
    pattaBatchConfigs: batchSettings.pattaBatchConfigs,
    availableSizes: batchSettings.availableSizes,
    deletedTicketIds: [],
    deletedPartyIds: [],
    deletedWorkerIds: [],
    deletedModelIds: [],
    projections
  };
}

/**
 * Rebuilds pure domain projections for a company from authoritative SQLite facts.
 *
 * @param {string} baseUserDataPath
 * @param {string} companyId
 * @returns {object} { optimistic, accounting, breakdown }
 */
function rebuildCompanyProjections(baseUserDataPath, companyId) {
  const db = getCompanyDatabase(baseUserDataPath, companyId);
  const openPeriod = loadPeriodsFromSqlite(db, companyId).find((period) => !period.isClosed);
  const tickets = loadTicketFactsFromSqlite(db, companyId, openPeriod);
  const productionAdjustments = loadProductionAdjustmentFactsFromSqlite(db, companyId);
  return buildHisobProjections({ tickets, productionAdjustments });
}

module.exports = {
  loadTicketFactsFromSqlite,
  loadProductionAdjustmentFactsFromSqlite,
  loadWorkbookProjectionFromSqlite,
  rebuildCompanyProjections,
  loadPeriodArchiveFromSqlite
};
