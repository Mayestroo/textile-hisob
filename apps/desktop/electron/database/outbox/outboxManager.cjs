'use strict';
const { ticketEntryId, legacyLocalTicketEntryId } = require('../../../../../packages/contracts/ticketEntryIdentity.cjs');

/**
 * Local Outbox Manager & State Machine Guard
 * Phase 2 — Step 3: Local Transactional Command Pipeline & Durable Outbox
 *
 * Enforces legal state transitions, company isolation, and local diagnostics.
 * Server network transport is NOT implemented in Step 3; the outbox remains strictly local.
 */

const { canonicalStringify, computePayloadHash } = require('../core/canonicalPayload.cjs');
const { businessDate } = require('../../../../../packages/domain/periodWriteGuard.cjs');
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatCalendarDateInTimezone(timestampIso, timezone = 'Asia/Tashkent') {
  if (typeof timestampIso !== 'string' || !timestampIso.trim()) return null;
  const ms = Date.parse(timestampIso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!map.year || !map.month || !map.day) return null;
  return `${map.year}-${map.month}-${map.day}`;
}

function resolvePurgeBusinessDate(effectiveDate, timestampIso, timezone = 'Asia/Tashkent') {
  if (effectiveDate !== undefined && effectiveDate !== null) {
    return businessDate(effectiveDate, timestampIso);
  }
  const zoned = formatCalendarDateInTimezone(timestampIso, timezone);
  if (zoned) return zoned;
  return businessDate(effectiveDate, timestampIso);
}

const LEGAL_TRANSITIONS = new Map([
  ['PENDING', new Set(['SENDING', 'SUPERSEDED'])],
  ['SENDING', new Set(['SYNCED', 'PENDING', 'CONFLICT', 'DEAD_LETTER'])],
  ['SYNCED', new Set()], // terminal
  ['CONFLICT', new Set(['PENDING', 'SUPERSEDED'])], // explicit retry or superseded by a newer accepted snapshot
  ['DEAD_LETTER', new Set(['PENDING', 'SUPERSEDED'])] // retry only by a validator or supersede after explicit local discard
]);

/**
 * Validates outbox state transitions according to strict lifecycle rules.
 * Fails closed if transition is illegal.
 *
 * @param {string} fromStatus
 * @param {string} toStatus
 */
function validateOutboxTransition(fromStatus, toStatus) {
  const allowed = LEGAL_TRANSITIONS.get(fromStatus);
  if (!allowed || !allowed.has(toStatus)) {
    const err = new Error(
      `INVALID_OUTBOX_TRANSITION: Cannot transition outbox operation from "${fromStatus}" to "${toStatus}"`
    );
    err.code = 'INVALID_OUTBOX_TRANSITION';
    err.fromStatus = fromStatus;
    err.toStatus = toStatus;
    throw err;
  }
}

/**
 * Inserts a new outbox operation inside an active transaction.
 * Fails closed if payload_hash is invalid or payload_json does not match canonical hash.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} op
 */
function insertOutboxOperation(db, op) {
  if (!op || typeof op !== 'object') {
    const err = new Error('INVALID_OUTBOX_PAYLOAD: Operation descriptor must be an object');
    err.code = 'INVALID_OUTBOX_PAYLOAD';
    throw err;
  }

  // 1. Mandatory payload_hash validation: exactly 64 lowercase hexadecimal characters
  if (typeof op.payload_hash !== 'string' || !/^[0-9a-f]{64}$/.test(op.payload_hash)) {
    const err = new Error(`INVALID_PAYLOAD_HASH: payload_hash must be a 64-character lowercase hex string. Received: ${JSON.stringify(op.payload_hash)}`);
    err.code = 'INVALID_PAYLOAD_HASH';
    throw err;
  }

  // 2. Validate payload_json and payload_hash consistency
  if (typeof op.payload_json !== 'string' || op.payload_json.trim().length === 0) {
    const err = new Error('MALFORMED_PAYLOAD_JSON: payload_json must be a non-empty string');
    err.code = 'MALFORMED_PAYLOAD_JSON';
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(op.payload_json);
  } catch (parseErr) {
    const err = new Error(`MALFORMED_PAYLOAD_JSON: Failed to parse payload_json: ${parseErr.message}`);
    err.code = 'MALFORMED_PAYLOAD_JSON';
    throw err;
  }

  let canonical;
  try {
    canonical = canonicalStringify(parsed);
  } catch (canonErr) {
    const err = new Error(`INVALID_PAYLOAD_JSON: Cannot canonicalize payload_json: ${canonErr.message}`);
    err.code = 'INVALID_PAYLOAD_JSON';
    throw err;
  }

  if (canonical !== op.payload_json) {
    const err = new Error('NON_CANONICAL_PAYLOAD_JSON: payload_json must be a canonical JSON string');
    err.code = 'NON_CANONICAL_PAYLOAD_JSON';
    throw err;
  }

  const computedHash = computePayloadHash(canonical);
  if (computedHash !== op.payload_hash) {
    const err = new Error(`PAYLOAD_HASH_MISMATCH: Computed hash (${computedHash}) does not match payload_hash (${op.payload_hash})`);
    err.code = 'PAYLOAD_HASH_MISMATCH';
    throw err;
  }

  const now = op.created_at || new Date().toISOString();
  const attemptCount = typeof op.attempt_count === 'number' ? op.attempt_count : 0;
  const retryCount = typeof op.retry_count === 'number' ? op.retry_count : 0;
  const lastError = op.last_error || null;
  const causalSeq = typeof op.causal_sequence === 'number' ? op.causal_sequence : 0;
  const payloadHash = op.payload_hash;

  const stmt = db.prepare(`
    INSERT INTO local_outbox (
      operation_id, company_id, command_type, entity_type, entity_id,
      base_revision, payload_json, payload_hash, depends_on_operation_id, causal_sequence,
      status, attempt_count, retry_count, last_error, error_message, local_archive_json,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?
    )
  `);

  stmt.run(
    op.operation_id,
    op.company_id,
    op.command_type,
    op.entity_type,
    op.entity_id,
    op.base_revision || 0,
    op.payload_json,
    payloadHash,
    op.depends_on_operation_id || null,
    causalSeq,
    op.status || 'PENDING',
    attemptCount,
    retryCount,
    lastError,
    lastError,
    op.local_archive_json || null,
    now,
    now
  );
}

