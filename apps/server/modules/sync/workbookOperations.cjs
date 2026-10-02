'use strict';

const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');

function workbookError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function calendarDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
}

function assertBaseRevision(payload, currentRevision, entityName) {
  const expected = Number(currentRevision || 0);
  if (payload.baseRevision !== undefined && payload.baseRevision !== null && payload.baseRevision !== expected) {
    const error = workbookError('REVISION_CONFLICT', `${entityName} revision conflict; expected ${expected}, supplied ${payload.baseRevision}`);
    error.details = { currentRevision: expected, baseRevision: payload.baseRevision };
    throw error;
  }
  return expected + 1;
}

function appendChange(client, companyId, entityType, entityId, revision, operationId, changeType, payload, committedAt) {
  return client.query(`
    INSERT INTO change_log (
      company_id, entity_type, entity_id, entity_revision, operation_id, change_type, payload_json, committed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
    RETURNING change_id, committed_at
  `, [companyId, entityType, String(entityId), revision, operationId, changeType, canonicalStringify(payload), committedAt || new Date().toISOString()]);
}

async function assertActiveModel(client, companyId, modelId) {
  const alias = await client.query(`SELECT canonical_model_id FROM model_id_aliases
    WHERE company_id = $1 AND legacy_model_id = $2`, [companyId, modelId]);
  const canonicalModelId = alias.rows[0]?.canonical_model_id || modelId;
  const result = await client.query(
    `SELECT id FROM models WHERE company_id = $1 AND id = $2 AND status = 'ACTIVE'`,
    [companyId, canonicalModelId]
  );
  if (!result.rows.length) throw workbookError('MODEL_NOT_FOUND', `Active model "${modelId}" was not found`);
  return canonicalModelId;
}

async function executeUpsertModel(client, companyId, operationId, payload, canonicalJson, envelope) {
  const modelAlias = await client.query(`SELECT canonical_model_id FROM model_id_aliases
    WHERE company_id = $1 AND legacy_model_id = $2`, [companyId, payload.modelId]);
  const modelId = modelAlias.rows[0]?.canonical_model_id || payload.modelId;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':model-name:' || lower($2)))`, [companyId, payload.name]);
  const duplicate = await client.query(
    `SELECT id FROM models WHERE company_id = $1 AND lower(name) = lower($2) AND id <> $3 AND status = 'ACTIVE' LIMIT 1`,
    [companyId, payload.name, modelId]
  );
  if (duplicate.rows.length) throw workbookError('MODEL_NAME_EXISTS', `Model name "${payload.name}" is already in use`);

  const currentResult = await client.query(
    `SELECT id, status, server_revision FROM models WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, modelId]
  );
  const current = currentResult.rows[0];
  const baseRevision = envelope.baseRevision === undefined || envelope.baseRevision === null ? 0 : envelope.baseRevision;
  const revision = assertBaseRevision(payload, current?.server_revision || 0, 'Model');
  if (!current && baseRevision !== 0) throw workbookError('REVISION_CONFLICT', 'A new model must start at revision zero');
  if (current && current.status !== 'ACTIVE') throw workbookError('MODEL_INACTIVE', `Model "${modelId}" is inactive`);

  const now = new Date().toISOString();
  const operations = JSON.stringify(payload.operations || []);
  const pattaOrder = JSON.stringify(payload.pattaOpsOrder || []);
  if (current) {
    await client.query(`
      UPDATE models SET name = $1, hisob_sheet_name = $2, title = $3, party = $4, color = $5,
        size = $6, operations_json = $7::jsonb, patta_ops_order_json = $8::jsonb,
        server_revision = $9, updated_at = $10
      WHERE company_id = $11 AND id = $12
    `, [payload.name, payload.hisobSheetName || `${payload.name}-hisob`, payload.title || `Model- ${payload.name}`,
      payload.party || '', payload.color || '', payload.size || '', operations, pattaOrder, revision, now, companyId, modelId]);
    for (const rename of payload.operationRenames || []) {
      await client.query(`UPDATE ticket_entries entry_row SET op_name = $1
        FROM tickets ticket_row
        WHERE entry_row.company_id = $2 AND ticket_row.company_id = entry_row.company_id
          AND ticket_row.id = entry_row.ticket_id AND ticket_row.model_id = $3 AND entry_row.op_name = $4`,
      [rename.toName, companyId, modelId, rename.fromName]);
      await client.query(`UPDATE production_adjustments SET op_name = $1
        WHERE company_id = $2 AND model_id = $3 AND op_name = $4`,
      [rename.toName, companyId, modelId, rename.fromName]);
    }
  } else {
    await client.query(`
      INSERT INTO models (
        id, company_id, name, hisob_sheet_name, title, party, color, size,
        operations_json, patta_ops_order_json, status, server_revision, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'ACTIVE', 1, $11, $11)
    `, [modelId, companyId, payload.name, payload.hisobSheetName || `${payload.name}-hisob`, payload.title || `Model- ${payload.name}`,
      payload.party || '', payload.color || '', payload.size || '', operations, pattaOrder, now]);
    await client.query(`
      INSERT INTO patta_batch_settings (company_id, model_id, updated_at)
      VALUES ($1, $2, $3) ON CONFLICT (company_id, model_id) DO NOTHING
    `, [companyId, modelId, now]);
  }
  const change = await appendChange(client, companyId, 'model', modelId, revision, operationId,
    current ? 'UPDATE' : 'INSERT', payload, now);
  return { serverRevision: revision, entityId: modelId, changeId: change.rows[0].change_id, committedAt: change.rows[0].committed_at };
}

