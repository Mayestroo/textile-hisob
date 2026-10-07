'use strict';

const { setLocalCursor } = require('./changeFeedApplier.cjs');

const BOOTSTRAP_COMPLETE_KEY = '_bootstrap_complete';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SAFE_NUMBER = Number.MAX_SAFE_INTEGER;
const MODEL_STATUSES = new Set(['ACTIVE', 'INACTIVE']);
const WORKER_STATUSES = new Set(['ACTIVE', 'INACTIVE']);
const PERIOD_STATUSES = new Set(['OPEN', 'CLOSING', 'CLOSED', 'CLOSED_ARCHIVED']);
const PARTY_STATUSES = new Set(['ACTIVE', 'CLOSE_PENDING', 'CLOSED']);
const TICKET_STATUSES = new Set(['CONFIRMED', 'PENDING_SYNC', 'CONFLICT', 'REJECTED', 'VOIDED']);
const PRODUCTION_ADJUSTMENT_STATUSES = new Set(['APPROVED', 'PENDING_REVIEW', 'REVERSED']);
const CANONICAL_TABLES = Object.freeze([
  'models', 'workers', 'periods', 'legacy_party_collision_exceptions', 'parties', 'worker_adjustments', 'tickets',
  'ticket_entries', 'production_adjustments', 'company_batch_settings',
  'patta_batch_settings', 'period_archives'
]);
const PG_BIGINT_MAX = 9223372036854775807n;

function bootstrapError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireCondition(condition) {
  if (!condition) throw bootstrapError('BOOTSTRAP_RESPONSE_INVALID');
}

function requireString(value) {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function requireNullableString(value) {
  return value === null || value === undefined || typeof value === 'string';
}

function requireNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_SAFE_NUMBER;
}

function requireTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function requireOptionalTimestamp(value) {
  return value === undefined || value === null || requireTimestamp(value);
}

function requireDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function requireOptionalDate(value) {
  return value === undefined || value === null || requireDate(value);
}

function requirePositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function requireRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertUnique(rows, getKey) {
  const keys = new Set();
  for (const row of rows) {
    const key = getKey(row);
    requireCondition(!keys.has(key));
    keys.add(key);
  }
}

function assertRowsOwned(rows, companyId) {
  requireCondition(Array.isArray(rows));
  for (const row of rows) {
    requireCondition(isObject(row) && row.companyId === companyId);
  }
}