/**
 * Gets an operation by companyId and operationId.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @param {string} operationId
 * @returns {object|null}
 */
function getOperation(db, companyId, operationId) {
  const row = db.prepare(`
    SELECT * FROM local_outbox
    WHERE company_id = ? AND operation_id = ?
  `).get(companyId, operationId);
  return row || null;
}

/**
 * Lists pending operations for a company ordered by causal sequence and creation time.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @param {number} [limit=100]
 * @returns {Array<object>}
 */
function listPendingOperations(db, companyId, limit = 100) {
  return db.prepare(`
    SELECT * FROM local_outbox
    WHERE company_id = ? AND status = 'PENDING'
    ORDER BY causal_sequence ASC, created_at ASC
    LIMIT ?
  `).all(companyId, limit);
}

function listOutboxReconciliationCandidates(db, companyId, limit = 100) {
  return db.prepare(`
    SELECT operation_id, payload_hash, status
    FROM local_outbox
    WHERE company_id = ? AND status IN ('PENDING', 'SENDING', 'CONFLICT', 'DEAD_LETTER')
    ORDER BY CASE status WHEN 'PENDING' THEN 0 WHEN 'SENDING' THEN 1 WHEN 'CONFLICT' THEN 2 ELSE 3 END,
      causal_sequence ASC, created_at ASC
    LIMIT ?
  `).all(companyId, limit);
}

/**
 * Returns immutable local evidence for allocation operations held for review.
 * This is deliberately read-only: the desktop cannot assert server acceptance
 * or clear a conflict without an authoritative server receipt.
 */
function listAllocationReviewOperations(db, companyId, limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number.isSafeInteger(limit) ? limit : 100));
  return db.prepare(`
    SELECT op.operation_id, op.command_type, op.entity_type, op.entity_id, op.payload_json,
      op.payload_hash, op.depends_on_operation_id, op.status, op.last_error, op.error_message,
      op.created_at, op.updated_at, intent.status AS cancellation_status,
      intent.result_json AS cancellation_result_json
    FROM local_outbox op
    LEFT JOIN allocation_resolution_intents intent
      ON intent.company_id = op.company_id AND intent.original_operation_id = op.operation_id
    WHERE op.company_id = ? AND op.command_type IN ('SubmitTicket', 'UpdateTicket')
      AND ((op.status = 'CONFLICT' AND (op.last_error LIKE '%ALLOCATION_REVIEW_REQUIRED%'
        OR op.error_message LIKE '%ALLOCATION_REVIEW_REQUIRED%'))
        OR (op.status = 'SUPERSEDED' AND op.last_error = 'SERVER_CANCELLED'))
    ORDER BY op.causal_sequence ASC, op.created_at ASC
    LIMIT ?
  `).all(companyId, safeLimit).map((row) => ({
    ...row,
    cancellation_result: (() => { try { return row.cancellation_result_json ? JSON.parse(row.cancellation_result_json) : null; } catch { return null; } })(),
    payload: (() => { try { return JSON.parse(row.payload_json); } catch { return null; } })()
  }));
}

function requeueAllocationReviewOperation(db, companyId, operationId) {
  return db.transaction(() => {
    const op = getOperation(db, companyId, operationId);
    if (!op || op.status !== 'CONFLICT' || !['SubmitTicket', 'UpdateTicket'].includes(op.command_type)
      || !String(op.last_error || op.error_message || '').includes('ALLOCATION_REVIEW_REQUIRED')) {
      const err = new Error('Allocation review operation is not eligible for retry'); err.code = 'ALLOCATION_RETRY_NOT_ELIGIBLE'; throw err;
    }
    if (!op.depends_on_operation_id) {
      const err = new Error('No recorded issuance dependency exists; retry cannot establish original issuance evidence'); err.code = 'ISSUANCE_DEPENDENCY_MISSING'; throw err;
    }
    const parent = getOperation(db, companyId, op.depends_on_operation_id);
    if (!parent || parent.status !== 'SYNCED' || parent.accepted_payload_hash !== parent.payload_hash) {
      const err = new Error('Original issuance is not confirmed by an exact server acceptance receipt'); err.code = 'ISSUANCE_NOT_ACCEPTED'; throw err;
    }
    validateOutboxTransition(op.status, 'PENDING');
    const now = new Date().toISOString();
    db.prepare(`UPDATE local_outbox SET status = 'PENDING', last_error = 'MANUAL_CAUSAL_RETRY',
      error_message = 'Manual retry after parent server acceptance', updated_at = ?
      WHERE company_id = ? AND operation_id = ? AND status = 'CONFLICT'`).run(now, companyId, operationId);
    return getOperation(db, companyId, operationId);
  })();
}