async function executeDeactivateModel(client, companyId, operationId, payload, envelope) {
  const currentResult = await client.query(
    `SELECT id, status, server_revision FROM models WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, payload.modelId]
  );
  const current = currentResult.rows[0];
  if (!current) throw workbookError('MODEL_NOT_FOUND', `Model "${payload.modelId}" was not found`);
  if (current.status !== 'ACTIVE') throw workbookError('MODEL_INACTIVE', `Model "${payload.modelId}" is already inactive`);
  const revision = assertBaseRevision({ baseRevision: envelope.baseRevision }, current.server_revision, 'Model');
  const now = new Date().toISOString();
  await client.query(`UPDATE models SET status = 'INACTIVE', server_revision = $1, updated_at = $2 WHERE company_id = $3 AND id = $4`,
    [revision, now, companyId, payload.modelId]);
  const change = await appendChange(client, companyId, 'model', payload.modelId, revision, operationId, 'UPDATE',
    { modelId: payload.modelId, status: 'INACTIVE', updatedAt: now }, now);
  return { serverRevision: revision, entityId: payload.modelId, changeId: change.rows[0].change_id, committedAt: change.rows[0].committed_at };
}

async function executeUpsertWorker(client, companyId, operationId, payload, canonicalJson, envelope, options = {}) {
  const workerId = Number(payload.workerId);
  const currentResult = await client.query(
    `SELECT id, status, server_revision FROM workers WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, workerId]
  );
  const current = currentResult.rows[0];
  if (!current) throw workbookError('WORKER_CREATE_USE_CREATE_WORKER', 'New workers must use the authoritative CreateWorker command');
  if (current && current.status !== 'ACTIVE') throw workbookError('WORKER_INACTIVE', `Worker "${workerId}" is inactive`);
  const revision = assertBaseRevision({ baseRevision: envelope.baseRevision }, current?.server_revision || 0, 'Worker');
  const now = new Date().toISOString();
  await client.query(`
    UPDATE workers SET name = $1, staj = $2, role = $3, server_revision = $4, updated_at = $5
    WHERE company_id = $6 AND id = $7
  `, [payload.name, payload.staj, payload.role, revision, now, companyId, workerId]);

  for (const adjustment of payload.balanceAdjustments || []) {
    if (adjustment.periodId) {
      const period = await client.query(`SELECT id FROM periods WHERE company_id = $1 AND id = $2 AND is_closed = 0`, [companyId, adjustment.periodId]);
      if (!period.rows.length) throw workbookError('PERIOD_CLOSED', `Period "${adjustment.periodId}" is not open`);
    }
    await client.query(`
      INSERT INTO worker_adjustments (id, company_id, worker_id, type, amount, source_id, provenance, created_at, period_id)
      VALUES ($1, $2, $3, $4, $5, $6, 'WORKBOOK_COMMAND', $7, $8)
    `, [adjustment.adjustmentId, companyId, workerId, adjustment.type, adjustment.amountDelta, adjustment.adjustmentId, now, adjustment.periodId || null]);
  }

  const change = await appendChange(client, companyId, 'worker', String(workerId), revision, operationId,
    'UPDATE', payload, now);
  return { serverRevision: revision, entityId: String(workerId), changeId: change.rows[0].change_id, committedAt: change.rows[0].committed_at };
}

async function executeDeactivateWorker(client, companyId, operationId, payload, envelope) {
  const workerId = Number(payload.workerId);
  const currentResult = await client.query(`SELECT id, status, server_revision FROM workers WHERE company_id = $1 AND id = $2 FOR UPDATE`, [companyId, workerId]);
  const current = currentResult.rows[0];
  if (!current) throw workbookError('WORKER_NOT_FOUND', `Worker "${workerId}" was not found`);
  if (current.status !== 'ACTIVE') throw workbookError('WORKER_INACTIVE', `Worker "${workerId}" is already inactive`);
  const revision = assertBaseRevision({ baseRevision: envelope.baseRevision }, current.server_revision, 'Worker');
  const now = new Date().toISOString();
  await client.query(`UPDATE workers SET status = 'INACTIVE', server_revision = $1, updated_at = $2 WHERE company_id = $3 AND id = $4`,
    [revision, now, companyId, workerId]);
  const change = await appendChange(client, companyId, 'worker', String(workerId), revision, operationId, 'UPDATE',
    { workerId, status: 'INACTIVE', updatedAt: now }, now);
  return { serverRevision: revision, entityId: String(workerId), changeId: change.rows[0].change_id, committedAt: change.rows[0].committed_at };
}

