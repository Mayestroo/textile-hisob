'use strict';

/**
 * Local Transactional Command Pipeline
 * Phase 2 — Step 3: Local Transactional Command Pipeline & Durable Outbox (Correction Pass)
 *
 * Implements the core local write seam in Electron Main.
 * Enforces:
 * - INV-01: Idempotency (one operationId = one immutable semantic command via canonical SHA-256 fingerprint)
 * - INV-02: Atomicity (canonical fact + outbox committed in ONE SQLite transaction)
 * - INV-03: Projection purity (totals never stored as mutable canonical state)
 * - INV-11: PENDING_SYNC ticket excluded from authoritative accounting
 * - Company isolation: active company, command company, DB path company must agree
 * - Model operations integrity: all ticket entries must match target model operations
 * - Causal dependency validation: sequence and dependency integrity
 */

const { isSafeCompanyId } = require('./companyPath.cjs');
const { getCompanyDatabase } = require('./databaseManager.cjs');
const { insertOutboxOperation, getOperation } = require('./outboxManager.cjs');
const { rebuildCompanyProjections } = require('./projectionReader.cjs');
const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');
const { assertPeriodOpen } = require('../../../../packages/domain/periodWriteGuard.cjs');

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createCommandError(code, message, details = {}) {
  const err = new Error(`[CommandError: ${code}] ${message}`);
  err.name = 'CommandError';
  err.code = code;
  err.details = details;
  return err;
}

function validateCompanyContext(activeCompanyId, commandCompanyId) {
  if (!commandCompanyId || typeof commandCompanyId !== 'string' || !isSafeCompanyId(commandCompanyId)) {
    throw createCommandError('INVALID_COMPANY_ID', `Invalid companyId: "${commandCompanyId}"`);
  }
  if (activeCompanyId && activeCompanyId !== commandCompanyId) {
    throw createCommandError(
      'CROSS_COMPANY_REJECTED',
      `Active company context (${activeCompanyId}) does not match command companyId (${commandCompanyId})`
    );
  }
}

function assertPositiveSafeInteger(val, fieldName) {
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val <= 0) {
    throw createCommandError(
      'INVALID_TICKET_QUANTITY',
      `Field "${fieldName}" must be a positive safe integer (> 0). Received: ${String(val)} (${typeof val})`
    );
  }
  return val;
}

function assertFiniteNumber(val, fieldName) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw createCommandError(
      'INVALID_QUANTITY',
      `Field "${fieldName}" must be a finite number. Received: ${String(val)} (${typeof val})`
    );
  }
  return val;
}

function assertNonEmptyString(val, fieldName) {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw createCommandError('INVALID_FIELD', `Field "${fieldName}" must be a non-empty string. Received: ${String(val)}`);
  }
  return val.trim();
}

function assertCanonicalTicketUuid(val) {
  const ticketId = assertNonEmptyString(val, 'ticketId');
  if (!CANONICAL_UUID.test(ticketId)) {
    throw createCommandError('INVALID_TICKET_UUID', 'ticketId must be an RFC 4122 canonical UUID');
  }
  return ticketId;
}

/**
 * Validates causal dependency and sequence consistency.
 *
 * Rules:
 * - dependsOnOperationId cannot equal operationId (self-dependency rejected)
 * - when dependsOnOperationId is absent: causalSequence must be 0 (if provided, must be safe integer 0)
 * - when dependsOnOperationId is present: causalSequence must be a safe integer >= 1
 *
 * @param {string} operationId
 * @param {string|null|undefined} dependsOnOperationId
 * @param {number|null|undefined} causalSequence
 * @returns {number} Validated causal sequence integer
 */
function validateCausalOrdering(operationId, dependsOnOperationId, causalSequence) {
  if (dependsOnOperationId !== undefined && dependsOnOperationId !== null && String(dependsOnOperationId).trim() !== '') {
    const depId = String(dependsOnOperationId).trim();
    if (depId === operationId) {
      throw createCommandError(
        'SELF_CAUSAL_DEPENDENCY',
        `Operation "${operationId}" cannot depend on itself`
      );
    }
    if (causalSequence !== undefined && causalSequence !== null) {
      if (typeof causalSequence !== 'number' || !Number.isSafeInteger(causalSequence) || causalSequence < 1) {
        throw createCommandError(
          'INVALID_CAUSAL_SEQUENCE',
          `When dependsOnOperationId is present, causalSequence must be a safe integer >= 1. Received: ${String(causalSequence)}`
        );
      }
      return causalSequence;
    }
    return 1;
  } else {
    // No dependency present
    if (causalSequence !== undefined && causalSequence !== null) {
      if (typeof causalSequence !== 'number' || !Number.isSafeInteger(causalSequence) || causalSequence < 0) {
        throw createCommandError(
          'INVALID_CAUSAL_SEQUENCE',
          `causalSequence must be a non-negative safe integer (>= 0). Received: ${String(causalSequence)}`
        );
      }
      if (causalSequence !== 0) {
        throw createCommandError(
          'INVALID_CAUSAL_SEQUENCE',
          `When dependsOnOperationId is absent, causalSequence must be 0. Received: ${String(causalSequence)}`
        );
      }
    }
    return 0;
  }
}