function queueAllocationCancellation(db, companyId, operationId, reason) {
  return db.transaction(() => {
    const op = getOperation(db, companyId, operationId);
    if (!op || !['SubmitTicket', 'UpdateTicket'].includes(op.command_type) || !['CONFLICT', 'PENDING'].includes(op.status)) {
      const err = new Error('Only an unaccepted ticket allocation may be cancelled'); err.code = 'ALLOCATION_NOT_CANCELLABLE'; throw err;
    }
    const resolutionOperationId = require('crypto').randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO allocation_resolution_intents
      (resolution_operation_id,company_id,original_operation_id,original_payload_hash,command_type,original_payload_json,reason,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'PENDING',?,?)`).run(resolutionOperationId, companyId, operationId, op.payload_hash,
      op.command_type, op.payload_json, reason, now, now);
    return { resolutionOperationId, operationId, payloadHash: op.payload_hash, commandType: op.command_type, payload: JSON.parse(op.payload_json), reason, status: 'PENDING' };
  })();
}

function listPendingAllocationCancellations(db, companyId) {
  return db.prepare(`SELECT * FROM allocation_resolution_intents WHERE company_id=? AND status='PENDING' ORDER BY created_at`).all(companyId);
}

function acknowledgeAllocationCancellation(db, companyId, resolutionOperationId, result) {
  return db.transaction(() => {
    const intent = db.prepare(`SELECT * FROM allocation_resolution_intents WHERE company_id=? AND resolution_operation_id=?`).get(companyId, resolutionOperationId);
    if (!intent) throw new Error('Allocation cancellation intent not found');
    if (result?.status !== 'CANCELLED' || result?.resolutionOperationId !== resolutionOperationId) throw new Error('Invalid authoritative cancellation receipt');
    const original = getOperation(db, companyId, intent.original_operation_id);
    if (!original || original.payload_hash !== intent.original_payload_hash) throw new Error('Local original allocation evidence changed');
    if (original.status !== 'SUPERSEDED') {
      validateOutboxTransition(original.status, 'SUPERSEDED');
      db.prepare(`UPDATE local_outbox SET status='SUPERSEDED', last_error='SERVER_CANCELLED',
        error_message='Authoritatively cancelled by accountant; stale replay fenced by server', updated_at=?
        WHERE company_id=? AND operation_id=?`).run(new Date().toISOString(), companyId, intent.original_operation_id);
    }
    db.prepare(`UPDATE allocation_resolution_intents SET status='ACKNOWLEDGED',result_json=?,updated_at=?
      WHERE company_id=? AND resolution_operation_id=?`).run(JSON.stringify(result), new Date().toISOString(), companyId, resolutionOperationId);
    return result;
  })();
}

function rejectAllocationCancellation(db, companyId, resolutionOperationId, error) {
  db.prepare(`UPDATE allocation_resolution_intents SET status='REJECTED',result_json=?,updated_at=?
    WHERE company_id=? AND resolution_operation_id=? AND status='PENDING'`)
    .run(JSON.stringify({ code: error?.code || 'ALLOCATION_CANCELLATION_REJECTED', message: error?.message || 'Rejected by server' }),
      new Date().toISOString(), companyId, resolutionOperationId);
}

function acknowledgeOutboxOperation(db, companyId, operationId, acceptedPayloadHash, serverRevision, acceptedChangeId = null) {
  const op = getOperation(db, companyId, operationId);
  if (!op) return false;
  if (op.status === 'SYNCED' && op.accepted_payload_hash === acceptedPayloadHash
    && Number(op.accepted_server_revision) === Number(serverRevision)
    && String(op.accepted_change_id || '') === String(acceptedChangeId || '')) return false;
  if (acceptedPayloadHash !== op.payload_hash || !/^[a-f0-9]{64}$/.test(acceptedPayloadHash)
    || !Number.isSafeInteger(Number(serverRevision)) || Number(serverRevision) < 1) return false;
  if (!['PENDING', 'SENDING', 'SYNCED', 'CONFLICT', 'DEAD_LETTER'].includes(op.status)) return false;

  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE local_outbox
    SET status = 'SYNCED', accepted_payload_hash = ?, accepted_server_revision = ?, accepted_change_id = ?,
      last_error = NULL, error_message = NULL, updated_at = ?
    WHERE company_id = ? AND operation_id = ? AND payload_hash = ?
      AND status IN ('PENDING', 'SENDING', 'SYNCED', 'CONFLICT', 'DEAD_LETTER')
  `).run(acceptedPayloadHash, Number(serverRevision), acceptedChangeId == null ? null : String(acceptedChangeId),
    now, companyId, operationId, acceptedPayloadHash);
  return result.changes === 1;
}

/**
 * Updates an operation's status with transition validation.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @param {string} operationId
 * @param {string} newStatus
 * @param {string|null} [errorDetails=null]
 * @returns {object} Updated operation row
 */
function updateOperationStatus(db, companyId, operationId, newStatus, errorDetails = null) {
  const op = getOperation(db, companyId, operationId);
  if (!op) {
    const err = new Error(`Outbox operation not found: ${operationId} for company ${companyId}`);
    err.code = 'OPERATION_NOT_FOUND';
    throw err;
  }

  validateOutboxTransition(op.status, newStatus);

  const now = new Date().toISOString();
  let newAttemptCount = op.attempt_count || 0;
  let newRetryCount = op.retry_count || 0;

  if (newStatus === 'SENDING') {
    newAttemptCount += 1;
    newRetryCount = Math.max(0, newAttemptCount - 1);
  }

  db.prepare(`
    UPDATE local_outbox
    SET status = ?,
        attempt_count = ?,
        retry_count = ?,
        last_error = ?,
        error_message = ?,
        updated_at = ?
    WHERE company_id = ? AND operation_id = ?
  `).run(
    newStatus,
    newAttemptCount,
    newRetryCount,
    errorDetails || op.last_error,
    errorDetails || op.error_message,
    now,
    companyId,
    operationId
  );

  return getOperation(db, companyId, operationId);
}

/**
 * Returns outbox diagnostic summary without dumping sensitive payloads.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @returns {object} OutboxDiagnostics
 */
function getOutboxDiagnostics(db, companyId) {
  const counts = db.prepare(`
    SELECT status, COUNT(*) as cnt
    FROM local_outbox
    WHERE company_id = ?
    GROUP BY status
  `).all(companyId);

  const stats = {
    companyId,
    pendingCount: 0,
    sendingCount: 0,
    syncedCount: 0,
    conflictCount: 0,
    deadLetterCount: 0,
    oldestPendingCreatedAt: null
  };

  for (const row of counts) {
    if (row.status === 'PENDING') stats.pendingCount = row.cnt;
    else if (row.status === 'SENDING') stats.sendingCount = row.cnt;
    else if (row.status === 'SYNCED') stats.syncedCount = row.cnt;
    else if (row.status === 'CONFLICT') stats.conflictCount = row.cnt;
    else if (row.status === 'DEAD_LETTER') stats.deadLetterCount = row.cnt;
  }

  const oldest = db.prepare(`
    SELECT created_at
    FROM local_outbox
    WHERE company_id = ? AND status = 'PENDING'
    ORDER BY created_at ASC
    LIMIT 1
  `).get(companyId);

  if (oldest) {
    stats.oldestPendingCreatedAt = oldest.created_at;
  }

  stats.pendingErrors = db.prepare(`
    SELECT command_type, status, last_error, error_message, updated_at
    FROM local_outbox
    WHERE company_id = ? AND status IN ('PENDING', 'SENDING')
      AND (last_error IS NOT NULL OR error_message IS NOT NULL)
    ORDER BY updated_at DESC, causal_sequence DESC
    LIMIT 5
  `).all(companyId);

  stats.failedOperations = db.prepare(`
    SELECT command_type, status, last_error, error_message, updated_at
    FROM local_outbox
    WHERE company_id = ? AND status IN ('CONFLICT', 'DEAD_LETTER')
    ORDER BY updated_at DESC, causal_sequence DESC
    LIMIT 5
  `).all(companyId);

  return stats;
}

function normalizeBatchSettingsConfigs(configs) {
  if (!Array.isArray(configs)) return null;
  const normalized = [];
  for (const config of configs) {
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || typeof config.modelId !== 'string' || !config.modelId) return null;
    normalized.push({
      modelId: config.modelId,
      partyNumber: config.partyNumber || '',
      isCustomParty: config.isCustomParty === true || Number(config.is_custom_party) === 1,
      totalIshSoni: config.totalIshSoni || '',
      color: config.color || '',
      sizes: config.sizes && typeof config.sizes === 'object' && !Array.isArray(config.sizes) ? config.sizes : {},
      ...(Object.prototype.hasOwnProperty.call(config, 'sizeNames') ? { sizeNames: config.sizeNames } : {})
    });
  }
  normalized.sort((left, right) => left.modelId.localeCompare(right.modelId));
  return normalized;
}