async function executeCreatePeriod(client, companyId, operationId, payload, envelope) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':periods'))`, [companyId]);
  const periodId = payload.periodId;
  const existing = await client.query(`SELECT id FROM periods WHERE company_id = $1 AND id = $2`, [companyId, periodId]);
  if (existing.rows.length) throw workbookError('PERIOD_EXISTS', `Period "${periodId}" already exists`);
  const openPeriod = await client.query(`SELECT id FROM periods WHERE company_id = $1 AND is_closed = 0 FOR UPDATE`, [companyId]);
  if (openPeriod.rows.length) throw workbookError('OPEN_PERIOD_EXISTS', `Open period "${openPeriod.rows[0].id}" must be closed first`);
  if (Number(envelope.baseRevision || 0) !== 0) throw workbookError('REVISION_CONFLICT', 'A new period must start at revision zero');
  const now = new Date().toISOString();
  await client.query(`
    INSERT INTO periods (id, company_id, name, start_date, is_closed, status, server_revision, created_at, updated_at)
    VALUES ($1, $2, $3, $4::date, 0, 'OPEN', 1, $5, $5)
  `, [periodId, companyId, payload.name, payload.startDate, now]);
  const change = await appendChange(client, companyId, 'period', periodId, 1, operationId, 'INSERT', payload, now);
  return { serverRevision: 1, entityId: periodId, changeId: change.rows[0].change_id, committedAt: change.rows[0].committed_at };
}

async function executeUpdatePeriod(client, companyId, operationId, payload, envelope) {
  const currentResult = await client.query(`SELECT id, name, start_date, is_closed, server_revision FROM periods WHERE company_id = $1 AND id = $2 FOR UPDATE`, [companyId, payload.periodId]);
  const current = currentResult.rows[0];
  if (!current) throw workbookError('PERIOD_NOT_FOUND', `Period "${payload.periodId}" was not found`);
  if (current.is_closed) throw workbookError('PERIOD_CLOSED', 'Closed periods cannot be updated');
  const revision = assertBaseRevision({ baseRevision: envelope.baseRevision }, current.server_revision, 'Period');
  const now = new Date().toISOString();
  await client.query(`UPDATE periods SET name = $1, start_date = $2::date, server_revision = $3, updated_at = $4 WHERE company_id = $5 AND id = $6`,
    [payload.name, payload.startDate, revision, now, companyId, payload.periodId]);
  const change = await appendChange(client, companyId, 'period', payload.periodId, revision, operationId, 'UPDATE', payload, now);
  return { serverRevision: revision, entityId: payload.periodId, changeId: change.rows[0].change_id, committedAt: change.rows[0].committed_at };
}

async function readPeriodArchiveSource(client, companyId, period) {
  const models = await client.query(`SELECT id, name, hisob_sheet_name, title, party, color, size, operations_json, patta_ops_order_json
    FROM models WHERE company_id = $1 ORDER BY id`, [companyId]);
  const workers = await client.query(`SELECT w.id, w.name, w.staj, w.role,
      COALESCE(SUM(a.amount) FILTER (WHERE a.type = 'AVANS'), 0) AS avans,
      COALESCE(SUM(a.amount) FILTER (WHERE a.type = 'JARIMA'), 0) AS jarima
      FROM workers w LEFT JOIN worker_adjustments a ON a.company_id = w.company_id AND a.worker_id = w.id AND a.period_id = $2
      WHERE w.company_id = $1 GROUP BY w.id, w.company_id, w.name, w.staj, w.role ORDER BY w.id`, [companyId, period.id]);
  const parties = await client.query(`SELECT p.id, p.party_number,
      COALESCE(a.canonical_model_id, p.model_id) AS model_id,
      p.model_name, p.color, p.patta_count, p.cumulative_patta_count,
      COALESCE(p.patta_start_number, r.patta_start_number) AS patta_start_number,
      COALESCE(p.patta_end_number, r.patta_end_number) AS patta_end_number,
      ish_soni_per_patta, total_ish_soni, ish_soni, cumulative_ish_soni, sizes_json, printed_at,
      p.is_closed, p.closed_at, p.archived_patta_numbers_json
      FROM parties p
      LEFT JOIN model_id_aliases a ON a.company_id = p.company_id AND a.legacy_model_id = p.model_id
      LEFT JOIN protected_party_patta_ranges r ON r.company_id = p.company_id AND r.party_record_id = p.id
      WHERE p.company_id = $1 AND (p.status != 'CLOSED' OR p.printed_at::date >= $2::date AND p.printed_at::date <= $3::date)
      ORDER BY p.printed_at, p.id`,
      [companyId, period.start_date, period.end_date || period.start_date]);
  const tickets = await client.query(`SELECT id, model_id, period_id, party_number, party_record_id, patta_number, qty, size, color, konveyer, status, submitted_at
      FROM tickets WHERE company_id = $1 AND (period_id = $2 OR (period_id IS NULL AND submitted_at::date >= $3::date AND submitted_at::date <= $4::date))
      ORDER BY submitted_at, id`, [companyId, period.id, period.start_date, period.end_date || period.start_date]);
  const settings = await client.query(`SELECT c.available_sizes_json, b.model_id, b.party_number, b.is_custom_party, b.total_ish_soni, b.color, b.sizes_json
      FROM company_batch_settings c LEFT JOIN patta_batch_settings b ON b.company_id = c.company_id
      WHERE c.company_id = $1 ORDER BY b.model_id`, [companyId]);
  const ticketIds = tickets.rows.map((row) => row.id);
  let entryRows = [];
  if (ticketIds.length) {
    const entries = await client.query(`SELECT ticket_id, op_name, worker_id, worker_name_snapshot, rate_snapshot, brak
      FROM ticket_entries WHERE company_id = $1 AND ticket_id = ANY($2::varchar[]) ORDER BY ticket_id, id`, [companyId, ticketIds]);
    entryRows = entries.rows;
  }
  const entriesByTicket = new Map();
  for (const entry of entryRows) {
    const list = entriesByTicket.get(entry.ticket_id) || [];
    list.push({ opName: entry.op_name, workerId: entry.worker_id, workerNameSnapshot: entry.worker_name_snapshot, rateSnapshot: Number(entry.rate_snapshot || 0), brak: entry.brak || undefined });
    entriesByTicket.set(entry.ticket_id, list);
  }
  const pattaBatchConfigs = Object.fromEntries(settings.rows.filter((row) => row.model_id).map((row) => [row.model_id, {
    partyNumber: row.party_number || '', isCustomParty: row.is_custom_party, totalIshSoni: row.total_ish_soni || '',
    color: row.color || undefined, sizes: row.sizes_json || {}
  }]));
  const submittedTickets = tickets.rows.map((row) => ({
    id: row.id, modelId: row.model_id, partyNumber: row.party_number, partyRecordId: row.party_record_id,
    pattaNumber: row.patta_number, qty: Number(row.qty), size: row.size || '', color: row.color || '',
    konveyer: row.konveyer || '', status: row.status,
    submittedAt: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : String(row.submitted_at),
    entries: entriesByTicket.get(row.id) || []
  }));
  const printedPartyHistory = parties.rows.map((row) => ({
    id: row.id, partyNumber: row.party_number, modelId: row.model_id, modelName: row.model_name || '', color: row.color || '',
    pattaCount: row.patta_count, cumulativePattaCount: row.cumulative_patta_count,
    pattaStartNumber: row.patta_start_number === null ? undefined : Number(row.patta_start_number),
    pattaEndNumber: row.patta_end_number === null ? undefined : Number(row.patta_end_number),
    ishSoniPerPatta: row.ish_soni_per_patta === null ? undefined : Number(row.ish_soni_per_patta),
    totalIshSoni: row.total_ish_soni === null ? undefined : Number(row.total_ish_soni),
    ishSoni: Number(row.ish_soni || 0), cumulativeIshSoni: Number(row.cumulative_ish_soni || 0),
    sizes: row.sizes_json || {},
    printedAt: row.printed_at instanceof Date ? row.printed_at.toISOString() : (row.printed_at ? String(row.printed_at) : undefined),
    isClosed: Boolean(row.is_closed), closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at,
    archivedPattaNumbers: row.archived_patta_numbers_json || []
  }));
  const periodData = {
    id: period.id, name: period.name, startDate: calendarDate(period.start_date),
    endDate: period.end_date ? calendarDate(period.end_date) : undefined, isClosed: true,
    closedAt: new Date().toISOString(), archiveFilename: period.archive_filename || undefined
  };
  return {
    period: periodData,
    archivedAt: new Date().toISOString(),
    models: models.rows.map((row) => ({
      id: row.id, name: row.name, hisobSheetName: row.hisob_sheet_name, title: row.title, party: row.party,
      color: row.color, size: row.size, operations: row.operations_json || [], pattaOpsOrder: row.patta_ops_order_json || [], hisobQuantities: {}
    })),
    workers: workers.rows.map((row) => ({ id: row.id, name: row.name, staj: Number(row.staj || 0), role: row.role || undefined, avans: Number(row.avans || 0), jarima: Number(row.jarima || 0) })),
    printedPartyHistory,
    submittedTickets,
    pattaBatchConfigs,
    availableSizes: settings.rows[0]?.available_sizes_json || [],
    completedPartiesCount: 0,
    rolledOverPartiesCount: 0
  };
}

async function executeClosePeriod(client, companyId, operationId, payload, canonicalJson, envelope) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':periods'))`, [companyId]);
  const periodResult = await client.query(`SELECT id, name, start_date, end_date, is_closed, archive_filename, server_revision
    FROM periods WHERE company_id = $1 AND id = $2 FOR UPDATE`, [companyId, payload.periodId]);
  const period = periodResult.rows[0];
  if (!period) throw workbookError('PERIOD_NOT_FOUND', `Period "${payload.periodId}" was not found`);
  if (period.is_closed) throw workbookError('PERIOD_ALREADY_CLOSED', `Period "${payload.periodId}" is already closed`);
  const revision = assertBaseRevision({ baseRevision: envelope.baseRevision }, period.server_revision, 'Period');
  if (payload.endDate < calendarDate(period.start_date)) throw workbookError('INVALID_PERIOD_RANGE', 'Period endDate precedes its start date');
  if (payload.nextPeriod.startDate <= payload.endDate) throw workbookError('INVALID_PERIOD_RANGE', 'Next period must start after the closed period end date');
  const next = await client.query(`SELECT id FROM periods WHERE company_id = $1 AND id = $2`, [companyId, payload.nextPeriod.id]);
  if (next.rows.length) throw workbookError('PERIOD_EXISTS', `Next period "${payload.nextPeriod.id}" already exists`);
  const open = await client.query(`SELECT id FROM periods WHERE company_id = $1 AND is_closed = 0 AND id <> $2 FOR UPDATE`, [companyId, period.id]);
  if (open.rows.length) throw workbookError('OPEN_PERIOD_EXISTS', 'Another open period already exists');

  const activeParties = await client.query(`SELECT id, sizes_json, archived_patta_numbers_json
    FROM parties WHERE company_id = $1 AND status != 'CLOSED' AND is_closed = 0 ORDER BY id FOR UPDATE`, [companyId]);
  const periodTickets = await client.query(`SELECT party_record_id, patta_number FROM tickets
    WHERE company_id = $1 AND (period_id = $2 OR (period_id IS NULL AND submitted_at::date >= $3::date AND submitted_at::date <= $4::date))
      AND is_closed = 0 ORDER BY party_record_id, patta_number`, [companyId, period.id, period.start_date, payload.endDate]);
  const ticketsByParty = new Map();
  for (const ticket of periodTickets.rows) {
    const submitted = ticketsByParty.get(ticket.party_record_id) || [];
    submitted.push(Number(ticket.patta_number));
    ticketsByParty.set(ticket.party_record_id, submitted);
  }
  const completed = [];
  const rollover = [];
  for (const party of activeParties.rows) {
    const sizes = party.sizes_json;
    if (sizes !== null && sizes !== undefined && (!sizes || typeof sizes !== 'object' || Array.isArray(sizes))) {
      throw workbookError('INVALID_PARTY_SIZES', `Party "${party.id}" has invalid sizes`);
    }
    const totalPattas = Object.values(sizes || {}).reduce((total, count) => {
      const parsed = Number.parseInt(String(count || 0), 10);
      return parsed > 0 ? total + parsed : total;
    }, 0);
    const archivedValue = party.archived_patta_numbers_json;
    if (archivedValue !== null && archivedValue !== undefined && !Array.isArray(archivedValue)) {
      throw workbookError('INVALID_PARTY_ARCHIVE', `Party "${party.id}" has invalid archived patta numbers`);
    }
    const archived = (archivedValue || []).map(Number);
    if (archived.some((number) => !Number.isSafeInteger(number) || number < 0)) {
      throw workbookError('INVALID_PARTY_ARCHIVE', `Party "${party.id}" has invalid archived patta numbers`);
    }
    const submitted = ticketsByParty.get(party.id) || [];
    const completedPattaNumbers = new Set([...archived, ...submitted]);
    if (totalPattas > 0 && completedPattaNumbers.size >= totalPattas) {
      completed.push(party.id);
    } else {
      rollover.push({ partyRecordId: party.id, archivedPattaNumbers: [...completedPattaNumbers] });
    }
  }

  const archive = await readPeriodArchiveSource(client, companyId, { ...period, end_date: payload.endDate, archive_filename: payload.archiveFilename });
  archive.completedPartiesCount = completed.length;
  archive.rolledOverPartiesCount = rollover.length;
  const archiveJson = canonicalStringify(archive);
  const archiveHash = computePayloadHash(archiveJson);
  const now = new Date().toISOString();
  await client.query(`INSERT INTO period_archives (company_id, period_id, archive_json, sha256, archived_at)
    VALUES ($1, $2, $3::jsonb, $4, $5)
    ON CONFLICT (company_id, period_id) DO UPDATE SET archive_json = excluded.archive_json, sha256 = excluded.sha256, archived_at = excluded.archived_at`,
  [companyId, period.id, archiveJson, archiveHash, now]);

  await client.query(`UPDATE periods SET end_date = $1::date, is_closed = 1, closed_at = $2, archive_filename = $3,
    status = 'CLOSED', server_revision = $4, updated_at = $2 WHERE company_id = $5 AND id = $6`,
  [payload.endDate, now, payload.archiveFilename || null, revision, companyId, period.id]);
  await client.query(`INSERT INTO periods (id, company_id, name, start_date, is_closed, status, server_revision, created_at, updated_at)
    VALUES ($1, $2, $3, $4::date, 0, 'OPEN', 1, $5, $5)`,
  [payload.nextPeriod.id, companyId, payload.nextPeriod.name, payload.nextPeriod.startDate, now]);

  let lastChangeId = 0;
  const periodChange = await appendChange(client, companyId, 'period', period.id, revision, operationId, 'UPDATE',
    { ...payload, status: 'CLOSED', closedAt: now, archiveSha256: archiveHash }, now);
  lastChangeId = Number(periodChange.rows[0].change_id);
  const nextPeriodChange = await appendChange(client, companyId, 'period', payload.nextPeriod.id, 1, operationId, 'INSERT',
    { ...payload.nextPeriod, periodId: payload.nextPeriod.id, companyId, isClosed: false }, now);
  lastChangeId = Number(nextPeriodChange.rows[0].change_id);

  for (const partyId of completed) {
    const updated = await client.query(`UPDATE parties SET status = 'CLOSED', is_closed = 1, closed_at = $1,
      server_revision = server_revision + 1, updated_at = $1 WHERE company_id = $2 AND id = $3 RETURNING *`, [now, companyId, partyId]);
    const change = await appendChange(client, companyId, 'party', partyId, updated.rows[0].server_revision, operationId, 'UPDATE',
      { partyRecordId: partyId, status: 'CLOSED', isClosed: true, closedAt: now }, now);
    lastChangeId = Number(change.rows[0].change_id);
  }
  for (const { partyRecordId: partyId, archivedPattaNumbers } of rollover) {
    const updated = await client.query(`UPDATE parties SET archived_patta_numbers_json = $1::jsonb,
      server_revision = server_revision + 1, updated_at = $2 WHERE company_id = $3 AND id = $4 RETURNING server_revision`,
    [JSON.stringify(archivedPattaNumbers), now, companyId, partyId]);
    const change = await appendChange(client, companyId, 'party', partyId, updated.rows[0].server_revision, operationId, 'UPDATE',
      { partyRecordId: partyId, archivedPattaNumbers }, now);
    lastChangeId = Number(change.rows[0].change_id);
  }

  const closedTickets = await client.query(`UPDATE tickets SET is_closed = 1, server_revision = server_revision + 1
    WHERE company_id = $1 AND (period_id = $2 OR (period_id IS NULL AND submitted_at::date >= $3::date AND submitted_at::date <= $4::date))
      AND is_closed = 0 RETURNING id, server_revision`, [companyId, period.id, period.start_date, payload.endDate]);
  for (const ticket of closedTickets.rows) {
    const change = await appendChange(client, companyId, 'ticket', ticket.id, ticket.server_revision, operationId, 'UPDATE',
      { ticketId: ticket.id, isClosed: true }, now);
    lastChangeId = Number(change.rows[0].change_id);
  }
  const archiveChange = await appendChange(client, companyId, 'period_archive', period.id, 1, operationId, 'INSERT',
    { periodId: period.id, sha256: archiveHash, archivedAt: now }, now);
  lastChangeId = Number(archiveChange.rows[0].change_id);
  return { serverRevision: revision, entityId: period.id, changeId: lastChangeId, committedAt: now, archiveSha256: archiveHash };
}