/**
 * Executes a SubmitTicketCommand inside ONE SQLite transaction.
 *
 * @param {string} baseUserDataPath
 * @param {string} activeCompanyId
 * @param {object} command
 * @param {object} [options={}] Test-only options (failure injection hooks)
 * @param {object} [options.testHooks]
 * @param {() => void} [options.testHooks.afterFactInsert]
 * @param {() => void} [options.testHooks.afterOutboxInsert]
 * @param {() => void} [options.testHooks.beforeCommit]
 * @returns {object} CommandResult
 */
function executeSubmitTicketCommand(baseUserDataPath, activeCompanyId, command, options = {}) {
  if (!command || typeof command !== 'object') {
    throw createCommandError('INVALID_COMMAND_PAYLOAD', 'SubmitTicketCommand must be a valid object');
  }

  const companyId = assertNonEmptyString(command.companyId, 'companyId');
  validateCompanyContext(activeCompanyId, companyId);

  const commandId = assertNonEmptyString(command.commandId, 'commandId');
  const operationId = assertNonEmptyString(command.operationId, 'operationId');
  const ticketId = assertCanonicalTicketUuid(command.ticketId);
  const modelId = assertNonEmptyString(command.modelId, 'modelId');
  const partyNumber = assertNonEmptyString(command.partyNumber, 'partyNumber');
  const partyRecordId = command.partyRecordId === undefined || command.partyRecordId === null || command.partyRecordId === ''
    ? null
    : assertNonEmptyString(command.partyRecordId, 'partyRecordId');
  const periodId = command.periodId === undefined || command.periodId === null || command.periodId === ''
    ? null
    : assertNonEmptyString(command.periodId, 'periodId');

  if (typeof command.pattaNumber !== 'number' || !Number.isSafeInteger(command.pattaNumber) || command.pattaNumber < 0) {
    throw createCommandError(
      'INVALID_PATTA_NUMBER',
      `pattaNumber must be a non-negative safe integer. Received: ${String(command.pattaNumber)}`
    );
  }
  const pattaNumber = command.pattaNumber;

  const qty = assertPositiveSafeInteger(command.qty, 'qty');

  if (!Array.isArray(command.entries) || command.entries.length === 0) {
    throw createCommandError('INVALID_ENTRIES', 'Ticket entries must be a non-empty array');
  }

  // Validate each entry structure
  const entries = command.entries.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw createCommandError('INVALID_ENTRY', `Entry at index ${idx} must be an object`);
    }
    const opName = assertNonEmptyString(entry.opName, `entries[${idx}].opName`);
    const workerId = entry.workerId;
    if (workerId === undefined || workerId === null || (typeof workerId !== 'number' && typeof workerId !== 'string') || String(workerId).trim() === '') {
      throw createCommandError('INVALID_WORKER_ID', `Entry at index ${idx} has invalid workerId: ${String(workerId)}`);
    }
    return {
      workerId: typeof workerId === 'number' ? workerId : String(workerId).trim(),
      opName,
      workerNameSnapshot: typeof entry.workerNameSnapshot === 'string' ? entry.workerNameSnapshot.trim() : null,
      rateSnapshot: entry.rateSnapshot !== undefined && entry.rateSnapshot !== null ? assertFiniteNumber(entry.rateSnapshot, 'rateSnapshot') : null,
      brak: typeof entry.brak === 'string' ? entry.brak : null
    };
  });

  // Validate causal dependencies
  const depOpId = typeof command.dependsOnOperationId === 'string' && command.dependsOnOperationId.trim() !== ''
    ? command.dependsOnOperationId.trim()
    : null;
  const causalSeq = validateCausalOrdering(operationId, depOpId, command.causalSequence);

  const submittedAt = typeof command.submittedAt === 'string' ? command.submittedAt : new Date().toISOString();

  // Construct deterministic canonical command payload and fingerprint
  const normalizedPayload = {
    commandId,
    operationId,
    companyId,
    ticketId,
    modelId,
    periodId,
    partyNumber,
    pattaNumber,
    qty,
    entries: entries.map((e) => ({
      brak: e.brak || null,
      opName: e.opName,
      rateSnapshot: e.rateSnapshot !== null && e.rateSnapshot !== undefined ? e.rateSnapshot : null,
      workerId: e.workerId,
      workerNameSnapshot: e.workerNameSnapshot || null
    })),
    partyRecordId,
    konveyer: command.konveyer ? String(command.konveyer).trim() : null,
    size: command.size ? String(command.size).trim() : null,
    color: command.color ? String(command.color).trim() : null,
    originDeviceId: command.originDeviceId ? String(command.originDeviceId).trim() : null,
    originUserId: command.originUserId ? String(command.originUserId).trim() : null,
    effectiveDate: command.effectiveDate ? String(command.effectiveDate).trim() : null,
    dependsOnOperationId: depOpId,
    causalSequence: causalSeq,
    submittedAt: typeof command.submittedAt === 'string' ? command.submittedAt : null
  };

  const payloadJson = canonicalStringify(normalizedPayload);
  const payloadHash = computePayloadHash(payloadJson);

  const db = getCompanyDatabase(baseUserDataPath, companyId);

  // Execute inside an ACID SQLite IMMEDIATE transaction
  const result = db.transaction(() => {
    assertPeriodOpen(db, companyId, command.effectiveDate, submittedAt);
    // 1. Check idempotency: operationId in local_outbox
    const existingOp = getOperation(db, companyId, operationId);
    if (existingOp) {
      if (
        existingOp.company_id === companyId &&
        existingOp.command_type === 'SubmitTicket' &&
        existingOp.entity_id === ticketId &&
        existingOp.payload_hash === payloadHash
      ) {
        return {
          commandId,
          operationId,
          entityId: ticketId,
          status: 'PENDING_SYNC',
          committed: true,
          isReplay: true
        };
      }
      throw createCommandError(
        'IDEMPOTENCY_CONFLICT',
        `Operation "${operationId}" was already executed with different semantic payload or parameters`
      );
    }

    // 2. Check duplicate ticket ID
    const existingTicket = db.prepare('SELECT id FROM tickets WHERE id = ?').get(ticketId);
    if (existingTicket) {
      throw createCommandError('DUPLICATE_TICKET_ID', `Ticket with ID "${ticketId}" already exists`);
    }

    // 3. Validate foreign keys and model operations schema
    const modelRow = db.prepare('SELECT id, operations_json FROM models WHERE id = ? AND company_id = ?').get(modelId, companyId);
    if (!modelRow) {
      throw createCommandError('MODEL_NOT_FOUND', `Model "${modelId}" not found for company "${companyId}"`);
    }

    const partyRow = partyRecordId
      ? db.prepare('SELECT id FROM parties WHERE id = ? AND company_id = ?').get(partyRecordId, companyId)
      : null;
    if (partyRecordId && !partyRow) {
      throw createCommandError('PARTY_NOT_FOUND', `Party "${partyRecordId}" not found for company "${companyId}"`);
    }

    let modelOps = [];
    try {
      modelOps = JSON.parse(modelRow.operations_json || '[]');
    } catch (e) {
      modelOps = [];
    }
    if (!Array.isArray(modelOps)) {
      modelOps = [];
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const opExists = modelOps.some((op) => {
        if (!op) return false;
        if (typeof op === 'string') return op === entry.opName;
        return op.name === entry.opName;
      });
      if (!opExists) {
        throw createCommandError(
          'UNKNOWN_OPERATION',
          `Operation "${entry.opName}" at entry index ${i} is not defined in model "${modelId}" operations`
        );
      }
    }

    const workerCheckStmt = db.prepare('SELECT id FROM workers WHERE id = ? AND company_id = ?');
    for (const entry of entries) {
      const workerRow = workerCheckStmt.get(entry.workerId, companyId);
      if (!workerRow) {
        throw createCommandError('WORKER_NOT_FOUND', `Worker "${entry.workerId}" not found for company "${companyId}"`);
      }
    }

    // 5. Insert ticket fact with status = 'PENDING_SYNC'
    db.prepare(`
      INSERT INTO tickets (
        id, company_id, model_id, period_id, party_number, party_record_id, patta_number,
        qty, size, color, konveyer, status, is_closed, submitted_at, created_at, provenance
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, 'PENDING_SYNC', 0, ?, ?, 'LOCAL_COMMAND'
      )
    `).run(
      ticketId,
      companyId,
      modelId,
      periodId,
      partyNumber,
      partyRecordId,
      pattaNumber,
      qty,
      command.size || null,
      command.color || null,
      command.konveyer || null,
      submittedAt,
      submittedAt
    );

    // 6. Insert ticket entries
    const insertEntryStmt = db.prepare(`
      INSERT INTO ticket_entries (
        id, ticket_id, company_id, op_name, worker_id,
        worker_name_snapshot, rate_snapshot, brak, qty, created_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);

    entries.forEach((e, idx) => {
      const entryId = `entry_${ticketId}_${idx}_${e.opName}_${e.workerId}`;
      insertEntryStmt.run(
        entryId,
        ticketId,
        companyId,
        e.opName,
        e.workerId,
        e.workerNameSnapshot,
        e.rateSnapshot,
        e.brak,
        qty,
        submittedAt
      );
    });

    // Test failure hook: after fact insert, before outbox insert
    if (typeof options?.testHooks?.afterFactInsert === 'function') {
      options.testHooks.afterFactInsert();
    }

    // 7. Insert outbox operation
    insertOutboxOperation(db, {
      operation_id: operationId,
      company_id: companyId,
      command_type: 'SubmitTicket',
      entity_type: 'ticket',
      entity_id: ticketId,
      payload_json: payloadJson,
      payload_hash: payloadHash,
      depends_on_operation_id: depOpId,
      causal_sequence: causalSeq,
      status: 'PENDING',
      created_at: submittedAt
    });

    // Test failure hook: after outbox insert, before commit
    if (typeof options?.testHooks?.afterOutboxInsert === 'function') {
      options.testHooks.afterOutboxInsert();
    }

    // Test failure hook: immediately before commit completion
    if (typeof options?.testHooks?.beforeCommit === 'function') {
      options.testHooks.beforeCommit();
    }

    return {
      commandId,
      operationId,
      entityId: ticketId,
      status: 'PENDING_SYNC',
      committed: true
    };
  }).immediate();

  // Rebuild pure domain projections after successful commit
  try {
    result.projections = rebuildCompanyProjections(baseUserDataPath, companyId);
  } catch (projErr) {
    console.warn('[CommandPipeline] Post-commit projection rebuild warning:', projErr.message);
  }

  return result;
}

/**
 * Executes a RecordProductionAdjustmentCommand inside ONE SQLite transaction.
 *
 * @param {string} baseUserDataPath
 * @param {string} activeCompanyId
 * @param {object} command
 * @param {object} [options={}] Test-only options (failure injection hooks)
 * @returns {object} CommandResult
 */
function executeRecordAdjustmentCommand(baseUserDataPath, activeCompanyId, command, options = {}) {
  if (!command || typeof command !== 'object') {
    throw createCommandError('INVALID_COMMAND_PAYLOAD', 'RecordProductionAdjustmentCommand must be a valid object');
  }

  const companyId = assertNonEmptyString(command.companyId, 'companyId');
  validateCompanyContext(activeCompanyId, companyId);

  const commandId = assertNonEmptyString(command.commandId, 'commandId');
  const operationId = assertNonEmptyString(command.operationId, 'operationId');
  const adjustmentId = assertNonEmptyString(command.adjustmentId, 'adjustmentId');
  const modelId = assertNonEmptyString(command.modelId, 'modelId');
  const opName = assertNonEmptyString(command.opName, 'opName');
  const reason = assertNonEmptyString(command.reason, 'reason');
  const createdBy = assertNonEmptyString(command.createdBy, 'createdBy');

  const workerId = command.workerId;
  if (workerId === undefined || workerId === null || (typeof workerId !== 'number' && typeof workerId !== 'string') || String(workerId).trim() === '') {
    throw createCommandError('INVALID_WORKER_ID', 'workerId is required and must be non-empty');
  }

  const deltaQty = assertFiniteNumber(command.deltaQty, 'deltaQty');
  if (deltaQty === 0) {
    throw createCommandError('INVALID_DELTA_QUANTITY', 'deltaQty cannot be zero');
  }

  let status = 'APPROVED';
  if (command.status !== undefined && command.status !== null) {
    if (command.status !== 'APPROVED' && command.status !== 'PENDING_REVIEW') {
      throw createCommandError('INVALID_ADJUSTMENT_STATUS', `Status must be APPROVED or PENDING_REVIEW, received: ${String(command.status)}`);
    }
    status = command.status;
  }

  const depOpId = typeof command.dependsOnOperationId === 'string' && command.dependsOnOperationId.trim() !== ''
    ? command.dependsOnOperationId.trim()
    : null;
  const causalSeq = validateCausalOrdering(operationId, depOpId, command.causalSequence);

  const createdAt = typeof command.createdAt === 'string' ? command.createdAt : new Date().toISOString();

  // Construct deterministic canonical payload
  const normalizedPayload = {
    commandId,
    operationId,
    companyId,
    adjustmentId,
    modelId,
    workerId: typeof workerId === 'number' ? workerId : String(workerId).trim(),
    opName,
    deltaQty,
    reason,
    createdBy,
    status,
    provenance: command.provenance ? String(command.provenance).trim() : 'MANUAL_CORRECTION',
    createdAt: typeof command.createdAt === 'string' ? command.createdAt : null,
    dependsOnOperationId: depOpId,
    causalSequence: causalSeq
  };

  const payloadJson = canonicalStringify(normalizedPayload);
  const payloadHash = computePayloadHash(payloadJson);

  const db = getCompanyDatabase(baseUserDataPath, companyId);

  const result = db.transaction(() => {
    assertPeriodOpen(db, companyId, command.effectiveDate, createdAt);
    // 1. Check idempotency in local_outbox
    const existingOp = getOperation(db, companyId, operationId);
    if (existingOp) {
      if (
        existingOp.company_id === companyId &&
        existingOp.command_type === 'RecordProductionAdjustment' &&
        existingOp.entity_id === adjustmentId &&
        existingOp.payload_hash === payloadHash
      ) {
        return {
          commandId,
          operationId,
          entityId: adjustmentId,
          status,
          committed: true,
          isReplay: true
        };
      }
      throw createCommandError(
        'IDEMPOTENCY_CONFLICT',
        `Operation "${operationId}" was already executed with different semantic payload or parameters`
      );
    }

    // 2. Check duplicate adjustment ID
    const existingAdj = db.prepare('SELECT adjustment_id FROM production_adjustments WHERE adjustment_id = ?').get(adjustmentId);
    if (existingAdj) {
      throw createCommandError('DUPLICATE_ADJUSTMENT_ID', `Adjustment with ID "${adjustmentId}" already exists`);
    }

    // 3. Verify foreign keys
    const modelRow = db.prepare('SELECT id FROM models WHERE id = ? AND company_id = ?').get(modelId, companyId);
    if (!modelRow) {
      throw createCommandError('MODEL_NOT_FOUND', `Model "${modelId}" not found for company "${companyId}"`);
    }

    const workerRow = db.prepare('SELECT id FROM workers WHERE id = ? AND company_id = ?').get(workerId, companyId);
    if (!workerRow) {
      throw createCommandError('WORKER_NOT_FOUND', `Worker "${workerId}" not found for company "${companyId}"`);
    }

    // 4. Insert canonical production adjustment fact
    db.prepare(`
      INSERT INTO production_adjustments (
        adjustment_id, company_id, model_id, worker_id, op_name, delta_qty,
        reason, status, provenance, created_at, created_by, original_adjustment_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, null
      )
    `).run(
      adjustmentId,
      companyId,
      modelId,
      workerId,
      opName,
      deltaQty,
      reason,
      status,
      command.provenance || 'MANUAL_CORRECTION',
      createdAt,
      createdBy
    );

    // Test failure hook: after fact insert, before outbox insert
    if (typeof options?.testHooks?.afterFactInsert === 'function') {
      options.testHooks.afterFactInsert();
    }

    // 5. Insert outbox operation
    insertOutboxOperation(db, {
      operation_id: operationId,
      company_id: companyId,
      command_type: 'RecordProductionAdjustment',
      entity_type: 'production_adjustment',
      entity_id: adjustmentId,
      payload_json: payloadJson,
      payload_hash: payloadHash,
      depends_on_operation_id: depOpId,
      causal_sequence: causalSeq,
      status: 'PENDING',
      created_at: createdAt
    });

    // Test failure hook: after outbox insert, before commit
    if (typeof options?.testHooks?.afterOutboxInsert === 'function') {
      options.testHooks.afterOutboxInsert();
    }

    // Test failure hook: immediately before commit completion
    if (typeof options?.testHooks?.beforeCommit === 'function') {
      options.testHooks.beforeCommit();
    }

    return {
      commandId,
      operationId,
      entityId: adjustmentId,
      status,
      committed: true
    };
  }).immediate();

  try {
    result.projections = rebuildCompanyProjections(baseUserDataPath, companyId);
  } catch (projErr) {
    console.warn('[CommandPipeline] Post-commit projection rebuild warning:', projErr.message);
  }

  return result;
}

/**
 * Executes a ReverseProductionAdjustmentCommand inside ONE SQLite transaction.
 *
 * @param {string} baseUserDataPath
 * @param {string} activeCompanyId
 * @param {object} command
 * @param {object} [options={}] Test-only options (failure injection hooks)
 * @returns {object} CommandResult
 */
function executeReverseAdjustmentCommand(baseUserDataPath, activeCompanyId, command, options = {}) {
  if (!command || typeof command !== 'object') {
    throw createCommandError('INVALID_COMMAND_PAYLOAD', 'ReverseProductionAdjustmentCommand must be a valid object');
  }

  const companyId = assertNonEmptyString(command.companyId, 'companyId');
  validateCompanyContext(activeCompanyId, companyId);

  const commandId = assertNonEmptyString(command.commandId, 'commandId');
  const operationId = assertNonEmptyString(command.operationId, 'operationId');
  const originalAdjustmentId = assertNonEmptyString(command.originalAdjustmentId, 'originalAdjustmentId');
  const createdBy = assertNonEmptyString(command.createdBy, 'createdBy');

  const reversalId = command.reversalAdjustmentId ? String(command.reversalAdjustmentId).trim() : `rev_${originalAdjustmentId}_${Date.now()}`;
  const createdAt = typeof command.createdAt === 'string' ? command.createdAt : new Date().toISOString();

  const depOpId = typeof command.dependsOnOperationId === 'string' && command.dependsOnOperationId.trim() !== ''
    ? command.dependsOnOperationId.trim()
    : null;
  const causalSeq = validateCausalOrdering(operationId, depOpId, command.causalSequence);

  // Construct deterministic canonical payload
  const normalizedPayload = {
    commandId,
    operationId,
    companyId,
    originalAdjustmentId,
    reversalAdjustmentId: command.reversalAdjustmentId ? String(command.reversalAdjustmentId).trim() : null,
    reason: command.reason ? String(command.reason).trim() : null,
    createdBy,
    createdAt: typeof command.createdAt === 'string' ? command.createdAt : null,
    dependsOnOperationId: depOpId,
    causalSequence: causalSeq
  };

  const payloadJson = canonicalStringify(normalizedPayload);
  const payloadHash = computePayloadHash(payloadJson);

  const db = getCompanyDatabase(baseUserDataPath, companyId);

  const result = db.transaction(() => {
    assertPeriodOpen(db, companyId, command.effectiveDate, createdAt);
    // 1. Check idempotency in local_outbox
    const existingOp = getOperation(db, companyId, operationId);
    if (existingOp) {
      if (
        existingOp.company_id === companyId &&
        existingOp.command_type === 'ReverseProductionAdjustment' &&
        existingOp.payload_hash === payloadHash
      ) {
        return {
          commandId,
          operationId,
          entityId: existingOp.entity_id,
          originalAdjustmentId,
          status: 'APPROVED',
          committed: true,
          isReplay: true
        };
      }
      throw createCommandError(
        'IDEMPOTENCY_CONFLICT',
        `Operation "${operationId}" was already executed with different semantic payload or parameters`
      );
    }

    // 2. Fetch original adjustment
    const original = db.prepare(`
      SELECT * FROM production_adjustments
      WHERE adjustment_id = ? AND company_id = ?
    `).get(originalAdjustmentId, companyId);

    if (!original) {
      throw createCommandError('REVERSAL_ORIGINAL_NOT_FOUND', `Original adjustment "${originalAdjustmentId}" not found for company "${companyId}"`);
    }

    if (original.status !== 'APPROVED') {
      throw createCommandError(
        'CANNOT_REVERSE_UNAPPROVED',
        `Cannot reverse adjustment "${originalAdjustmentId}" with status "${original.status}". Only APPROVED adjustments can be reversed.`
      );
    }

    if (original.original_adjustment_id || original.provenance === 'REVERSAL') {
      throw createCommandError('REVERSAL_OF_REVERSAL', `Cannot reverse an adjustment that is already a reversal: "${originalAdjustmentId}"`);
    }

    // 3. Check duplicate active reversal
    const existingReversal = db.prepare(`
      SELECT adjustment_id FROM production_adjustments
      WHERE original_adjustment_id = ? AND status = 'APPROVED'
    `).get(originalAdjustmentId);

    if (existingReversal) {
      throw createCommandError(
        'DUPLICATE_REVERSAL',
        `An approved reversal "${existingReversal.adjustment_id}" already exists for adjustment "${originalAdjustmentId}"`
      );
    }

    // 4. Insert new reversal fact (original remains completely untouched with status = 'APPROVED')
    const inverseDelta = -Number(original.delta_qty);
    const reason = command.reason || `Reversal of adjustment ${original.adjustment_id}: ${original.reason}`;
    const originalServerRevision = Number.isSafeInteger(original.server_revision)
      ? original.server_revision
      : 1;

    db.prepare(`
      INSERT INTO production_adjustments (
        adjustment_id, company_id, model_id, worker_id, op_name, delta_qty,
        reason, status, provenance, created_at, created_by, original_adjustment_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, 'APPROVED', 'REVERSAL', ?, ?, ?
      )
    `).run(
      reversalId,
      companyId,
      original.model_id,
      original.worker_id,
      original.op_name,
      inverseDelta,
      reason,
      createdAt,
      createdBy,
      original.adjustment_id
    );

    // Test failure hook: after fact insert, before outbox insert
    if (typeof options?.testHooks?.afterFactInsert === 'function') {
      options.testHooks.afterFactInsert();
    }

    // 5. Insert outbox operation
    insertOutboxOperation(db, {
      operation_id: operationId,
      company_id: companyId,
       command_type: 'ReverseProductionAdjustment',
       entity_type: 'production_adjustment',
       entity_id: reversalId,
       base_revision: originalServerRevision,
       payload_json: payloadJson,
      payload_hash: payloadHash,
      depends_on_operation_id: depOpId,
      causal_sequence: causalSeq,
      status: 'PENDING',
      created_at: createdAt
    });

    // Test failure hook: after outbox insert, before commit
    if (typeof options?.testHooks?.afterOutboxInsert === 'function') {
      options.testHooks.afterOutboxInsert();
    }

    // Test failure hook: immediately before commit completion
    if (typeof options?.testHooks?.beforeCommit === 'function') {
      options.testHooks.beforeCommit();
    }

    return {
      commandId,
      operationId,
      entityId: reversalId,
      originalAdjustmentId: original.adjustment_id,
      status: 'APPROVED',
      committed: true
    };
  }).immediate();

  try {
    result.projections = rebuildCompanyProjections(baseUserDataPath, companyId);
  } catch (projErr) {
    console.warn('[CommandPipeline] Post-commit projection rebuild warning:', projErr.message);
  }

  return result;
}

/**
 * Executes a ResolveMigrationReconciliationCandidateCommand inside ONE SQLite transaction.
 *
 * Requirements:
 * - Local role checks are UX-only defense in depth; server authority is required
 * - Persists only an immutable pending intent and durable outbox operation locally
 * - Fails closed if candidate not found (CANDIDATE_NOT_FOUND)
 * - Idempotency: replay of same operationId/same decision returns deterministic replay (isReplay: true)
 * - Conflicting second decision: if candidate has final resolution ('APPROVED'/'REJECTED'), conflicting decision is rejected with CONFLICTING_DECISION_REJECTED
 * - Anti-tampering: coordinates (modelId, workerId, opName) and deltaQty are derived strictly from authoritative candidate record
 * - No decision mutates candidate, resolution, or adjustment facts before ACK
 * - Server-authoritative ACK/pull is the only path to final accounting state
 * - Rebuilds company projections
 *
 * @param {string} baseUserDataPath
 * @param {string} activeCompanyId
 * @param {object} command
 * @param {object} [options={}]
 * @returns {object} CommandResult
 */
function executeResolveReconciliationCandidateCommand(baseUserDataPath, activeCompanyId, command, options = {}) {
  if (!command || typeof command !== 'object') {
    throw createCommandError('INVALID_COMMAND_PAYLOAD', 'ResolveMigrationReconciliationCandidateCommand must be a valid object');
  }

  const companyId = assertNonEmptyString(command.companyId, 'companyId');
  validateCompanyContext(activeCompanyId, companyId);

  const commandId = assertNonEmptyString(command.commandId || `cmd_${Date.now()}`, 'commandId');
  const operationId = assertNonEmptyString(command.operationId, 'operationId');
  const candidateId = assertNonEmptyString(command.candidateId, 'candidateId');
  const operatorId = assertNonEmptyString(command.operatorId, 'operatorId');
  const operatorRole = assertNonEmptyString(command.operatorRole, 'operatorRole');
  const reason = assertNonEmptyString(command.reason, 'reason');
  const decision = assertNonEmptyString(command.decision, 'decision');

  const validDecisions = [
    'CONFIRM_LEGACY_AS_ADJUSTMENT',
    'REJECT_LEGACY_DIFFERENCE',
    'LINK_TO_MISSING_SOURCE',
    'DEFER_REVIEW'
  ];
  if (!validDecisions.includes(decision)) {
    throw createCommandError('INVALID_DECISION', `decision must be one of: ${validDecisions.join(', ')}. Received: "${decision}"`);
  }

  // Enforce operator role authorization
  const normalizedRole = operatorRole.trim().toLowerCase();
  const authorizedRoles = ['admin', 'accountant', 'head_accountant', 'accounting'];
  if (!authorizedRoles.includes(normalizedRole)) {
    throw createCommandError(
      'UNAUTHORIZED_ROLE',
      `Actor "${operatorId}" with role "${operatorRole}" is not authorized to resolve reconciliation differences. Requires admin or accountant role.`
    );
  }

  const sourceReference = typeof command.sourceReference === 'string' && command.sourceReference.trim()
    ? command.sourceReference.trim()
    : null;

  const depOpId = typeof command.dependsOnOperationId === 'string' && command.dependsOnOperationId.trim() !== ''
    ? command.dependsOnOperationId.trim()
    : null;
  const causalSeq = validateCausalOrdering(operationId, depOpId, command.causalSequence);

  const normalizedPayload = {
    commandId,
    operationId,
    companyId,
    candidateId,
    decision,
    operatorId,
    operatorRole,
    reason,
    sourceReference,
    adjustmentId: command.adjustmentId ? String(command.adjustmentId).trim() : null,
    dependsOnOperationId: depOpId,
    causalSequence: causalSeq
  };

  const payloadJson = canonicalStringify(normalizedPayload);
  const payloadHash = computePayloadHash(payloadJson);

  const db = getCompanyDatabase(baseUserDataPath, companyId);

  const result = db.transaction(() => {
    // 1. Check outbox idempotency
    const existingOp = getOperation(db, companyId, operationId);
    if (existingOp) {
      if (existingOp.payload_hash === payloadHash) {
        const cand = db.prepare(`SELECT * FROM migration_reconciliation_candidates WHERE company_id = ? AND candidate_id = ?`).get(companyId, candidateId);
        const authoritative = cand && (cand.status === 'APPROVED' || cand.status === 'REJECTED');
        return {
          commandId,
          operationId,
          entityId: candidateId,
          decision,
          status: authoritative ? cand.status : 'PENDING_SYNC',
          resolutionStatus: authoritative ? 'AUTHORITATIVE' : 'PENDING_SYNC',
          adjustmentId: authoritative ? cand.created_adjustment_id : null,
          committed: true,
          isReplay: true
        };
      }
      throw createCommandError(
        'IDEMPOTENCY_CONFLICT',
        `Operation "${operationId}" already exists with different payload hash`
      );
    }

    // 2. Fetch candidate from migration_reconciliation_candidates
    const candidate = db.prepare(`
      SELECT * FROM migration_reconciliation_candidates
      WHERE company_id = ? AND candidate_id = ?
    `).get(companyId, candidateId);

    if (!candidate) {
      throw createCommandError('CANDIDATE_NOT_FOUND', `Reconciliation candidate "${candidateId}" not found for company "${companyId}"`);
    }
    assertPeriodOpen(db, companyId, command.effectiveDate, candidate.created_at);

    // 3. Conflict Guard on Candidate Level
    const existingFinalDecision = candidate.resolution_decision || (
      candidate.status === 'APPROVED' ? 'CONFIRM_LEGACY_AS_ADJUSTMENT' : (candidate.status === 'REJECTED' ? 'REJECT_LEGACY_DIFFERENCE' : null)
    );

    if (existingFinalDecision) {
      if (existingFinalDecision === decision) {
        return {
          commandId,
          operationId,
          entityId: candidateId,
          decision,
          status: candidate.status,
          adjustmentId: candidate.created_adjustment_id,
          committed: true,
          isReplay: true
        };
      }
      throw createCommandError(
        'CONFLICTING_DECISION_REJECTED',
        `Candidate "${candidateId}" already has final resolution "${existingFinalDecision}". Cannot apply conflicting decision "${decision}".`
      );
    }

    // 4. Coordinates & Delta Anti-Tampering Check:
    if (command.modelId && String(command.modelId).trim() !== candidate.model_id) {
      throw createCommandError('CANDIDATE_TAMPERING_REJECTED', `Supplied modelId "${command.modelId}" does not match candidate modelId "${candidate.model_id}"`);
    }
    if (command.workerId !== undefined && command.workerId !== null && String(command.workerId).trim() !== String(candidate.worker_id).trim()) {
      throw createCommandError('CANDIDATE_TAMPERING_REJECTED', `Supplied workerId "${command.workerId}" does not match candidate workerId "${candidate.worker_id}"`);
    }
    if (command.opName && String(command.opName).trim() !== candidate.operation_name) {
      throw createCommandError('CANDIDATE_TAMPERING_REJECTED', `Supplied opName "${command.opName}" does not match candidate opName "${candidate.operation_name}"`);
    }
    if (command.deltaQty !== undefined && command.deltaQty !== null && Number(command.deltaQty) !== Number(candidate.delta_qty)) {
      throw createCommandError('CANDIDATE_TAMPERING_REJECTED', `Supplied deltaQty "${command.deltaQty}" does not match candidate deltaQty "${candidate.delta_qty}"`);
    }

    const nowIso = new Date().toISOString();
    let createdAdjustmentId = null;

    // The local transaction records intent only. Candidate state, audit rows, and
    // APPROVED adjustments are authoritative facts and must wait for server ACK.
    // Insert outbox operation
    insertOutboxOperation(db, {
      operation_id: operationId,
      company_id: companyId,
      command_type: 'ResolveMigrationReconciliationCandidate',
      entity_type: 'reconciliation_candidate',
      entity_id: candidateId,
      payload_json: payloadJson,
      payload_hash: payloadHash,
      depends_on_operation_id: depOpId,
      causal_sequence: causalSeq,
      status: 'PENDING',
      created_at: nowIso
    });

    return {
      commandId,
      operationId,
      entityId: candidateId,
      decision,
      status: 'PENDING_SYNC',
      resolutionStatus: 'PENDING_SYNC',
      adjustmentId: createdAdjustmentId,
      committed: true,
      isReplay: false
    };
  }).immediate();

  // Pending reconciliation intent has no accounting projection effect.
  try {
    result.projections = rebuildCompanyProjections(baseUserDataPath, companyId);
  } catch (projErr) {
    console.warn('[CommandPipeline] Post-commit projection rebuild warning:', projErr.message);
  }

  return result;
}

module.exports = {
  executeSubmitTicketCommand,
  executeRecordAdjustmentCommand,
  executeReverseAdjustmentCommand,
  executeResolveReconciliationCandidateCommand,
  validateCausalOrdering
};
