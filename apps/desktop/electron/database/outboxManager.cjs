'use strict';

/**
 * Local Outbox Manager & State Machine Guard
 * Phase 2 — Step 3: Local Transactional Command Pipeline & Durable Outbox
 *
 * Enforces legal state transitions, company isolation, and local diagnostics.
 * Server network transport is NOT implemented in Step 3; the outbox remains strictly local.
 */

const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');

const LEGAL_TRANSITIONS = new Map([
  ['PENDING', new Set(['SENDING', 'SUPERSEDED'])],
  ['SENDING', new Set(['SYNCED', 'PENDING', 'CONFLICT', 'DEAD_LETTER'])],
  ['SYNCED', new Set()], // terminal
  ['CONFLICT', new Set(['PENDING', 'SUPERSEDED'])], // explicit retry or superseded by a newer accepted snapshot
  ['DEAD_LETTER', new Set(['PENDING'])] // only a validated voided-patta duplicate may be recovered
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

function acknowledgeOutboxOperation(db, companyId, operationId, acceptedPayloadHash) {
  const op = getOperation(db, companyId, operationId);
  if (!op || op.status === 'SYNCED') return false;
  if (acceptedPayloadHash && op.payload_hash !== acceptedPayloadHash) return false;
  if (!['PENDING', 'SENDING', 'CONFLICT', 'DEAD_LETTER'].includes(op.status)) return false;

  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE local_outbox
    SET status = 'SYNCED', last_error = NULL, error_message = NULL, updated_at = ?
    WHERE company_id = ? AND operation_id = ? AND status IN ('PENDING', 'SENDING', 'CONFLICT', 'DEAD_LETTER')
  `).run(now, companyId, operationId);
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
      sizes: config.sizes && typeof config.sizes === 'object' && !Array.isArray(config.sizes) ? config.sizes : {}
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
    const rows = db.prepare(`SELECT model_id, party_number, is_custom_party, total_ish_soni, color, sizes_json
      FROM patta_batch_settings WHERE company_id = ?`).all(companyId);
    currentConfigs = normalizeBatchSettingsConfigs(rows.map((row) => ({
      modelId: row.model_id,
      partyNumber: row.party_number,
      is_custom_party: row.is_custom_party,
      totalIshSoni: row.total_ish_soni,
      color: row.color,
      sizes: JSON.parse(row.sizes_json || '{}')
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

module.exports = {
  validateOutboxTransition,
  insertOutboxOperation,
  getOperation,
  listPendingOperations,
  listOutboxReconciliationCandidates,
  acknowledgeOutboxOperation,
  updateOperationStatus,
  getOutboxDiagnostics,
  supersedeBatchSettingsAlreadyApplied,
  recoverVoidedPattaDuplicateTickets,
  recoverStrandedSendingOperations
};