async function executeUpdateParty(client, companyId, operationId, payload, canonicalJson, envelope) {
  const partyAlias = await client.query(`SELECT canonical_party_id FROM party_id_aliases
    WHERE company_id = $1 AND legacy_party_id = $2`, [companyId, payload.partyRecordId]);
  const partyRecordId = partyAlias.rows[0]?.canonical_party_id || payload.partyRecordId;
  const currentResult = await client.query(`SELECT * FROM parties WHERE company_id = $1 AND id = $2 FOR UPDATE`, [companyId, partyRecordId]);
  const current = currentResult.rows[0];
  if (!current) throw workbookError('PARTY_NOT_FOUND', `Party "${partyRecordId}" was not found`);
  if (current.status === 'CLOSED') throw workbookError('PARTY_ALREADY_CLOSED', 'Closed parties cannot be updated');
  if (Number(current.patta_count) !== Number(payload.pattaCount)) throw workbookError('IMMUTABLE_PATTA_RANGE', 'An existing printed party cannot change its patta count');
  const modelAlias = await client.query(`SELECT canonical_model_id FROM model_id_aliases
    WHERE company_id = $1 AND legacy_model_id = $2`, [companyId, current.model_id]);
  const canonicalCurrentModelId = modelAlias.rows[0]?.canonical_model_id || current.model_id;
  const canonicalPayloadModelId = await assertActiveModel(client, companyId, payload.modelId);
  if (canonicalCurrentModelId !== canonicalPayloadModelId || current.party_number !== payload.partyNumber) throw workbookError('IMMUTABLE_PARTY_IDENTITY', 'Party model and party number are immutable');
  const revision = assertBaseRevision({ baseRevision: envelope.baseRevision }, current.server_revision, 'Party');
  const now = new Date().toISOString();
  const protectedCollision = await client.query(`SELECT 1 FROM legacy_party_collision_exceptions
    WHERE company_id = $1 AND party_id = $2 AND status = 'ACTIVE' LIMIT 1`, [companyId, partyRecordId]);
  const result = protectedCollision.rows.length
    ? await client.query(`UPDATE parties SET ish_soni_per_patta = $1, total_ish_soni = $2, ish_soni = $3,
        cumulative_ish_soni = $4, server_revision = $5, updated_at = $6
        WHERE company_id = $7 AND id = $8 RETURNING id`,
      [payload.ishSoniPerPatta, payload.totalIshSoni, payload.ishSoni, payload.cumulativeIshSoni,
        revision, now, companyId, partyRecordId])
    : await client.query(`UPDATE parties SET model_name = $1, color = $2,
    cumulative_patta_count = $3, ish_soni_per_patta = $4, total_ish_soni = $5, ish_soni = $6,
    cumulative_ish_soni = $7, sizes_json = $8::jsonb, server_revision = $9, updated_at = $10
    WHERE company_id = $11 AND id = $12 RETURNING id`,
  [payload.modelName || null, payload.color || null, current.cumulative_patta_count,
    payload.ishSoniPerPatta, payload.totalIshSoni, payload.ishSoni, payload.cumulativeIshSoni,
    JSON.stringify(payload.sizes || {}), revision, now, companyId, partyRecordId]);
  const changePayload = protectedCollision.rows.length
    ? {
      partyRecordId,
      ishSoniPerPatta: payload.ishSoniPerPatta,
      totalIshSoni: payload.totalIshSoni,
      ishSoni: payload.ishSoni,
      cumulativeIshSoni: payload.cumulativeIshSoni,
      updatedAt: now
    }
    : {
      ...payload,
      cumulativePattaCount: Number(current.cumulative_patta_count || 0),
      pattaStartNumber: current.patta_start_number === null ? undefined : Number(current.patta_start_number),
      pattaEndNumber: current.patta_end_number === null ? undefined : Number(current.patta_end_number)
    };
  const change = await appendChange(client, companyId, 'party', partyRecordId, revision, operationId, 'UPDATE', changePayload, now);
  return { serverRevision: revision, entityId: result.rows[0].id, changeId: change.rows[0].change_id, committedAt: change.rows[0].committed_at };
}

