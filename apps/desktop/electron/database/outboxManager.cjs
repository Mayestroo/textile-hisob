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
  ['PENDING', new Set(['SENDING'])],
  ['SENDING', new Set(['SYNCED', 'PENDING', 'CONFLICT', 'DEAD_LETTER'])],
  ['SYNCED', new Set()], // terminal
  ['CONFLICT', new Set(['PENDING'])], // explicit manual retry
  ['DEAD_LETTER', new Set()] // terminal unless explicit recovery
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
      status, attempt_count, retry_count, last_error, error_message,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
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

  return stats;
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
  updateOperationStatus,
  getOutboxDiagnostics,
  recoverStrandedSendingOperations
};
