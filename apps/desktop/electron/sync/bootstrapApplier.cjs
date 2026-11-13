'use strict';

const { setLocalCursor } = require('./changeFeedApplier.cjs');
const { recordSnapshotBaseline } = require('./feedEvidence.cjs');
const { quarantinePurgedOutboxOperation, isOutboxOperationPreCutoff } = require('../database/outbox/outboxManager.cjs');

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
    // New ledger collections are optional on older bootstrap servers. Normalize
    // absent collections to empty so upgrades do not force a destructive reset.
    snapshot.stajDebtClaims ||= [];
    snapshot.stajDebtEvents ||= [];
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
      'workerAdjustments', 'stajDebtClaims', 'stajDebtEvents', 'tickets', 'productionAdjustments', 'periodArchives'
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
    assertUnique(snapshot.stajDebtClaims, (row) => row.debtId);
    assertUnique(snapshot.stajDebtEvents, (row) => row.eventId);
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
    const closedPeriodIds = new Set();
    for (const period of snapshot.periods) {
      requireCondition(requireString(period.id) && requireString(period.name) && requireDate(period.startDate));
      requireCondition(requireOptionalDate(period.endDate)
        && (period.isClosed === true || period.isClosed === false)
        && requireOptionalTimestamp(period.closedAt)
        && requireNullableString(period.notes)
        && requireNullableString(period.archiveFilename));
      requireCondition(PERIOD_STATUSES.has(period.status) && requireRevision(period.serverRevision));
      requireCondition(requireOptionalTimestamp(period.createdAt) && requireOptionalTimestamp(period.updatedAt));
      requireCondition(period.closeOperationId == null || (/^[A-Za-z0-9_-]{1,128}$/.test(period.closeOperationId) && period.isClosed));
      periodIds.add(period.id);
      if (period.isClosed && period.closeOperationId) closedPeriodIds.add(period.id);
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
      requireCondition((party.endedAt == null) === (party.endedOperationId == null));
      requireCondition(party.endedAt == null || (requireTimestamp(party.endedAt) && /^[A-Za-z0-9_-]{1,128}$/.test(party.endedOperationId)));
      requireCondition(party.monthClosedPeriodId == null || closedPeriodIds.has(party.monthClosedPeriodId));
      requireCondition(requireNullableString(party.modelName) && requireNullableString(party.color));
      requireCondition(party.ishSoniPerPatta === null || party.ishSoniPerPatta === undefined || requireNumber(party.ishSoniPerPatta));
      requireCondition(party.totalIshSoni === null || party.totalIshSoni === undefined || requireNumber(party.totalIshSoni));
      requireCondition(isObject(party.sizes) && Array.isArray(party.archivedPattaNumbers));
      requireCondition(party.sizeOrder === undefined || party.sizeOrder === null
        || (Array.isArray(party.sizeOrder) && party.sizeOrder.length <= 128 && party.sizeOrder.every(requireString)));
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

    const adjustmentIds = new Set();
    for (const adjustment of snapshot.workerAdjustments) {
      requireCondition(requireString(adjustment.id) && workerIds.has(Number(adjustment.workerId)));
      requireCondition(['AVANS', 'JARIMA', 'OKLAD', 'MAGAZIN'].includes(adjustment.type) && requireNumber(adjustment.amount));
      requireCondition(adjustment.periodId === null || adjustment.periodId === undefined || periodIds.has(adjustment.periodId));
      requireCondition(!adjustmentIds.has(adjustment.id)); adjustmentIds.add(adjustment.id);
      if (['OKLAD', 'MAGAZIN'].includes(adjustment.type)) {
        requireCondition(typeof adjustment.periodId === 'string' && periodIds.has(adjustment.periodId));
        requireCondition(Number.isSafeInteger(Number(adjustment.amount)) && adjustment.status === 'POSTED');
      }
      if (adjustment.status !== undefined) requireCondition(adjustment.status === 'POSTED');
      requireCondition(requireString(adjustment.provenance));
      requireCondition(requireOptionalTimestamp(adjustment.createdAt));
    }

    const debtIds = new Set();
    for (const claim of snapshot.stajDebtClaims) {
      requireCondition(requireString(claim.debtId) && workerIds.has(Number(claim.workerId)));
      requireCondition(typeof claim.originalAmount === 'string' && /^\d+(?:\.\d{1,2})?$/.test(claim.originalAmount) && Number(claim.originalAmount) > 0);
      requireCondition(requireString(claim.evidenceReference) && /^[0-9a-f]{64}$/.test(claim.evidenceSha256));
      requireCondition(requireString(claim.verifiedBy) && requireString(claim.registeredOperationId));
      requireCondition(!debtIds.has(claim.debtId)); debtIds.add(claim.debtId);
    }
    const debtEventIds = new Set();
    for (const event of snapshot.stajDebtEvents) {
      requireCondition(debtIds.has(event.debtId) && requireString(event.eventId) && requireString(event.operationId));
      requireCondition(['DEDUCTION','DEFICIT_REVIEW','REVERSAL'].includes(event.eventType));
      requireCondition(typeof event.amount === 'string' && /^\d+(?:\.\d{1,2})?$/.test(event.amount) && Number(event.amount) > 0);
      requireCondition(event.periodId == null || periodIds.has(event.periodId));
      requireCondition(event.reversesEventId == null || typeof event.reversesEventId === 'string');
      requireCondition(requireString(event.actorId) && requireString(event.reason));
      requireCondition(!debtEventIds.has(event.eventId)); debtEventIds.add(event.eventId);
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
      requireCondition(config.sizeNames === undefined || config.sizeNames === null
        || (Array.isArray(config.sizeNames) && config.sizeNames.length <= 128 && config.sizeNames.every(requireString)));
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
     status, created_at, updated_at, server_revision, provenance, close_operation_id
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_BOOTSTRAP', ?)`);
  for (const period of snapshot.periods) {
    insertPeriod.run(period.id, companyId, period.name, period.startDate, period.endDate || null,
      period.isClosed ? 1 : 0, period.closedAt || null, period.notes || null, period.archiveFilename || null,
      period.status, period.createdAt || new Date().toISOString(),
       period.updatedAt || period.createdAt || new Date().toISOString(), period.serverRevision, period.closeOperationId || null);
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
    sizes_json, size_order_json, printed_at, is_closed, closed_at, archived_patta_numbers_json, status, created_at,
     updated_at, provenance, server_revision, is_archived, ended_at, ended_operation_id, month_closed_period_id
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_BOOTSTRAP', ?, ?, ?, ?, ?)`);
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
       JSON.stringify(party.sizes), party.sizeOrder == null ? null : JSON.stringify(party.sizeOrder), party.printedAt || null, party.isClosed ? 1 : 0, party.closedAt || null,
      JSON.stringify(party.archivedPattaNumbers), party.status, party.createdAt || new Date().toISOString(),
       party.updatedAt || party.createdAt || new Date().toISOString(), party.serverRevision, party.isArchived ? 1 : 0,
       party.endedAt || null, party.endedOperationId || null, party.monthClosedPeriodId || null);
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
  ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`);
  for (const adjustment of snapshot.workerAdjustments) {
    insertBalance.run(adjustment.id, companyId, adjustment.workerId, adjustment.periodId || null,
      adjustment.type, adjustment.amount, adjustment.provenance, adjustment.status || 'POSTED',
      adjustment.createdAt || new Date().toISOString());
  }

  const insertDebtClaim = db.prepare(`INSERT INTO staj_debt_claims(company_id,debt_id,worker_id,original_amount,
    evidence_reference,evidence_sha256,verification_note,verified_by,registered_operation_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  for (const claim of snapshot.stajDebtClaims) insertDebtClaim.run(companyId,claim.debtId,claim.workerId,claim.originalAmount,
    claim.evidenceReference,claim.evidenceSha256,claim.verificationNote,claim.verifiedBy,claim.registeredOperationId,claim.createdAt);
  const insertDebtEvent = db.prepare(`INSERT INTO staj_debt_events(company_id,event_id,debt_id,operation_id,event_type,amount,
    period_id,reverses_event_id,actor_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  for (const event of snapshot.stajDebtEvents) insertDebtEvent.run(companyId,event.eventId,event.debtId,event.operationId,
    event.eventType,event.amount,event.periodId,event.reversesEventId,event.actorId,event.reason,event.createdAt);

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
    server_revision, provenance, created_at, created_by, original_adjustment_id,
    original_ticket_id, original_entry_id, original_period_id, original_rate_snapshot, attribution_status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REMOTE_BOOTSTRAP', ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const adjustment of snapshot.productionAdjustments) {
    insertProduction.run(adjustment.adjustmentId, companyId, adjustment.modelId, adjustment.workerId,
      adjustment.opName, adjustment.deltaQty, adjustment.reason || 'REMOTE_BOOTSTRAP', adjustment.status,
      adjustment.serverRevision, adjustment.createdAt || new Date().toISOString(),
       adjustment.createdBy || 'SERVER', adjustment.originalAdjustmentId || null,
       adjustment.originalTicketId ?? null, adjustment.originalEntryId ?? null,
       adjustment.originalPeriodId ?? null, adjustment.originalRateSnapshot ?? null,
       adjustment.attributionStatus || 'UNRESOLVED');
  }

  if (snapshot.batchSettings.company) {
    const settings = snapshot.batchSettings.company;
    db.prepare(`INSERT INTO company_batch_settings (company_id, available_sizes_json, server_revision, updated_at)
      VALUES (?, ?, ?, ?)`)
      .run(companyId, JSON.stringify(settings.availableSizes), settings.serverRevision,
        settings.updatedAt || new Date().toISOString());
  }
  const insertModelSetting = db.prepare(`INSERT INTO patta_batch_settings (
    company_id, model_id, party_number, is_custom_party, total_ish_soni, color, sizes_json, size_names_json, server_revision, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const config of snapshot.batchSettings.models) {
    insertModelSetting.run(companyId, config.modelId, config.partyNumber, config.isCustomParty ? 1 : 0,
      config.totalIshSoni, config.color || null, JSON.stringify(config.sizes), config.sizeNames == null ? null : JSON.stringify(config.sizeNames), config.serverRevision,
      config.updatedAt || new Date().toISOString());
  }

  const insertArchive = db.prepare(`INSERT INTO period_archives (company_id, period_id, archive_json, sha256, archived_at)
    VALUES (?, ?, ?, ?, ?)`);
  for (const archive of snapshot.periodArchives) {
    insertArchive.run(companyId, archive.periodId, JSON.stringify(archive.archive), archive.sha256, archive.archivedAt);
  }
}

function extractPurgeEra(response) {
  if (!response || typeof response !== 'object') return null;
  if (response.purgeEra && typeof response.purgeEra === 'object') {
    return response.purgeEra;
  }
  const gen = response.purgeGeneration ?? response.feedBaseline?.purgeGeneration;
  if (gen === undefined || gen === null) return null;
  return {
    purgeGeneration: Number(gen),
    cutoffDate: response.purgeCutoffDate || '2026-10-08',
    cutoffUtc: response.purgeCutoffUtc || '2026-10-07T19:00:00.000Z',
    timezone: 'Asia/Tashkent',
    minValidCursor: response.minValidCursor !== undefined && response.minValidCursor !== null
      ? String(response.minValidCursor)
      : String(response.cursor ?? '0')
  };
}

function persistPurgeEraMeta(db, purgeEra, nowIso) {
  if (!purgeEra || typeof purgeEra !== 'object') return;
  const upsert = db.prepare(`INSERT INTO local_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  if (purgeEra.purgeGeneration !== undefined && purgeEra.purgeGeneration !== null) {
    upsert.run('purge_generation', String(purgeEra.purgeGeneration), nowIso);
  }
  if (purgeEra.cutoffDate) upsert.run('purge_cutoff_date', String(purgeEra.cutoffDate), nowIso);
  if (purgeEra.cutoffUtc) upsert.run('purge_cutoff_utc', String(purgeEra.cutoffUtc), nowIso);
  if (purgeEra.minValidCursor !== undefined && purgeEra.minValidCursor !== null) {
    upsert.run('purge_min_valid_cursor', String(purgeEra.minValidCursor), nowIso);
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
    const now = new Date().toISOString();
    setLocalCursor(db, validated.cursor);
    recordSnapshotBaseline(db, companyId, response.feedBaseline, validated.cursor);
    const appliedEra = extractPurgeEra(response);
    persistPurgeEraMeta(db, appliedEra, now);
    db.prepare(`INSERT INTO local_meta (key, value, updated_at) VALUES (?, '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(BOOTSTRAP_COMPLETE_KEY, now);
    if (typeof options.testHookBeforeCommit === 'function') options.testHookBeforeCommit();
    result = {
      status: 'APPLIED',
      cursor: validated.cursor,
      counts: validated.counts,
      purgeGeneration: appliedEra?.purgeGeneration ?? null
    };
  });
  importTransaction.immediate();
  return result;
}

/**
 * Replaces stale pre-purge SQLite snapshot rows with an authoritative post-purge server bootstrap,
 * quarantines pre-cutoff pending outbox commands (+ causal dependents) so they can never resurrect
 * deleted historical records, and preserves valid pending operations dated on/after cutoff.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @param {object} response
 * @param {object} [options={}]
 * @returns {object}
 */
function reapplyBootstrapAfterHistoricalPurge(db, companyId, response, options = {}) {
  const validated = validateBootstrapResponse(response, companyId);
  const era = extractPurgeEra(response);
  const cutoffDate = era?.cutoffDate || options.cutoffDate || '2026-10-08';
  const cutoffUtcMs = era?.cutoffUtc ? Date.parse(era.cutoffUtc) : Date.parse(options.cutoffUtc || '2026-10-07T19:00:00Z');

  let result;
  const rebootstrapTx = db.transaction(() => {
    const snapshotTicketIds = new Set(validated.snapshot.tickets.map((t) => t.id));
    const snapshotPartyIds = new Set(validated.snapshot.parties.map((p) => p.id));
    const snapshotPeriodIds = new Set(validated.snapshot.periods.map((p) => p.id));
    const snapshotAdjustmentIds = new Set(validated.snapshot.productionAdjustments.map((a) => a.adjustmentId));

    const localTicketSubmittedAtById = new Map(
      db.prepare('SELECT id, submitted_at FROM tickets WHERE company_id = ?').all(companyId).map((r) => [r.id, r.submitted_at])
    );
    const localPeriodEndDateById = new Map(
      db.prepare('SELECT id, end_date FROM periods WHERE company_id = ?').all(companyId).map((r) => [r.id, r.end_date])
    );
    const savedTicketForms = db.prepare('SELECT * FROM local_ticket_forms WHERE company_id = ?').all(companyId);

    const pendingOps = db.prepare(`
      SELECT * FROM local_outbox
      WHERE company_id = ? AND status IN ('PENDING', 'SENDING', 'CONFLICT')
      ORDER BY causal_sequence ASC, rowid ASC
    `).all(companyId);

    const quarantinedIds = new Set();
    const quarantinedOps = [];
    const preservedOps = [];
    const preservedNewTicketIds = new Set();
    const preservedNewPartyIds = new Set();
    const preservedNewPeriodIds = new Set();
    const preservedNewAdjustmentIds = new Set();

    for (const op of pendingOps) {
      const depId = typeof op.depends_on_operation_id === 'string' ? op.depends_on_operation_id.trim() : '';
      if (depId && quarantinedIds.has(depId)) {
        quarantinedIds.add(op.operation_id);
        quarantinedOps.push({ operationId: op.operation_id, reason: 'DEPENDS_ON_PURGED_OPERATION' });
        continue;
      }
      const verdict = isOutboxOperationPreCutoff(op, {
        cutoffDate,
        cutoffUtcMs,
        timezone: era?.timezone || 'Asia/Tashkent',
        snapshotTicketIds,
        snapshotPartyIds,
        snapshotPeriodIds,
        snapshotAdjustmentIds,
        preservedNewTicketIds,
        preservedNewPartyIds,
        preservedNewPeriodIds,
        preservedNewAdjustmentIds,
        localTicketSubmittedAtById,
        localPeriodEndDateById
      });
      if (verdict.preCutoff) {
        quarantinedIds.add(op.operation_id);
        quarantinedOps.push({ operationId: op.operation_id, reason: verdict.reason || 'PURGED_IN_HISTORICAL_RESET' });
        continue;
      }
      preservedOps.push(op);
      if (op.command_type === 'SubmitTicket' && op.entity_id) preservedNewTicketIds.add(op.entity_id);
      if (op.command_type === 'CreatePeriod' && op.entity_id) preservedNewPeriodIds.add(op.entity_id);
      if (op.command_type === 'RecordProductionAdjustment' && op.entity_id) preservedNewAdjustmentIds.add(op.entity_id);
      if (op.command_type === 'CreateParty' && op.entity_id) preservedNewPartyIds.add(op.entity_id);
      if (op.command_type === 'CompletePattaBatch') {
        try {
          const pl = JSON.parse(op.payload_json || '{}');
          for (const party of pl.parties || []) {
            if (party?.partyRecordId) preservedNewPartyIds.add(party.partyRecordId);
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    for (const item of quarantinedOps) {
      quarantinePurgedOutboxOperation(db, companyId, item.operationId, item.reason);
    }

    const provisionalPeriods = [];
    const provisionalParties = [];
    const provisionalTickets = [];
    const provisionalEntriesByTicket = new Map();
    const provisionalAdjustments = [];

    for (const op of preservedOps) {
      if (op.command_type === 'CreatePeriod' && !snapshotPeriodIds.has(op.entity_id)) {
        const row = db.prepare('SELECT * FROM periods WHERE company_id = ? AND id = ? AND server_revision = 0').get(companyId, op.entity_id);
        if (row) provisionalPeriods.push(row);
      } else if (op.command_type === 'CreateParty' && !snapshotPartyIds.has(op.entity_id)) {
        const row = db.prepare('SELECT * FROM parties WHERE company_id = ? AND id = ? AND server_revision = 0').get(companyId, op.entity_id);
        if (row) provisionalParties.push(row);
      } else if (op.command_type === 'CompletePattaBatch') {
        let pl = {};
        try { pl = JSON.parse(op.payload_json || '{}'); } catch { pl = {}; }
        for (const p of pl.parties || []) {
          if (p?.partyRecordId && !snapshotPartyIds.has(p.partyRecordId)) {
            const row = db.prepare('SELECT * FROM parties WHERE company_id = ? AND id = ? AND server_revision = 0').get(companyId, p.partyRecordId);
            if (row) provisionalParties.push(row);
          }
        }
      } else if (op.command_type === 'SubmitTicket' && !snapshotTicketIds.has(op.entity_id)) {
        const row = db.prepare('SELECT * FROM tickets WHERE company_id = ? AND id = ?').get(companyId, op.entity_id);
        if (row) {
          provisionalTickets.push(row);
          const entries = db.prepare('SELECT * FROM ticket_entries WHERE company_id = ? AND ticket_id = ?').all(companyId, op.entity_id);
          provisionalEntriesByTicket.set(op.entity_id, entries);
        }
      } else if (op.command_type === 'RecordProductionAdjustment' && !snapshotAdjustmentIds.has(op.entity_id)) {
        const row = db.prepare('SELECT * FROM production_adjustments WHERE company_id = ? AND adjustment_id = ? AND server_revision = 0').get(companyId, op.entity_id);
        if (row) provisionalAdjustments.push(row);
      }
    }

    db.prepare('DELETE FROM ticket_entries WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM tickets WHERE company_id = ?').run(companyId);
    db.prepare(`
      DELETE FROM production_adjustments
      WHERE company_id = ? AND original_adjustment_id IS NOT NULL
        AND adjustment_id NOT IN (
          SELECT created_adjustment_id FROM migration_reconciliation_resolutions
          WHERE company_id = ? AND created_adjustment_id IS NOT NULL
        )
    `).run(companyId, companyId);
    db.prepare(`
      DELETE FROM production_adjustments
      WHERE company_id = ?
        AND adjustment_id NOT IN (
          SELECT created_adjustment_id FROM migration_reconciliation_resolutions
          WHERE company_id = ? AND created_adjustment_id IS NOT NULL
        )
    `).run(companyId, companyId);
    db.prepare('DELETE FROM worker_adjustments WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM period_archives WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM protected_party_patta_ranges WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM legacy_party_collision_exceptions WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM parties WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM periods WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM patta_batch_settings WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM company_batch_settings WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM company_patta_sequences WHERE company_id = ?').run(companyId);
    db.prepare('DELETE FROM local_ticket_forms WHERE company_id = ?').run(companyId);

    const retainedWorkerIds = new Set(
      db.prepare('SELECT DISTINCT worker_id FROM production_adjustments WHERE company_id = ?').all(companyId).map((r) => Number(r.worker_id))
    );
    const retainedModelIds = new Set(
      db.prepare('SELECT DISTINCT model_id FROM production_adjustments WHERE company_id = ?').all(companyId).map((r) => r.model_id)
    );
    if (retainedWorkerIds.size === 0) db.prepare('DELETE FROM workers WHERE company_id = ?').run(companyId);
    else {
      for (const w of db.prepare('SELECT id FROM workers WHERE company_id = ?').all(companyId)) {
        if (!retainedWorkerIds.has(Number(w.id))) db.prepare('DELETE FROM workers WHERE company_id = ? AND id = ?').run(companyId, w.id);
      }
    }
    if (retainedModelIds.size === 0) db.prepare('DELETE FROM models WHERE company_id = ?').run(companyId);
    else {
      for (const m of db.prepare('SELECT id FROM models WHERE company_id = ?').all(companyId)) {
        if (!retainedModelIds.has(m.id)) db.prepare('DELETE FROM models WHERE company_id = ? AND id = ?').run(companyId, m.id);
      }
    }

    const filteredSnapshot = {
      ...validated.snapshot,
      models: retainedModelIds.size === 0 ? validated.snapshot.models : validated.snapshot.models.filter((m) => !retainedModelIds.has(m.id)),
      workers: retainedWorkerIds.size === 0 ? validated.snapshot.workers : validated.snapshot.workers.filter((w) => !retainedWorkerIds.has(Number(w.id)))
    };
    insertBootstrapRows(db, companyId, filteredSnapshot, validated.nextPattaNumber);

    const liveModelIds = new Set(validated.snapshot.models.map((m) => m.id));
    if (savedTicketForms.length > 0) {
      const restoreForm = db.prepare(`INSERT OR IGNORE INTO local_ticket_forms (
        company_id, model_id, form_json, updated_at
      ) VALUES (?, ?, ?, ?)`);
      for (const form of savedTicketForms) {
        if (!form.model_id || liveModelIds.has(form.model_id)) {
          restoreForm.run(form.company_id, form.model_id, form.form_json, form.updated_at);
        }
      }
    }

    for (const p of provisionalPeriods) {
      db.prepare(`INSERT OR IGNORE INTO periods (
        id, company_id, name, start_date, end_date, is_closed, closed_at, notes, archive_filename,
        status, created_at, updated_at, server_revision, provenance, close_operation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        p.id, p.company_id, p.name, p.start_date, p.end_date, p.is_closed, p.closed_at, p.notes,
        p.archive_filename, p.status, p.created_at, p.updated_at, p.server_revision, p.provenance, p.close_operation_id
      );
    }
    for (const party of provisionalParties) {
      if (!liveModelIds.has(party.model_id)) continue;
      db.prepare(`INSERT OR IGNORE INTO parties (
        id, company_id, party_number, physical_party_number, model_id, model_name, color, patta_count,
        cumulative_patta_count, patta_start_number, patta_end_number, ish_soni_per_patta, total_ish_soni,
        ish_soni, cumulative_ish_soni, sizes_json, size_order_json, printed_at, is_closed, closed_at,
        archived_patta_numbers_json, status, created_at, updated_at, provenance, server_revision,
        is_archived, ended_at, ended_operation_id, month_closed_period_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        party.id, party.company_id, party.party_number, party.physical_party_number, party.model_id,
        party.model_name, party.color, party.patta_count, party.cumulative_patta_count,
        party.patta_start_number, party.patta_end_number, party.ish_soni_per_patta, party.total_ish_soni,
        party.ish_soni, party.cumulative_ish_soni, party.sizes_json, party.size_order_json, party.printed_at,
        party.is_closed, party.closed_at, party.archived_patta_numbers_json, party.status, party.created_at,
        party.updated_at, party.provenance, party.server_revision, party.is_archived, party.ended_at,
        party.ended_operation_id, party.month_closed_period_id
      );
    }
    const currentPartyIds = new Set(db.prepare('SELECT id FROM parties WHERE company_id = ?').all(companyId).map((r) => r.id));
    const currentWorkerIds = new Set(db.prepare('SELECT id FROM workers WHERE company_id = ?').all(companyId).map((r) => Number(r.id)));
    for (const ticket of provisionalTickets) {
      if (!liveModelIds.has(ticket.model_id)) continue;
      if (ticket.party_record_id && !currentPartyIds.has(ticket.party_record_id)) continue;
      const entries = provisionalEntriesByTicket.get(ticket.id) || [];
      if (entries.some((e) => !currentWorkerIds.has(Number(e.worker_id)))) continue;
      db.prepare(`INSERT OR IGNORE INTO tickets (
        id, company_id, model_id, period_id, party_number, party_record_id, patta_number, qty, size,
        color, konveyer, status, is_closed, submitted_at, created_at, provenance, server_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ticket.id, ticket.company_id, ticket.model_id, ticket.period_id, ticket.party_number,
        ticket.party_record_id, ticket.patta_number, ticket.qty, ticket.size, ticket.color,
        ticket.konveyer, ticket.status, ticket.is_closed, ticket.submitted_at, ticket.created_at,
        ticket.provenance, ticket.server_revision
      );
      for (const e of entries) {
        db.prepare(`INSERT OR IGNORE INTO ticket_entries (
          id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot, rate_snapshot, brak, qty, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          e.id, e.ticket_id, e.company_id, e.op_name, e.worker_id, e.worker_name_snapshot,
          e.rate_snapshot, e.brak, e.qty, e.created_at
        );
      }
    }
    for (const adj of provisionalAdjustments) {
      if (!liveModelIds.has(adj.model_id) || !currentWorkerIds.has(Number(adj.worker_id))) continue;
      db.prepare(`INSERT OR IGNORE INTO production_adjustments (
        adjustment_id, company_id, model_id, worker_id, op_name, delta_qty, reason, status,
        server_revision, provenance, created_at, created_by, original_adjustment_id,
        original_ticket_id, original_entry_id, original_period_id, original_rate_snapshot, attribution_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        adj.adjustment_id, adj.company_id, adj.model_id, adj.worker_id, adj.op_name, adj.delta_qty,
        adj.reason, adj.status, adj.server_revision, adj.provenance, adj.created_at, adj.created_by,
        adj.original_adjustment_id, adj.original_ticket_id, adj.original_entry_id, adj.original_period_id,
        adj.original_rate_snapshot, adj.attribution_status
      );
    }

    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyViolations.length) {
      throw bootstrapError('BOOTSTRAP_FOREIGN_KEY_VIOLATION', 'Post-purge re-bootstrap rows violate canonical SQLite references');
    }

    const now = new Date().toISOString();
    setLocalCursor(db, validated.cursor);
    recordSnapshotBaseline(db, companyId, response.feedBaseline, validated.cursor);
    persistPurgeEraMeta(db, era, now);
    db.prepare(`INSERT INTO local_meta (key, value, updated_at) VALUES (?, '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(BOOTSTRAP_COMPLETE_KEY, now);
    db.prepare(`INSERT INTO local_meta (key, value, updated_at) VALUES ('last_rebootstrap_at', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(now, now);

    if (typeof options.testHookBeforeCommit === 'function') options.testHookBeforeCommit();

    result = {
      status: 'REBOOTSTRAPPED',
      cursor: validated.cursor,
      counts: validated.counts,
      quarantinedCount: quarantinedOps.length,
      quarantinedOperationIds: quarantinedOps.map((q) => q.operationId),
      quarantinedReasons: quarantinedOps,
      preservedPendingCount: preservedOps.length,
      preservedOperationIds: preservedOps.map((p) => p.operation_id),
      purgeGeneration: era?.purgeGeneration ?? null
    };
  });
  rebootstrapTx.immediate();
  return result;
}

module.exports = {
  BOOTSTRAP_COMPLETE_KEY,
  validateBootstrapResponse,
  getBootstrapState,
  applyBootstrapSnapshot,
  reapplyBootstrapAfterHistoricalPurge
};