async function executeUpdateBatchSettings(client, companyId, operationId, payload, envelope, options = {}) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':batch-settings'))`, [companyId]);
  const currentResult = await client.query(`SELECT server_revision, available_sizes_json FROM company_batch_settings WHERE company_id = $1 FOR UPDATE`, [companyId]);
  const current = currentResult.rows[0];
  const revision = options.skipRevision
    ? Number(current?.server_revision || 0) + 1
    : assertBaseRevision({ baseRevision: envelope.baseRevision }, current?.server_revision || 0, 'Batch settings');
  const availableSizes = payload.availableSizes === undefined
    ? (current?.available_sizes_json || [])
    : payload.availableSizes;
  const now = new Date().toISOString();
  await client.query(`INSERT INTO company_batch_settings (company_id, available_sizes_json, server_revision, updated_at)
    VALUES ($1, $2::jsonb, $3, $4)
    ON CONFLICT (company_id) DO UPDATE SET available_sizes_json = excluded.available_sizes_json,
      server_revision = excluded.server_revision, updated_at = excluded.updated_at`,
  [companyId, JSON.stringify(availableSizes), revision, now]);
  for (const config of payload.configs || []) {
    const modelId = await assertActiveModel(client, companyId, config.modelId);
    await client.query(`INSERT INTO patta_batch_settings (
      company_id, model_id, party_number, is_custom_party, total_ish_soni, color, sizes_json, server_revision, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, $8)
    ON CONFLICT (company_id, model_id) DO UPDATE SET party_number = excluded.party_number,
      is_custom_party = excluded.is_custom_party, total_ish_soni = excluded.total_ish_soni,
      color = excluded.color, sizes_json = excluded.sizes_json,
      server_revision = patta_batch_settings.server_revision + 1, updated_at = excluded.updated_at`,
    [companyId, modelId, config.partyNumber, config.isCustomParty, config.totalIshSoni, config.color || null,
      JSON.stringify(config.sizes || {}), now]);
  }
  const change = await appendChange(client, companyId, 'batch_settings', companyId, revision, operationId,
    'UPDATE', { ...payload, availableSizes, companyId, serverRevision: revision }, now);
  return { serverRevision: revision, entityId: companyId, changeId: change.rows[0].change_id, committedAt: change.rows[0].committed_at };
}

async function executeCompletePattaBatch(client, companyId, operationId, payload, canonicalJson, options = {}) {
  const numbers = [...new Set(payload.parties.map((party) => party.partyNumber))].sort();
  if (numbers.length !== payload.parties.length) throw workbookError('ACTIVE_PARTY_EXISTS', 'Batch contains duplicate party numbers');
  for (const partyNumber of numbers) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':party:' || $2))`, [companyId, partyNumber]);
  }
  let lastChangeId = 0;
  const canonicalPartyIds = [];
  for (const party of payload.parties) {
    const partyAlias = await client.query(`SELECT canonical_party_id FROM party_id_aliases
      WHERE company_id = $1 AND legacy_party_id = $2`, [companyId, party.partyRecordId]);
    const canonicalPartyRecordId = partyAlias.rows[0]?.canonical_party_id || party.partyRecordId;
    canonicalPartyIds.push(canonicalPartyRecordId);
    const canonicalParty = canonicalPartyRecordId === party.partyRecordId
      ? party : { ...party, partyRecordId: canonicalPartyRecordId };
    const existing = await client.query(`SELECT p.id, p.status,
      EXISTS (SELECT 1 FROM legacy_party_collision_exceptions e
        WHERE e.company_id = p.company_id AND e.party_id = p.id AND e.status = 'ACTIVE') AS is_protected
      FROM parties p WHERE p.company_id = $1 AND p.id = $2 FOR UPDATE`, [companyId, canonicalPartyRecordId]);
    let mutation;
    if (existing.rows.length) {
      if (existing.rows[0].is_protected) continue;
      const itemEnvelope = { baseRevision: canonicalParty.baseRevision };
      mutation = await executeUpdateParty(client, companyId, operationId, canonicalParty, canonicalStringify(canonicalParty), itemEnvelope);
    } else {
      mutation = await options.executeCreateParty(client, companyId, operationId, canonicalParty, canonicalStringify(canonicalParty));
    }
    lastChangeId = Number(mutation.changeId || lastChangeId);
  }
  const settings = await executeUpdateBatchSettings(client, companyId, operationId, {
    availableSizes: payload.availableSizes,
    configs: payload.configs
  }, { baseRevision: payload.batchSettingsBaseRevision }, { skipRevision: true });
  lastChangeId = Math.max(lastChangeId, Number(settings.changeId || 0));
  const batchChange = await appendChange(client, companyId, 'patta_batch', payload.batchId, 1, operationId, 'INSERT',
    { batchId: payload.batchId, parties: canonicalPartyIds }, new Date().toISOString());
  lastChangeId = Number(batchChange.rows[0].change_id);
  return { serverRevision: 1, entityId: payload.batchId, changeId: lastChangeId, committedAt: batchChange.rows[0].committed_at };
}