function supersedeBatchSettingsAlreadyApplied(db, companyId) {
  const current = db.prepare(`SELECT available_sizes_json, server_revision
    FROM company_batch_settings WHERE company_id = ?`).get(companyId);
  if (!current || !Number.isSafeInteger(Number(current.server_revision))) return 0;

  let availableSizes;
  try { availableSizes = JSON.parse(current.available_sizes_json || '[]'); } catch { return 0; }
  if (!Array.isArray(availableSizes)) return 0;

  let currentConfigs;
  try {
    const rows = db.prepare(`SELECT model_id, party_number, is_custom_party, total_ish_soni, color, sizes_json, size_names_json
      FROM patta_batch_settings WHERE company_id = ?`).all(companyId);
    currentConfigs = normalizeBatchSettingsConfigs(rows.map((row) => ({
      modelId: row.model_id,
      partyNumber: row.party_number,
      is_custom_party: row.is_custom_party,
      totalIshSoni: row.total_ish_soni,
      color: row.color,
      sizes: JSON.parse(row.sizes_json || '{}'),
      ...(row.size_names_json == null ? {} : { sizeNames: JSON.parse(row.size_names_json) })
    })));
  } catch {
    return 0;
  }
  if (!currentConfigs) return 0;

  const candidates = db.prepare(`SELECT operation_id, base_revision, payload_json, last_error, error_message, status
    FROM local_outbox WHERE company_id = ? AND command_type = 'UpdateBatchSettings'
      AND status IN ('PENDING', 'CONFLICT') ORDER BY causal_sequence, created_at`).all(companyId);
  let superseded = 0;
  for (const candidate of candidates) {
    if (Number(candidate.base_revision) >= Number(current.server_revision)) continue;
    if (candidate.status === 'CONFLICT') {
      let error;
      try { error = JSON.parse(candidate.last_error || candidate.error_message || '{}'); } catch { continue; }
      if (error?.code !== 'REVISION_CONFLICT') continue;
    }
    let payload;
    try { payload = JSON.parse(candidate.payload_json); } catch { continue; }
    const payloadConfigs = normalizeBatchSettingsConfigs(payload.configs);
    if (!Array.isArray(payload.availableSizes) || !payloadConfigs
      || canonicalStringify(payload.availableSizes) !== canonicalStringify(availableSizes)
      || canonicalStringify(payloadConfigs) !== canonicalStringify(currentConfigs)) continue;

    updateOperationStatus(db, companyId, candidate.operation_id, 'SUPERSEDED', 'SUPERSEDED_BY_AUTHORITATIVE_BATCH_SETTINGS');
    superseded++;
  }
  return superseded;
}

