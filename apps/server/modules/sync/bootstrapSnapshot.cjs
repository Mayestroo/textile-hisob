'use strict';

const {
  acquireCompanyBootstrapLock,
  releaseCompanyBootstrapLock
} = require('./changeFeedWatermark.cjs');

function jsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('BOOTSTRAP_SOURCE_NUMERIC_VALUE_INVALID');
  return parsed;
}

function dateValue(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

async function readCompanySnapshot(client, companyId) {
  const modelResult = await client.query(`
    SELECT id, company_id, name, operations_json, hisob_sheet_name, title, party, color, size,
      patta_ops_order_json, status, server_revision, created_at, updated_at
    FROM models WHERE company_id = $1 ORDER BY id ASC
  `, [companyId]);
  const models = modelResult.rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    operations: jsonValue(row.operations_json, []),
    hisobSheetName: row.hisob_sheet_name,
    title: row.title,
    party: row.party,
    color: row.color,
    size: row.size,
    pattaOpsOrder: jsonValue(row.patta_ops_order_json, []),
    status: row.status,
    serverRevision: numberValue(row.server_revision),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at)
  }));

  const workerResult = await client.query(`
    SELECT id, company_id, name, status, staj, role, legacy_avans, legacy_jarima,
      server_revision, created_at, updated_at
    FROM workers WHERE company_id = $1 ORDER BY id ASC
  `, [companyId]);
  const workers = workerResult.rows.map((row) => ({
    id: numberValue(row.id),
    companyId: row.company_id,
    name: row.name,
    status: row.status,
    staj: numberValue(row.staj),
    role: row.role,
    legacyAvans: numberValue(row.legacy_avans),
    legacyJarima: numberValue(row.legacy_jarima),
    serverRevision: numberValue(row.server_revision),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at)
  }));

  const periodResult = await client.query(`
    SELECT id, company_id, name, start_date, end_date, is_closed, closed_at,
      notes, archive_filename, status, server_revision, created_at, updated_at
    FROM periods WHERE company_id = $1 ORDER BY start_date DESC, id DESC
  `, [companyId]);
  const periods = periodResult.rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    startDate: dateValue(row.start_date)?.slice(0, 10),
    endDate: dateValue(row.end_date)?.slice(0, 10) || null,
    isClosed: Boolean(row.is_closed),
    closedAt: dateValue(row.closed_at),
    notes: row.notes,
    archiveFilename: row.archive_filename,
    status: row.status,
    serverRevision: numberValue(row.server_revision),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at)
  }));

  const partyResult = await client.query(`
    SELECT id, company_id, party_number, physical_party_number, model_id, model_name, color,
      patta_count, cumulative_patta_count, ish_soni_per_patta, total_ish_soni, ish_soni,
      cumulative_ish_soni, sizes_json, printed_at, is_closed, closed_at,
      archived_patta_numbers_json, status, is_archived, server_revision, created_at, updated_at
    FROM parties WHERE company_id = $1 ORDER BY created_at ASC, id ASC
  `, [companyId]);
  const parties = partyResult.rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    partyNumber: row.party_number,
    physicalPartyNumber: row.physical_party_number,
    modelId: row.model_id,
    modelName: row.model_name,
    color: row.color,
    pattaCount: numberValue(row.patta_count),
    cumulativePattaCount: numberValue(row.cumulative_patta_count),
    ishSoniPerPatta: numberValue(row.ish_soni_per_patta, null),
    totalIshSoni: numberValue(row.total_ish_soni, null),
    ishSoni: numberValue(row.ish_soni),
    cumulativeIshSoni: numberValue(row.cumulative_ish_soni),
    sizes: jsonValue(row.sizes_json, {}),
    printedAt: dateValue(row.printed_at),
    isClosed: Boolean(row.is_closed),
    closedAt: dateValue(row.closed_at),
    archivedPattaNumbers: jsonValue(row.archived_patta_numbers_json, []),
    status: row.status,
    isArchived: Boolean(row.is_archived),
    serverRevision: numberValue(row.server_revision),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at)
  }));

  const adjustmentResult = await client.query(`
    SELECT id, company_id, worker_id, period_id, type, amount, provenance, created_at
    FROM worker_adjustments WHERE company_id = $1 ORDER BY created_at ASC, id ASC
  `, [companyId]);
  const workerAdjustments = adjustmentResult.rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    workerId: numberValue(row.worker_id),
    periodId: row.period_id,
    type: row.type,
    amount: numberValue(row.amount),
    provenance: row.provenance,
    createdAt: dateValue(row.created_at)
  }));

  const ticketResult = await client.query(`
    SELECT id, company_id, model_id, period_id, party_number, party_record_id, patta_number,
      qty, size, color, konveyer, status, is_closed, submitted_at, created_at, server_revision
    FROM tickets WHERE company_id = $1 ORDER BY submitted_at ASC, id ASC
  `, [companyId]);
  const ticketIds = ticketResult.rows.map((row) => row.id);
  let entryRows = [];
  if (ticketIds.length) {
    const entryResult = await client.query(`
      SELECT id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot,
        rate_snapshot, brak, qty, created_at
      FROM ticket_entries WHERE company_id = $1 AND ticket_id = ANY($2::varchar[])
      ORDER BY ticket_id ASC, id ASC
    `, [companyId, ticketIds]);
    entryRows = entryResult.rows;
  }
  const entriesByTicket = new Map();
  for (const row of entryRows) {
    const entries = entriesByTicket.get(row.ticket_id) || [];
    entries.push({
      id: row.id,
      companyId: row.company_id,
      opName: row.op_name,
      workerId: numberValue(row.worker_id),
      workerNameSnapshot: row.worker_name_snapshot,
      rateSnapshot: numberValue(row.rate_snapshot, null),
      brak: row.brak,
      qty: numberValue(row.qty),
      createdAt: dateValue(row.created_at)
    });
    entriesByTicket.set(row.ticket_id, entries);
  }
  const tickets = ticketResult.rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    modelId: row.model_id,
    periodId: row.period_id,
    partyNumber: row.party_number,
    partyRecordId: row.party_record_id,
    pattaNumber: numberValue(row.patta_number),
    qty: numberValue(row.qty),
    size: row.size,
    color: row.color,
    konveyer: row.konveyer,
    status: row.status,
    isClosed: Boolean(row.is_closed),
    submittedAt: dateValue(row.submitted_at),
    createdAt: dateValue(row.created_at),
    serverRevision: numberValue(row.server_revision),
    entries: entriesByTicket.get(row.id) || []
  }));

  const productionResult = await client.query(`
    SELECT adjustment_id, company_id, model_id, worker_id, op_name, delta_qty, reason,
      status, server_revision, created_at, created_by, original_adjustment_id
    FROM production_adjustments WHERE company_id = $1 ORDER BY created_at ASC, adjustment_id ASC
  `, [companyId]);
  const productionAdjustments = productionResult.rows.map((row) => ({
    adjustmentId: row.adjustment_id,
    companyId: row.company_id,
    modelId: row.model_id,
    workerId: numberValue(row.worker_id),
    opName: row.op_name,
    deltaQty: numberValue(row.delta_qty),
    reason: row.reason,
    status: row.status,
    serverRevision: numberValue(row.server_revision),
    createdAt: dateValue(row.created_at),
    createdBy: row.created_by,
    originalAdjustmentId: row.original_adjustment_id
  }));

  const companySettingsResult = await client.query(`
    SELECT company_id, available_sizes_json, server_revision, updated_at
    FROM company_batch_settings WHERE company_id = $1
  `, [companyId]);
  const modelSettingsResult = await client.query(`
    SELECT company_id, model_id, party_number, is_custom_party, total_ish_soni, color,
      sizes_json, server_revision, updated_at
    FROM patta_batch_settings WHERE company_id = $1 ORDER BY model_id ASC
  `, [companyId]);
  const companySettings = companySettingsResult.rows[0];
  const batchSettings = {
    company: companySettings ? {
      companyId: companySettings.company_id,
      availableSizes: jsonValue(companySettings.available_sizes_json, []),
      serverRevision: numberValue(companySettings.server_revision),
      updatedAt: dateValue(companySettings.updated_at)
    } : null,
    models: modelSettingsResult.rows.map((row) => ({
      companyId: row.company_id,
      modelId: row.model_id,
      partyNumber: row.party_number,
      isCustomParty: Boolean(row.is_custom_party),
      totalIshSoni: row.total_ish_soni,
      color: row.color,
      sizes: jsonValue(row.sizes_json, {}),
      serverRevision: numberValue(row.server_revision),
      updatedAt: dateValue(row.updated_at)
    }))
  };

  const archiveResult = await client.query(`
    SELECT company_id, period_id, archive_json, sha256, archived_at
    FROM period_archives WHERE company_id = $1 ORDER BY period_id ASC
  `, [companyId]);
  const periodArchives = archiveResult.rows.map((row) => ({
    companyId: row.company_id,
    periodId: row.period_id,
    archive: jsonValue(row.archive_json, null),
    sha256: row.sha256,
    archivedAt: dateValue(row.archived_at)
  }));

  const snapshot = {
    schemaVersion: 1,
    company: { companyId },
    models,
    workers,
    periods,
    parties,
    workerAdjustments,
    tickets,
    productionAdjustments,
    batchSettings,
    periodArchives
  };
  const counts = {
    models: models.length,
    workers: workers.length,
    periods: periods.length,
    parties: parties.length,
    workerAdjustments: workerAdjustments.length,
    tickets: tickets.length,
    ticketEntries: tickets.reduce((total, ticket) => total + ticket.entries.length, 0),
    productionAdjustments: productionAdjustments.length,
    periodArchives: periodArchives.length
  };
  return { snapshot, counts };
}