function validateBootstrapResponse(response, companyId) {
  try {
    requireCondition(isObject(response) && response.success === true);
    requireCondition(requireString(companyId) && /^[A-Za-z0-9_-]{1,100}$/.test(companyId));
    requireCondition(isObject(response.snapshot));
    const snapshot = response.snapshot;
    requireCondition(snapshot.schemaVersion === 1);
    requireCondition(isObject(snapshot.company) && snapshot.company.companyId === companyId);

    requireCondition(typeof response.cursor === 'string' && /^\d{1,19}$/.test(response.cursor));
    const cursor = BigInt(response.cursor);
    requireCondition(cursor >= 0n && cursor <= PG_BIGINT_MAX);
    requireCondition(Number.isSafeInteger(response.nextPattaNumber) && response.nextPattaNumber >= 1);

    for (const forbidden of ['deletedWorkerIds', 'deletedModelIds', 'deletedPartyIds', 'deletedTicketIds', 'printedPattas', 'legacyState']) {
      requireCondition(!Object.prototype.hasOwnProperty.call(snapshot, forbidden));
    }

    const arrayFields = [
      'models', 'workers', 'periods', 'legacyPartyCollisionExceptions', 'parties',
      'workerAdjustments', 'tickets', 'productionAdjustments', 'periodArchives'
    ];
    for (const field of arrayFields) requireCondition(Array.isArray(snapshot[field]));
    requireCondition(isObject(snapshot.batchSettings));
    requireCondition(snapshot.batchSettings.company === null || isObject(snapshot.batchSettings.company));
    requireCondition(Array.isArray(snapshot.batchSettings.models));

    for (const field of arrayFields) assertRowsOwned(snapshot[field], companyId);
    if (snapshot.batchSettings.company) requireCondition(snapshot.batchSettings.company.companyId === companyId);
    assertRowsOwned(snapshot.batchSettings.models, companyId);

    assertUnique(snapshot.models, (row) => row.id);
    assertUnique(snapshot.workers, (row) => String(row.id));
    assertUnique(snapshot.periods, (row) => row.id);
    assertUnique(snapshot.parties, (row) => row.id);
    assertUnique(snapshot.workerAdjustments, (row) => row.id);
    assertUnique(snapshot.tickets, (row) => row.id);
    assertUnique(snapshot.productionAdjustments, (row) => row.adjustmentId);
    assertUnique(snapshot.periodArchives, (row) => row.periodId);
    assertUnique(snapshot.batchSettings.models, (row) => row.modelId);

    const modelIds = new Set();
    for (const model of snapshot.models) {
      requireCondition(requireString(model.id) && requireString(model.name));
      requireCondition(Array.isArray(model.operations) && Array.isArray(model.pattaOpsOrder));
      requireCondition(MODEL_STATUSES.has(model.status) && requireRevision(model.serverRevision));
      requireCondition(requireNullableString(model.hisobSheetName)
        && requireNullableString(model.title)
        && requireNullableString(model.party)
        && requireNullableString(model.color)
        && requireNullableString(model.size));
      requireCondition(requireOptionalTimestamp(model.createdAt) && requireOptionalTimestamp(model.updatedAt));
      for (const operation of model.operations) {
        requireCondition(typeof operation === 'string' || (isObject(operation) && requireString(operation.name)));
        if (isObject(operation) && operation.rate !== undefined) requireCondition(requireNumber(operation.rate));
      }
      requireCondition(model.pattaOpsOrder.every(requireString));
      modelIds.add(model.id);
    }

    const workerIds = new Set();
    for (const worker of snapshot.workers) {
      requireCondition(requirePositiveId(worker.id) && requireString(worker.name));
      requireCondition(requireNumber(worker.staj) && worker.staj >= 0);
      requireCondition(requireNullableString(worker.role) && WORKER_STATUSES.has(worker.status));
      requireCondition(requireNumber(worker.legacyAvans ?? 0) && requireNumber(worker.legacyJarima ?? 0));
      requireCondition(requireRevision(worker.serverRevision));
      requireCondition(requireOptionalTimestamp(worker.createdAt) && requireOptionalTimestamp(worker.updatedAt));
      workerIds.add(Number(worker.id));
    }

    const periodIds = new Set();
    for (const period of snapshot.periods) {
      requireCondition(requireString(period.id) && requireString(period.name) && requireDate(period.startDate));
      requireCondition(requireOptionalDate(period.endDate)
        && (period.isClosed === true || period.isClosed === false)
        && requireOptionalTimestamp(period.closedAt)
        && requireNullableString(period.notes)
        && requireNullableString(period.archiveFilename));
      requireCondition(PERIOD_STATUSES.has(period.status) && requireRevision(period.serverRevision));
      requireCondition(requireOptionalTimestamp(period.createdAt) && requireOptionalTimestamp(period.updatedAt));
      periodIds.add(period.id);
    }

    const partyIds = new Set();
    const partyById = new Map();
    for (const party of snapshot.parties) {
      requireCondition(requireString(party.id) && requireString(party.partyNumber));
      requireCondition(requireString(party.physicalPartyNumber) && modelIds.has(party.modelId));
      requireCondition(PARTY_STATUSES.has(party.status) && requireRevision(party.serverRevision));
      requireCondition(Number.isSafeInteger(party.pattaCount) && party.pattaCount >= 0);
      requireCondition(Number.isSafeInteger(party.cumulativePattaCount) && party.cumulativePattaCount >= 0);
      requireCondition(requireNumber(party.ishSoni) && requireNumber(party.cumulativeIshSoni));
      requireCondition((party.isClosed === true || party.isClosed === false)
        && (party.isArchived === true || party.isArchived === false));
      requireCondition(requireOptionalTimestamp(party.printedAt)
        && requireOptionalTimestamp(party.closedAt)
        && requireOptionalTimestamp(party.createdAt)
        && requireOptionalTimestamp(party.updatedAt));
      requireCondition(requireNullableString(party.modelName) && requireNullableString(party.color));
      requireCondition(party.ishSoniPerPatta === null || party.ishSoniPerPatta === undefined || requireNumber(party.ishSoniPerPatta));
      requireCondition(party.totalIshSoni === null || party.totalIshSoni === undefined || requireNumber(party.totalIshSoni));
      requireCondition(isObject(party.sizes) && Array.isArray(party.archivedPattaNumbers));
      partyIds.add(party.id);
      partyById.set(party.id, party);
    }

    const collisionExceptionIds = new Set();
    const collisionPartyIds = new Set();
    const collisionExceptionsByGroup = new Map();
    for (const exception of snapshot.legacyPartyCollisionExceptions) {
      requireCondition(isObject(exception) && exception.companyId === companyId);
      requireCondition(requireString(exception.exceptionId)
        && requireString(exception.partyNumber)
        && requireString(exception.partyId)
        && requireString(exception.collisionGroupId)
        && requireString(exception.approvedBy)
        && requireString(exception.reason)
        && exception.status === 'ACTIVE'
        && requireTimestamp(exception.approvedAt)
        && requireOptionalTimestamp(exception.createdAt));
      const party = partyById.get(exception.partyId);
      // Collision exceptions are attached to exact historical party IDs. They
      // can remain active provenance after those parties are closed; they do
      // not grant an exception to a new party that reuses the display number.
      requireCondition(party && party.partyNumber === exception.partyNumber);
      requireCondition(!collisionExceptionIds.has(exception.exceptionId));
      requireCondition(!collisionPartyIds.has(exception.partyId));
      collisionExceptionIds.add(exception.exceptionId);
      collisionPartyIds.add(exception.partyId);
      const groupKey = `${exception.partyNumber}:${exception.collisionGroupId}`;
      const groupPartyIds = collisionExceptionsByGroup.get(groupKey) || new Set();
      requireCondition(!groupPartyIds.has(exception.partyId));
      groupPartyIds.add(exception.partyId);
      collisionExceptionsByGroup.set(groupKey, groupPartyIds);
    }
    for (const groupPartyIds of collisionExceptionsByGroup.values()) {
      requireCondition(groupPartyIds.size === 2);
    }

    for (const adjustment of snapshot.workerAdjustments) {
      requireCondition(requireString(adjustment.id) && workerIds.has(Number(adjustment.workerId)));
      requireCondition(['AVANS', 'JARIMA'].includes(adjustment.type) && requireNumber(adjustment.amount));
      requireCondition(adjustment.periodId === null || adjustment.periodId === undefined || periodIds.has(adjustment.periodId));
      requireCondition(requireString(adjustment.provenance));
      requireCondition(requireOptionalTimestamp(adjustment.createdAt));
    }

    let entryCount = 0;
    const entryIds = new Set();
    for (const ticket of snapshot.tickets) {
      requireCondition(typeof ticket.id === 'string' && UUID_PATTERN.test(ticket.id) && modelIds.has(ticket.modelId));
      requireCondition(requireString(ticket.partyNumber));
      const hasPartyRecord = ticket.partyRecordId !== null && ticket.partyRecordId !== undefined;
      if (hasPartyRecord) {
        const party = partyById.get(ticket.partyRecordId);
        requireCondition(partyIds.has(ticket.partyRecordId));
        requireCondition(party.modelId === ticket.modelId && party.partyNumber === ticket.partyNumber);
      }
      requireCondition(ticket.periodId === null || ticket.periodId === undefined || periodIds.has(ticket.periodId));
      requireCondition(Number.isSafeInteger(ticket.pattaNumber)
        && (hasPartyRecord ? ticket.pattaNumber > 0 : ticket.pattaNumber >= 0));
      requireCondition(Number.isSafeInteger(ticket.qty) && ticket.qty > 0);
      requireCondition(TICKET_STATUSES.has(ticket.status) && Array.isArray(ticket.entries));
      requireCondition((ticket.isClosed === true || ticket.isClosed === false)
        && requireTimestamp(ticket.submittedAt)
        && requireOptionalTimestamp(ticket.createdAt)
        && requireNullableString(ticket.size)
        && requireNullableString(ticket.color)
        && requireNullableString(ticket.konveyer));
      assertUnique(ticket.entries, (entry) => entry.id);
      for (const entry of ticket.entries) {
        requireCondition(isObject(entry) && entry.companyId === companyId && requireString(entry.id));
        requireCondition(!entryIds.has(entry.id));
        entryIds.add(entry.id);
        requireCondition(requireString(entry.opName) && workerIds.has(Number(entry.workerId)));
        requireCondition(Number.isSafeInteger(entry.qty) && entry.qty > 0);
        requireCondition(entry.rateSnapshot === null || entry.rateSnapshot === undefined || requireNumber(entry.rateSnapshot));
        requireCondition(requireNullableString(entry.workerNameSnapshot)
          && requireNullableString(entry.brak)
          && requireOptionalTimestamp(entry.createdAt));
        entryCount += 1;
      }
    }

    for (const adjustment of snapshot.productionAdjustments) {
      requireCondition(requireString(adjustment.adjustmentId) && modelIds.has(adjustment.modelId));
      requireCondition(workerIds.has(Number(adjustment.workerId)) && requireString(adjustment.opName));
      requireCondition(requireNumber(adjustment.deltaQty) && PRODUCTION_ADJUSTMENT_STATUSES.has(adjustment.status));
      requireCondition(requireOptionalTimestamp(adjustment.createdAt)
        && requireNullableString(adjustment.reason)
        && requireNullableString(adjustment.createdBy));
    }

    if (snapshot.batchSettings.company) {
      requireCondition(Array.isArray(snapshot.batchSettings.company.availableSizes));
      requireCondition(requireRevision(snapshot.batchSettings.company.serverRevision));
      requireCondition(snapshot.batchSettings.company.availableSizes.every(requireString)
        && requireOptionalTimestamp(snapshot.batchSettings.company.updatedAt));
    }
    for (const config of snapshot.batchSettings.models) {
      requireCondition(modelIds.has(config.modelId));
      requireCondition(typeof config.partyNumber === 'string'
        && (config.partyNumber === '' ? config.isCustomParty === false : requireString(config.partyNumber)));
      requireCondition(typeof config.isCustomParty === 'boolean'
        && typeof config.totalIshSoni === 'string'
        && (config.totalIshSoni === '' || requireString(config.totalIshSoni)));
      requireCondition(isObject(config.sizes) && requireRevision(config.serverRevision));
      requireCondition(requireNullableString(config.color) && requireOptionalTimestamp(config.updatedAt));
    }
    for (const archive of snapshot.periodArchives) {
      requireCondition(periodIds.has(archive.periodId) && isObject(archive.archive));
      requireCondition(typeof archive.sha256 === 'string' && /^[a-f0-9]{64}$/.test(archive.sha256));
      requireCondition(requireTimestamp(archive.archivedAt));
    }

    const expectedCounts = {
      models: snapshot.models.length,
      workers: snapshot.workers.length,
      periods: snapshot.periods.length,
      legacyPartyCollisionExceptions: snapshot.legacyPartyCollisionExceptions.length,
      parties: snapshot.parties.length,
      workerAdjustments: snapshot.workerAdjustments.length,
      tickets: snapshot.tickets.length,
      ticketEntries: entryCount,
      productionAdjustments: snapshot.productionAdjustments.length,
      periodArchives: snapshot.periodArchives.length
    };
    requireCondition(isObject(response.counts));
    for (const [key, expected] of Object.entries(expectedCounts)) {
      requireCondition(Number.isSafeInteger(response.counts[key]) && response.counts[key] === expected);
    }
    return { snapshot, cursor: cursor.toString(), counts: expectedCounts, nextPattaNumber: response.nextPattaNumber };
  } catch (error) {
    if (error?.code === 'BOOTSTRAP_RESPONSE_INVALID') throw error;
    throw bootstrapError('BOOTSTRAP_RESPONSE_INVALID');
  }
}