async function executeCompletePartySeries(client, companyId, operationId, payload) {
  const period = await client.query(`SELECT id, start_date, end_date FROM periods WHERE company_id = $1 AND id = $2 AND is_closed = 0 FOR UPDATE`, [companyId, payload.periodId]);
  if (!period.rows.length) throw workbookError('PERIOD_NOT_FOUND', `Open period "${payload.periodId}" was not found`);
  if (payload.endDate < calendarDate(period.rows[0].start_date) || (period.rows[0].end_date && payload.endDate > calendarDate(period.rows[0].end_date))) {
    throw workbookError('INVALID_PERIOD_RANGE', 'Party series close date is outside the open period');
  }
  const now = new Date().toISOString();
  let lastChangeId = 0;
  const parties = await client.query(`UPDATE parties SET status = 'CLOSED', is_closed = 1, closed_at = $1,
    server_revision = server_revision + 1, updated_at = $1 WHERE company_id = $2 AND status != 'CLOSED'
    RETURNING id, server_revision`, [now, companyId]);
  for (const party of parties.rows) {
    const change = await appendChange(client, companyId, 'party', party.id, party.server_revision, operationId, 'UPDATE',
      { partyRecordId: party.id, isClosed: true, closedAt: now }, now);
    lastChangeId = Number(change.rows[0].change_id);
  }
  const tickets = await client.query(`UPDATE tickets SET is_closed = 1, server_revision = server_revision + 1
    WHERE company_id = $1 AND (period_id = $2 OR (period_id IS NULL AND submitted_at::date >= $3::date AND submitted_at::date <= $4::date))
      AND is_closed = 0 RETURNING id, server_revision`, [companyId, payload.periodId, period.rows[0].start_date, payload.endDate]);
  for (const ticket of tickets.rows) {
    const change = await appendChange(client, companyId, 'ticket', ticket.id, ticket.server_revision, operationId, 'UPDATE',
      { ticketId: ticket.id, isClosed: true }, now);
    lastChangeId = Number(change.rows[0].change_id);
  }
  const [modelRows, settingsRows] = await Promise.all([
    client.query(`SELECT id, color FROM models WHERE company_id = $1 AND status = 'ACTIVE' ORDER BY id`, [companyId]),
    client.query(`SELECT available_sizes_json FROM company_batch_settings WHERE company_id = $1`, [companyId])
  ]);
  const availableSizes = settingsRows.rows[0]?.available_sizes_json || [];
  const configs = modelRows.rows.map((model) => ({
    modelId: model.id,
    partyNumber: '',
    isCustomParty: false,
    totalIshSoni: '',
    color: model.color || 'Кора',
    sizes: Object.fromEntries(availableSizes.map((size) => [size, '']))
  }));
  await executeUpdateBatchSettings(client, companyId, operationId, { configs }, { baseRevision: null }, { skipRevision: true });
  const seriesChange = await appendChange(client, companyId, 'party_series', payload.periodId, 1, operationId, 'UPDATE',
    { periodId: payload.periodId, partiesClosed: parties.rows.length, ticketsClosed: tickets.rows.length }, now);
  lastChangeId = Number(seriesChange.rows[0].change_id);
  return { serverRevision: 1, entityId: payload.periodId, changeId: lastChangeId, committedAt: now };
}