/**
 * Captures canonical rows and their change-feed high-water mark atomically.
 *
 * @param {import('pg').Pool} pool
 * @param {string} companyId
 * @param {{ testHookAfterSnapshot?: Function }} [options]
 */
async function withCompanyBootstrapSnapshot(pool, companyId, options = {}) {
  const client = await pool.connect();
  let lockHeld = false;
  let transactionStarted = false;
  let discardClient = false;
  try {
    await acquireCompanyBootstrapLock(client, companyId);
    lockHeld = true;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionStarted = true;
    const { snapshot, counts } = await readCompanySnapshot(client, companyId);
    const watermarkResult = await client.query(
      'SELECT COALESCE(MAX(change_id), 0)::text AS cursor FROM change_log WHERE company_id = $1',
      [companyId]
    );
    const cursor = String(watermarkResult.rows[0]?.cursor ?? '0');
    if (!/^\d+$/.test(cursor)) throw new Error('BOOTSTRAP_CURSOR_INVALID');
    if (typeof options.testHookAfterSnapshot === 'function') {
      await options.testHookAfterSnapshot(snapshot, cursor);
    }
    await client.query('COMMIT');
    transactionStarted = false;
    return { snapshot, cursor, counts };
  } catch (error) {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); } catch { discardClient = true; }
    }
    throw error;
  } finally {
    if (lockHeld) {
      try { await releaseCompanyBootstrapLock(client, companyId); }
      catch { discardClient = true; }
    }
    client.release(discardClient ? new Error('BOOTSTRAP_CONNECTION_DISCARDED') : undefined);
  }
}

module.exports = { withCompanyBootstrapSnapshot, readCompanySnapshot };