function getExistingRowCounts(db) {
  const counts = {};
  for (const table of CANONICAL_TABLES) {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  }
  counts.local_outbox = Number(db.prepare('SELECT COUNT(*) AS count FROM local_outbox').get().count);
  return counts;
}

function getBootstrapState(db, companyId) {
  const marker = db.prepare('SELECT value FROM local_meta WHERE key = ?').get(BOOTSTRAP_COMPLETE_KEY);
  const cursorRow = db.prepare("SELECT value FROM local_meta WHERE key = 'sync_cursor'").get();
  if (!marker) {
    if (cursorRow) {
      throw bootstrapError('BOOTSTRAP_METADATA_INVALID', 'A sync cursor exists without the authoritative bootstrap completion marker');
    }
    const counts = getExistingRowCounts(db);
    if (Object.values(counts).some((count) => count > 0)) {
      throw bootstrapError('BOOTSTRAP_RECOVERY_REQUIRED', 'Local canonical data or outbox exists without a completed authoritative bootstrap');
    }
    return { status: 'NEEDS_BOOTSTRAP', companyId };
  }
  if (marker.value !== '1' || !cursorRow || typeof cursorRow.value !== 'string' || !/^\d{1,19}$/.test(cursorRow.value)) {
    throw bootstrapError('BOOTSTRAP_METADATA_INVALID', 'Completed bootstrap metadata or sync cursor is invalid');
  }
  let cursor;
  try { cursor = BigInt(cursorRow.value); } catch { throw bootstrapError('BOOTSTRAP_METADATA_INVALID'); }
  if (cursor < 0n || cursor > PG_BIGINT_MAX) throw bootstrapError('BOOTSTRAP_METADATA_INVALID');
  return { status: 'COMPLETE', companyId, cursor: cursor.toString() };
}