async function executeArchivePartyHistory(client, companyId, operationId, payload) {
  const ids = [...payload.partyRecordIds].sort();
  const current = await client.query(`SELECT id FROM parties WHERE company_id = $1 AND id = ANY($2::varchar[]) FOR UPDATE`, [companyId, ids]);
  if (current.rows.length !== ids.length) throw workbookError('PARTY_NOT_FOUND', 'One or more parties to archive were not found');
  const now = new Date().toISOString();
  let lastChangeId = 0;
  for (const row of current.rows) {
    const updated = await client.query(`UPDATE parties SET status = 'CLOSED', is_closed = 1, is_archived = TRUE,
      closed_at = COALESCE(closed_at, $1), server_revision = server_revision + 1, updated_at = $1
      WHERE company_id = $2 AND id = $3 RETURNING server_revision`, [now, companyId, row.id]);
    const change = await appendChange(client, companyId, 'party', row.id, updated.rows[0].server_revision, operationId, 'UPDATE',
      { partyRecordId: row.id, status: 'CLOSED', isClosed: true, isArchived: true, closedAt: now }, now);
    lastChangeId = Number(change.rows[0].change_id);
  }
  const aggregate = await appendChange(client, companyId, 'party_history', companyId, 1, operationId, 'UPDATE',
    { partyRecordIds: ids, archivedAt: now }, now);
  lastChangeId = Number(aggregate.rows[0].change_id);
  return { serverRevision: 1, entityId: companyId, changeId: lastChangeId, committedAt: now };
}