function isVoidedPattaUniqueViolation(errorValue) {
  if (typeof errorValue !== 'string' || !errorValue) return false;
  try {
    const error = JSON.parse(errorValue);
    return error?.code === '23505' && typeof error.message === 'string'
      && error.message.includes('idx_tickets_party_patta');
  } catch {
    return false;
  }
}

function recoverLegacyPattaBatches(db, companyId) {
  const { isLegacyPattaBatch, capturedPattaRange } = require('../../../../../packages/domain/legacyPattaBatch.cjs');
  return db.transaction(() => {
    const rows = db.prepare(`SELECT * FROM local_outbox WHERE company_id=?
      AND command_type='CompletePattaBatch' AND status IN ('CONFLICT','DEAD_LETTER')
      ORDER BY causal_sequence, rowid`).all(companyId);
    let recovered = 0;
    for (const row of rows) {
      let payload;
      let error;
      try {
        payload = JSON.parse(row.payload_json);
        error = JSON.parse(row.last_error || row.error_message || '{}');
      } catch { continue; }
      const missingRevision = error?.code === 'REVISION_CONFLICT'
        && /^Batch settings revision is missing(?: or invalid)?; reload before printing$/.test(error.message || '');
      const activePartyConflict = error?.code === 'ACTIVE_PARTY_EXISTS';
      // Real CAS, range and identity conflicts remain visible. An old duplicate
      // refusal is retryable only with authoritative evidence of the SAME paper.
      if ((!missingRevision && !activePartyConflict)
        || !isLegacyPattaBatch(payload) || payload?.companyId !== companyId
        || payload.operationId !== row.operation_id || payload.batchId !== row.entity_id
        || row.entity_type !== 'patta_batch'
        || computePayloadHash(canonicalStringify(payload)) !== row.payload_hash
        || !Array.isArray(payload.parties) || !payload.parties.length
        || payload.parties.some((party) => !capturedPattaRange(party) || !party.printedAt)) continue;
      if (activePartyConflict) {
        const recoveryKey = `legacy_patta_active_party_retry_v1:${row.operation_id}`;
        if (db.prepare('SELECT 1 FROM local_meta WHERE key = ?').get(recoveryKey)) continue;
        const matches = payload.parties.every((party) => {
          const alias = db.prepare(`SELECT canonical_party_id FROM party_id_aliases
            WHERE company_id = ? AND legacy_party_id = ?`).get(companyId, party.partyRecordId);
          const current = db.prepare(`SELECT * FROM parties WHERE company_id = ? AND id = ? AND server_revision > 0`)
            .get(companyId, alias?.canonical_party_id || party.partyRecordId);
          if (!current) return false;
          const modelAlias = db.prepare(`SELECT canonical_model_id FROM model_id_aliases
            WHERE company_id = ? AND legacy_model_id = ?`).get(companyId, party.modelId);
          const range = capturedPattaRange(party);
          const sameQuantity = (a, b) => a == null ? b == null : b != null && Number(a) === Number(b);
          try {
            return current.party_number === party.partyNumber
              && current.model_id === (modelAlias?.canonical_model_id || party.modelId)
              && Number(current.patta_count) === party.pattaCount
              && Number(current.patta_start_number) === range.start
              && Number(current.patta_end_number) === range.end
              && sameQuantity(current.ish_soni_per_patta, party.ishSoniPerPatta)
              && canonicalStringify(JSON.parse(current.sizes_json || '{}')) === canonicalStringify(party.sizes || {})
              && (party.sizeOrder == null || canonicalStringify(JSON.parse(current.size_order_json)) === canonicalStringify(party.sizeOrder));
          } catch { return false; }
        });
        if (!matches) continue;
        // Persist the retry together with its status transition. If the server
        // refuses again, reconnect must not repeatedly resend the same command.
        db.prepare(`INSERT INTO local_meta(key, value, updated_at) VALUES (?, ?, ?)`)
          .run(recoveryKey, row.payload_hash, new Date().toISOString());
      }
      updateOperationStatus(db, companyId, row.operation_id, 'PENDING', 'RETRY_LEGACY_PATTA_BATCH_UNCHANGED');
      recovered++;
    }
    return recovered;
  })();
}

function recoverVoidedPattaDuplicateTickets(db, companyId) {
  const operations = db.prepare(`SELECT * FROM local_outbox
    WHERE company_id = ? AND command_type = 'SubmitTicket' AND status = 'DEAD_LETTER'
    ORDER BY causal_sequence, created_at`).all(companyId);
  let recovered = 0;
  for (const operation of operations) {
    if (Number(operation.attempt_count) !== 1
      || (!isVoidedPattaUniqueViolation(operation.last_error) && !isVoidedPattaUniqueViolation(operation.error_message))) continue;
    let payload;
    try { payload = JSON.parse(operation.payload_json); } catch { continue; }
    if (typeof payload.partyRecordId !== 'string' || !payload.partyRecordId
      || !Number.isSafeInteger(payload.pattaNumber) || payload.pattaNumber < 1) continue;
    const releasedTicket = db.prepare(`SELECT 1 FROM tickets
      WHERE company_id = ? AND party_record_id = ? AND patta_number = ? AND status = 'VOIDED' AND id <> ?
      LIMIT 1`).get(companyId, payload.partyRecordId, payload.pattaNumber, payload.ticketId);
    if (!releasedTicket) continue;
    updateOperationStatus(db, companyId, operation.operation_id, 'PENDING', 'RETRY_AFTER_VOIDED_PATTA_RELEASE');
    recovered++;
  }
  return recovered;
}