function insertBootstrapRows(db, companyId, snapshot, nextPattaNumber) {
  const insertModel = db.prepare(`INSERT INTO models (
    id, company_id, name, hisob_sheet_name, title, party, color, size, operations_json,
    patta_ops_order_json, legacy_hisob_quantities_json, created_at, updated_at, provenance,
    status, server_revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'REMOTE_BOOTSTRAP', ?, ?)`);
  for (const model of snapshot.models) {
    insertModel.run(model.id, companyId, model.name, model.hisobSheetName || null, model.title || null,
      model.party || null, model.color || null, model.size || null, JSON.stringify(model.operations),
      JSON.stringify(model.pattaOpsOrder), model.createdAt || new Date().toISOString(),
      model.updatedAt || model.createdAt || new Date().toISOString(), model.status, model.serverRevision);
  }

  const insertWorker = db.prepare(`INSERT INTO workers (
    id, company_id, name, staj, role, status, legacy_avans, legacy_jarima, created_at, updated_at,
    provenance, server_revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_BOOTSTRAP', ?)`);
  for (const worker of snapshot.workers) {
    insertWorker.run(worker.id, companyId, worker.name, worker.staj, worker.role || null, worker.status,
      worker.legacyAvans || 0, worker.legacyJarima || 0, worker.createdAt || new Date().toISOString(),
      worker.updatedAt || worker.createdAt || new Date().toISOString(), worker.serverRevision);
  }

  const insertPeriod = db.prepare(`INSERT INTO periods (
    id, company_id, name, start_date, end_date, is_closed, closed_at, notes, archive_filename,
    status, created_at, updated_at, server_revision, provenance
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_BOOTSTRAP')`);
  for (const period of snapshot.periods) {
    insertPeriod.run(period.id, companyId, period.name, period.startDate, period.endDate || null,
      period.isClosed ? 1 : 0, period.closedAt || null, period.notes || null, period.archiveFilename || null,
      period.status, period.createdAt || new Date().toISOString(),
      period.updatedAt || period.createdAt || new Date().toISOString(), period.serverRevision);
  }

  const insertCollisionException = db.prepare(`INSERT INTO legacy_party_collision_exceptions (
    exception_id, company_id, party_number, party_id, collision_group_id,
    approved_by, approved_at, reason, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const exception of snapshot.legacyPartyCollisionExceptions) {
    insertCollisionException.run(exception.exceptionId, companyId, exception.partyNumber, exception.partyId,
      exception.collisionGroupId, exception.approvedBy, exception.approvedAt, exception.reason,
      exception.status, exception.createdAt || new Date().toISOString());
  }

  const insertParty = db.prepare(`INSERT INTO parties (
    id, company_id, party_number, physical_party_number, model_id, model_name, color, patta_count,
    cumulative_patta_count, patta_start_number, patta_end_number,
    ish_soni_per_patta, total_ish_soni, ish_soni, cumulative_ish_soni,
    sizes_json, printed_at, is_closed, closed_at, archived_patta_numbers_json, status, created_at,
    updated_at, provenance, server_revision, is_archived
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_BOOTSTRAP', ?, ?)`);
  const partyIsProtected = db.prepare(`SELECT 1 FROM legacy_party_collision_exceptions
    WHERE company_id = ? AND party_id = ? AND status = 'ACTIVE' LIMIT 1`);
  const saveProtectedRange = db.prepare(`INSERT INTO protected_party_patta_ranges(
    company_id, party_record_id, patta_start_number, patta_end_number
  ) VALUES (?, ?, ?, ?) ON CONFLICT(company_id, party_record_id) DO UPDATE SET
    patta_start_number = excluded.patta_start_number, patta_end_number = excluded.patta_end_number`);
  for (const party of snapshot.parties) {
    const protectedRow = Boolean(partyIsProtected.get(companyId, party.id));
    insertParty.run(party.id, companyId, party.partyNumber, party.physicalPartyNumber, party.modelId,
      party.modelName || null, party.color || null, party.pattaCount, party.cumulativePattaCount,
      protectedRow ? null : party.pattaStartNumber ?? null,
      protectedRow ? null : party.pattaEndNumber ?? null,
      party.ishSoniPerPatta ?? null, party.totalIshSoni ?? null, party.ishSoni, party.cumulativeIshSoni,
      JSON.stringify(party.sizes), party.printedAt || null, party.isClosed ? 1 : 0, party.closedAt || null,
      JSON.stringify(party.archivedPattaNumbers), party.status, party.createdAt || new Date().toISOString(),
      party.updatedAt || party.createdAt || new Date().toISOString(), party.serverRevision, party.isArchived ? 1 : 0);
    if (protectedRow && Number.isSafeInteger(party.pattaStartNumber) && Number.isSafeInteger(party.pattaEndNumber)) {
      saveProtectedRange.run(companyId, party.id, party.pattaStartNumber, party.pattaEndNumber);
    }
  }
  db.prepare(`INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET next_patta_number = excluded.next_patta_number, updated_at = excluded.updated_at`)
    .run(companyId, nextPattaNumber, new Date().toISOString());

  const insertBalance = db.prepare(`INSERT INTO worker_adjustments (
    id, company_id, worker_id, period_id, type, amount, description, provenance, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'POSTED', ?)`);
  for (const adjustment of snapshot.workerAdjustments) {
    insertBalance.run(adjustment.id, companyId, adjustment.workerId, adjustment.periodId || null,
      adjustment.type, adjustment.amount, adjustment.provenance, adjustment.createdAt || new Date().toISOString());
  }

  const insertTicket = db.prepare(`INSERT INTO tickets (
    id, company_id, model_id, period_id, party_number, party_record_id, patta_number, qty, size,
    color, konveyer, status, is_closed, submitted_at, created_at, provenance, server_revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_BOOTSTRAP', ?)`);
  const insertEntry = db.prepare(`INSERT INTO ticket_entries (
    id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot, rate_snapshot, brak, qty, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const ticket of snapshot.tickets) {
    insertTicket.run(ticket.id, companyId, ticket.modelId, ticket.periodId || null, ticket.partyNumber,
      ticket.partyRecordId, ticket.pattaNumber, ticket.qty, ticket.size || null, ticket.color || null,
      ticket.konveyer || null, ticket.status, ticket.isClosed ? 1 : 0, ticket.submittedAt,
      ticket.createdAt || ticket.submittedAt, ticket.serverRevision);
    for (const entry of ticket.entries) {
      insertEntry.run(entry.id, ticket.id, companyId, entry.opName, entry.workerId,
        entry.workerNameSnapshot || null, entry.rateSnapshot ?? null, entry.brak || null,
        entry.qty, entry.createdAt || ticket.createdAt || ticket.submittedAt);
    }
  }

  const insertProduction = db.prepare(`INSERT INTO production_adjustments (
    adjustment_id, company_id, model_id, worker_id, op_name, delta_qty, reason, status,
    server_revision, provenance, created_at, created_by, original_adjustment_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_BOOTSTRAP', ?, ?, ?)`);
  for (const adjustment of snapshot.productionAdjustments) {
    insertProduction.run(adjustment.adjustmentId, companyId, adjustment.modelId, adjustment.workerId,
      adjustment.opName, adjustment.deltaQty, adjustment.reason || 'REMOTE_BOOTSTRAP', adjustment.status,
      adjustment.serverRevision, adjustment.createdAt || new Date().toISOString(),
      adjustment.createdBy || 'SERVER', adjustment.originalAdjustmentId || null);
  }

  if (snapshot.batchSettings.company) {
    const settings = snapshot.batchSettings.company;
    db.prepare(`INSERT INTO company_batch_settings (company_id, available_sizes_json, server_revision, updated_at)
      VALUES (?, ?, ?, ?)`)
      .run(companyId, JSON.stringify(settings.availableSizes), settings.serverRevision,
        settings.updatedAt || new Date().toISOString());
  }
  const insertModelSetting = db.prepare(`INSERT INTO patta_batch_settings (
    company_id, model_id, party_number, is_custom_party, total_ish_soni, color, sizes_json, server_revision, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const config of snapshot.batchSettings.models) {
    insertModelSetting.run(companyId, config.modelId, config.partyNumber, config.isCustomParty ? 1 : 0,
      config.totalIshSoni, config.color || null, JSON.stringify(config.sizes), config.serverRevision,
      config.updatedAt || new Date().toISOString());
  }

  const insertArchive = db.prepare(`INSERT INTO period_archives (company_id, period_id, archive_json, sha256, archived_at)
    VALUES (?, ?, ?, ?, ?)`);
  for (const archive of snapshot.periodArchives) {
    insertArchive.run(companyId, archive.periodId, JSON.stringify(archive.archive), archive.sha256, archive.archivedAt);
  }
}

function applyBootstrapSnapshot(db, companyId, response, options = {}) {
  const validated = validateBootstrapResponse(response, companyId);
  let result;
  const importTransaction = db.transaction(() => {
    const state = getBootstrapState(db, companyId);
    if (state.status === 'COMPLETE') {
      result = { status: 'ALREADY_BOOTSTRAPPED', cursor: state.cursor };
      return;
    }
    insertBootstrapRows(db, companyId, validated.snapshot, validated.nextPattaNumber);
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyViolations.length) {
      throw bootstrapError('BOOTSTRAP_FOREIGN_KEY_VIOLATION', 'Bootstrap rows violate canonical SQLite references');
    }
    setLocalCursor(db, validated.cursor);
    db.prepare(`INSERT INTO local_meta (key, value, updated_at) VALUES (?, '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(BOOTSTRAP_COMPLETE_KEY, new Date().toISOString());
    if (typeof options.testHookBeforeCommit === 'function') options.testHookBeforeCommit();
    result = { status: 'APPLIED', cursor: validated.cursor, counts: validated.counts };
  });
  importTransaction.immediate();
  return result;
}

module.exports = {
  BOOTSTRAP_COMPLETE_KEY,
  validateBootstrapResponse,
  getBootstrapState,
  applyBootstrapSnapshot
};