async function executeWorkbookOperation(client, companyId, operationId, commandType, payload, canonicalJson, envelope, options = {}) {
  switch (commandType) {
    case 'UpsertModel': return executeUpsertModel(client, companyId, operationId, payload, canonicalJson, envelope);
    case 'DeactivateModel': return executeDeactivateModel(client, companyId, operationId, payload, envelope);
    case 'UpsertWorker': return executeUpsertWorker(client, companyId, operationId, payload, canonicalJson, envelope, options);
    case 'DeactivateWorker': return executeDeactivateWorker(client, companyId, operationId, payload, envelope);
    case 'CreatePeriod': return executeCreatePeriod(client, companyId, operationId, payload, envelope);
    case 'UpdatePeriod': return executeUpdatePeriod(client, companyId, operationId, payload, envelope);
    case 'ClosePeriod': return executeClosePeriod(client, companyId, operationId, payload, canonicalJson, envelope);
    case 'UpdateParty': return executeUpdateParty(client, companyId, operationId, payload, canonicalJson, envelope);
    case 'ArchivePartyHistory': return executeArchivePartyHistory(client, companyId, operationId, payload);
    case 'UpdateBatchSettings': return executeUpdateBatchSettings(client, companyId, operationId, payload, envelope);
    case 'CompletePattaBatch': return executeCompletePattaBatch(client, companyId, operationId, payload, canonicalJson, options);
    case 'CompletePartySeries': return executeCompletePartySeries(client, companyId, operationId, payload);
    case 'DeleteTicket': return executeDeleteTicket(client, companyId, operationId, payload);
    default: throw workbookError('UNKNOWN_COMMAND', `Unsupported workbook command type: ${commandType}`);
  }
}

async function executeDeleteTicket(client, companyId, operationId, payload) {
  const current = await client.query(`SELECT id, status, is_closed FROM tickets
    WHERE company_id = $1 AND id = $2 FOR UPDATE`, [companyId, payload.ticketId]);
  if (!current.rows.length) throw workbookError('TICKET_NOT_FOUND', `Ticket "${payload.ticketId}" was not found`);
  if (current.rows[0].status === 'VOIDED') throw workbookError('TICKET_ALREADY_DELETED', 'Ticket has already been deleted');
  if (current.rows[0].is_closed) throw workbookError('TICKET_PERIOD_CLOSED', 'Tickets in a closed period cannot be deleted');
  const now = new Date().toISOString();
  const updated = await client.query(`UPDATE tickets SET status = 'VOIDED', server_revision = server_revision + 1
    WHERE company_id = $1 AND id = $2 RETURNING server_revision`, [companyId, payload.ticketId]);
  const change = await appendChange(client, companyId, 'ticket', payload.ticketId, updated.rows[0].server_revision,
    operationId, 'UPDATE', { ticketId: payload.ticketId, status: 'VOIDED' }, now);
  return { serverRevision: updated.rows[0].server_revision, entityId: payload.ticketId,
    changeId: Number(change.rows[0].change_id), committedAt: now };
}

async function getPeriodArchive(pool, companyId, periodId) {
  const result = await pool.query(`SELECT archive_json, sha256, archived_at FROM period_archives WHERE company_id = $1 AND period_id = $2`, [companyId, periodId]);
  if (!result.rows.length) throw workbookError('PERIOD_ARCHIVE_NOT_FOUND', `Archive for period "${periodId}" was not found`);
  return result.rows[0];
}

module.exports = {
  executeWorkbookOperation,
  getPeriodArchive
};