function recoverPeriodScopeMismatchTickets(db, companyId) {
  const operations = db.prepare(`SELECT * FROM local_outbox
    WHERE company_id = ? AND command_type = 'SubmitTicket' AND status = 'DEAD_LETTER'
    ORDER BY causal_sequence, created_at`).all(companyId);
  const openPeriods = db.prepare(`SELECT id, start_date, end_date FROM periods
    WHERE company_id = ? AND is_closed = 0 ORDER BY start_date DESC, id DESC`).all(companyId);
  if (!openPeriods.length) return 0;

  let recovered = 0;
  for (const operation of operations) {
    const attemptCount = Number(operation.attempt_count);
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 1 || attemptCount > 2) continue;
    let error;
    let payload;
    try {
      error = JSON.parse(operation.last_error || operation.error_message || '{}');
      payload = JSON.parse(operation.payload_json);
    } catch {
      continue;
    }
    if (error?.code !== 'PERIOD_SCOPE_MISMATCH') continue;
    const effectiveDate = typeof payload.effectiveDate === 'string'
      ? payload.effectiveDate
      : typeof payload.submittedAt === 'string' ? payload.submittedAt.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) continue;
    const matchingPeriod = openPeriods.find((period) => {
      const startDate = String(period.start_date || '').slice(0, 10);
      const endDate = period.end_date ? String(period.end_date).slice(0, 10) : null;
      return effectiveDate >= startDate && (!endDate || effectiveDate <= endDate);
    });
    // A different captured ID is an accounting conflict, not a retryable
    // opportunity to attach this ticket to the receipt-time period.
    if (!matchingPeriod || payload.periodId !== matchingPeriod.id) continue;

    // Retry unchanged intent only if local authority still agrees with capture.
    updateOperationStatus(db, companyId, operation.operation_id, 'PENDING', 'RETRY_AFTER_PERIOD_SCOPE_RECONCILIATION');
    recovered++;
  }
  return recovered;
}

// Retry only batch05B's obsolete provenance refusals after verifying the exact
// queued capture against the local fact. Closed-period intent stays visible.
function recoverCapturedTicketProvenanceTickets(db, companyId) {
  const operations = db.prepare(`SELECT * FROM local_outbox WHERE company_id = ?
    AND command_type = 'SubmitTicket' AND status = 'DEAD_LETTER'`).all(companyId);
  const openPeriods = db.prepare(`SELECT id, start_date, end_date FROM periods
    WHERE company_id = ? AND is_closed = 0`).all(companyId);
  const closedPeriods = db.prepare(`SELECT start_date, end_date FROM periods
    WHERE company_id = ? AND is_closed = 1`).all(companyId);
  let recovered = 0;
  for (const operation of operations) {
    let error;
    let payload;
    try {
      error = JSON.parse(operation.last_error || operation.error_message || '{}');
      payload = JSON.parse(operation.payload_json);
    } catch { continue; }
    if (!['TICKET_RATE_PROVENANCE_REQUIRED', 'TICKET_PERIOD_PROVENANCE_REQUIRED'].includes(error?.code)
      || computePayloadHash(canonicalStringify(payload)) !== operation.payload_hash
      || payload.companyId !== companyId || payload.operationId !== operation.operation_id
      || payload.ticketId !== operation.entity_id || !Array.isArray(payload.entries) || !payload.entries.length) continue;
    const ticket = db.prepare('SELECT period_id, status, submitted_at FROM tickets WHERE company_id = ? AND id = ?')
      .get(companyId, payload.ticketId);
    if (!ticket || ticket.status !== 'PENDING_SYNC' || (ticket.period_id || null) !== (payload.periodId || null)) continue;
    const date = payload.effectiveDate || String(payload.submittedAt || ticket.submitted_at || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const match = openPeriods.filter(p => date >= String(p.start_date).slice(0, 10)
      && (!p.end_date || date <= String(p.end_date).slice(0, 10)));
    if (closedPeriods.some(p => date >= String(p.start_date).slice(0, 10)
      && (!p.end_date || date <= String(p.end_date).slice(0, 10)))) continue;
    if (openPeriods.length && (match.length !== 1 || (payload.periodId && match[0].id !== payload.periodId))) continue;
    const localEntries = db.prepare(`SELECT id, op_name, worker_id, rate_snapshot FROM ticket_entries
      WHERE company_id = ? AND ticket_id = ?`).all(companyId, payload.ticketId);
    const byId = new Map(localEntries.map(entry => [entry.id, entry]));
    if (localEntries.length !== payload.entries.length
      || payload.entries.some((entry, index) => {
        const local = byId.get(ticketEntryId(payload.ticketId, index))
          || byId.get(legacyLocalTicketEntryId(payload.ticketId, index, entry.opName, entry.workerId));
        return !local || local.op_name !== entry.opName || String(local.worker_id) !== String(entry.workerId)
          || local.rate_snapshot !== (entry.rateSnapshot ?? null);
      })) continue;
    updateOperationStatus(db, companyId, operation.operation_id, 'PENDING', 'RETRY_CAPTURED_TICKET_UNCHANGED');
    recovered++;
  }
  return recovered;
}

/**
 * Recovers stranded SENDING operations back to PENDING on startup/initialization.
 *
 * Requirements:
 * - Affects only active company database.
 * - Affects only rows with status = 'SENDING'.
 * - Transitions SENDING -> PENDING (legal transition in state machine).
 * - Leaves attempt_count and retry_count unchanged.
 * - Sets machine-readable diagnostic last_error = 'RECOVERED_STRANDED_SENDING'
 *   and error_message = 'RECOVERED_STRANDED_SENDING'.
 * - Preserves immutable fields: operation_id, payload_json, payload_hash, command_type,
 *   entity_type, entity_id, base_revision, depends_on_operation_id, causal_sequence, created_at.
 * - Runs entirely inside a single local SQLite transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @returns {Array<object>} Array of recovered operation rows
 */
function recoverStrandedSendingOperations(db, companyId) {
  if (!companyId || typeof companyId !== 'string') {
    const err = new Error('INVALID_COMPANY_ID: companyId must be a non-empty string');
    err.code = 'INVALID_COMPANY_ID';
    throw err;
  }

  return db.transaction(() => {
    // 1. Fetch only SENDING rows for the active company
    const stranded = db.prepare(`
      SELECT * FROM local_outbox
      WHERE company_id = ? AND status = 'SENDING'
      ORDER BY causal_sequence ASC, created_at ASC
    `).all(companyId);

    if (stranded.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    const updateStmt = db.prepare(`
      UPDATE local_outbox
      SET status = 'PENDING',
          last_error = 'RECOVERED_STRANDED_SENDING',
          error_message = 'RECOVERED_STRANDED_SENDING',
          updated_at = ?
      WHERE company_id = ? AND operation_id = ? AND status = 'SENDING'
    `);

    for (const op of stranded) {
      // Validate transition from SENDING to PENDING
      validateOutboxTransition(op.status, 'PENDING');
      updateStmt.run(now, companyId, op.operation_id);
    }

    return db.prepare(`
      SELECT * FROM local_outbox
      WHERE company_id = ? AND last_error = 'RECOVERED_STRANDED_SENDING' AND status = 'PENDING'
      ORDER BY causal_sequence ASC, created_at ASC
    `).all(companyId);
  })();
}

/**
 * Quarantines an outbox operation blocked by an authoritative historical purge era.
 * Leaves immutable semantic columns untouched so triggers are respected and telemetry survives.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @param {string} operationId
 * @param {string} reason
 * @returns {object}
 */
function quarantinePurgedOutboxOperation(db, companyId, operationId, reason = 'PURGED_IN_HISTORICAL_RESET') {
  const op = getOperation(db, companyId, operationId);
  if (!op) {
    const err = new Error(`Outbox operation not found: ${operationId} for company ${companyId}`);
    err.code = 'OPERATION_NOT_FOUND';
    throw err;
  }
  if (!['PENDING', 'SENDING', 'CONFLICT', 'DEAD_LETTER'].includes(op.status)) {
    const err = new Error(`Cannot quarantine outbox operation ${operationId} from terminal state ${op.status}`);
    err.code = 'INVALID_OUTBOX_TRANSITION';
    throw err;
  }
  const now = new Date().toISOString();
  const detail = String(reason || 'PURGED_IN_HISTORICAL_RESET');
  db.prepare(`
    UPDATE local_outbox
    SET status = 'DEAD_LETTER',
        last_error = ?,
        error_message = ?,
        updated_at = ?
    WHERE company_id = ? AND operation_id = ?
  `).run(detail, detail, now, companyId, operationId);
  return getOperation(db, companyId, operationId);
}

function parseTimestampMs(raw) {
  if (!raw || typeof raw !== 'string') return NaN;
  return Date.parse(raw);
}

/**
 * Classifies whether a queued local outbox operation targets pre-cutoff historical state.
 *
 * @param {object} op
 * @param {object} [context={}]
 * @returns {{ preCutoff: boolean, reason: string|null }}
 */
function isOutboxOperationPreCutoff(op, context = {}) {
  const cutoffDate = context.cutoffDate || '2026-10-08';
  const cutoffUtcMs = Number.isFinite(context.cutoffUtcMs) ? context.cutoffUtcMs : Date.parse('2026-10-07T19:00:00Z');
  let payload = {};
  try {
    payload = typeof op.payload_json === 'string' ? JSON.parse(op.payload_json) : (op.payload_json || {});
  } catch {
    return { preCutoff: true, reason: 'INVALID_OUTBOX_PAYLOAD_PRE_QUARANTINE' };
  }

  const commandType = op.command_type;
  const createdMs = parseTimestampMs(op.created_at);

  if (commandType === 'SubmitTicket') {
    const effective = resolvePurgeBusinessDate(payload.effectiveDate, payload.submittedAt, context.timezone);
    if (effective < cutoffDate) {
      return { preCutoff: true, reason: 'PURGED_PRE_CUTOFF_SUBMIT_TICKET' };
    }
    const partyId = payload.partyRecordId;
    if (partyId && context.snapshotPartyIds && !context.snapshotPartyIds.has(partyId) && !context.preservedNewPartyIds?.has(partyId)) {
      return { preCutoff: true, reason: 'PURGED_REFERENCED_PARTY_MISSING' };
    }
    return { preCutoff: false, reason: null };
  }

  if (commandType === 'UpdateTicket' || commandType === 'DeleteTicket') {
    const ticketId = payload.ticketId || op.entity_id;
    const localSubmitted = context.localTicketSubmittedAtById?.get(ticketId);
    if (localSubmitted && resolvePurgeBusinessDate(null, localSubmitted, context.timezone) < cutoffDate) {
      return { preCutoff: true, reason: 'PURGED_PRE_CUTOFF_TICKET_MUTATION' };
    }
    if (context.snapshotTicketIds && !context.snapshotTicketIds.has(ticketId) && !context.preservedNewTicketIds?.has(ticketId)) {
      return { preCutoff: true, reason: 'PURGED_REFERENCED_TICKET_MISSING' };
    }
    return { preCutoff: false, reason: null };
  }

  if (commandType === 'RecordProductionAdjustment' || commandType === 'ReverseProductionAdjustment') {
    if (typeof payload.effectiveDate === 'string' && ISO_DATE_RE.test(payload.effectiveDate) && payload.effectiveDate < cutoffDate) {
      return { preCutoff: true, reason: 'PURGED_PRE_CUTOFF_PRODUCTION_ADJUSTMENT' };
    }
    const adjCreatedMs = parseTimestampMs(payload.createdAt);
    if (Number.isFinite(adjCreatedMs) && adjCreatedMs < cutoffUtcMs) {
      return { preCutoff: true, reason: 'PURGED_PRE_CUTOFF_PRODUCTION_ADJUSTMENT' };
    }
    if (Number.isFinite(createdMs) && createdMs < cutoffUtcMs) {
      return { preCutoff: true, reason: 'PURGED_PRE_CUTOFF_PRODUCTION_ADJUSTMENT' };
    }
    if (commandType === 'ReverseProductionAdjustment' && payload.originalAdjustmentId
      && context.snapshotAdjustmentIds && !context.snapshotAdjustmentIds.has(payload.originalAdjustmentId)
      && !context.preservedNewAdjustmentIds?.has(payload.originalAdjustmentId)) {
      return { preCutoff: true, reason: 'PURGED_REFERENCED_ADJUSTMENT_MISSING' };
    }
    return { preCutoff: false, reason: null };
  }

  if (commandType === 'CreatePeriod' || commandType === 'UpdatePeriod' || commandType === 'ClosePeriod') {
    if (typeof payload.endDate === 'string' && ISO_DATE_RE.test(payload.endDate) && payload.endDate < cutoffDate) {
      return { preCutoff: true, reason: 'PURGED_PRE_CUTOFF_PERIOD' };
    }
    const periodId = payload.periodId || op.entity_id;
    const localEnd = context.localPeriodEndDateById?.get(periodId);
    if (localEnd && ISO_DATE_RE.test(localEnd) && localEnd < cutoffDate) {
      return { preCutoff: true, reason: 'PURGED_PRE_CUTOFF_PERIOD' };
    }
    if ((commandType === 'UpdatePeriod' || commandType === 'ClosePeriod') && context.snapshotPeriodIds
      && !context.snapshotPeriodIds.has(periodId) && !context.preservedNewPeriodIds?.has(periodId)) {
      return { preCutoff: true, reason: 'PURGED_REFERENCED_PERIOD_MISSING' };
    }
    return { preCutoff: false, reason: null };
  }

  if (commandType === 'UpdateBatchSettings') {
    if (Number.isFinite(createdMs) && createdMs < cutoffUtcMs) {
      return { preCutoff: true, reason: 'PURGED_PRE_CUTOFF_BATCH_SETTINGS' };
    }
    return { preCutoff: false, reason: null };
  }

  if (['CompletePattaBatch', 'CompletePartySeries', 'ArchivePartyHistory', 'CreateParty', 'UpdateParty', 'CloseParty'].includes(commandType)) {
    if (Number.isFinite(createdMs) && createdMs < cutoffUtcMs) {
      return { preCutoff: true, reason: 'PURGED_PRE_CUTOFF_PARTY_OPERATION' };
    }
    if (['UpdateParty', 'CloseParty', 'ArchivePartyHistory'].includes(commandType)) {
      const targetPartyId = payload.partyRecordId || op.entity_id;
      if (targetPartyId && context.snapshotPartyIds && !context.snapshotPartyIds.has(targetPartyId)
        && !context.preservedNewPartyIds?.has(targetPartyId)) {
        return { preCutoff: true, reason: 'PURGED_REFERENCED_PARTY_MISSING' };
      }
    }
    return { preCutoff: false, reason: null };
  }

  return { preCutoff: false, reason: null };
}

module.exports = {
  validateOutboxTransition,
  insertOutboxOperation,
  getOperation,
  listPendingOperations,
  listOutboxReconciliationCandidates,
  listAllocationReviewOperations,
  requeueAllocationReviewOperation,
  queueAllocationCancellation,
  listPendingAllocationCancellations,
  acknowledgeAllocationCancellation,
  rejectAllocationCancellation,
  acknowledgeOutboxOperation,
  updateOperationStatus,
  quarantinePurgedOutboxOperation,
  isOutboxOperationPreCutoff,
  getOutboxDiagnostics,
  supersedeBatchSettingsAlreadyApplied,
  recoverVoidedPattaDuplicateTickets,
  recoverLegacyPattaBatches,
  recoverPeriodScopeMismatchTickets,
  recoverCapturedTicketProvenanceTickets,
  recoverStrandedSendingOperations
};
