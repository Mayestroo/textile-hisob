'use strict';

/**
 * Pure Dual Projections Engine (CommonJS Runtime for Electron Main)
 * Phase 2 — Step 2 & 3
 *
 * Implements pure domain projections:
 * 1. hisobOptimisticQuantities (Floor projection: CONFIRMED + PENDING_SYNC + APPROVED adjustments)
 * 2. hisobAccountingQuantities (Authoritative accounting: CONFIRMED + APPROVED adjustments)
 *
 * Exact mirror of src/domain/projections.ts for Electron Main execution.
 */

const VALID_TICKET_STATUSES = new Set([
  'PENDING_SYNC',
  'PENDING_DELETE',
  'CONFIRMED',
  'CONFLICT',
  'REJECTED',
  'VOIDED'
]);

const VALID_ADJUSTMENT_STATUSES = new Set([
  'PENDING_REVIEW',
  'APPROVED',
  'REVERSED'
]);

function roundFloat(val) {
  return Math.round((val + Number.EPSILON) * 1e6) / 1e6;
}

function createProjectionError(code, message, details = {}) {
  const err = new Error(`[ProjectionValidationError: ${code}] ${message}`);
  err.name = 'ProjectionValidationError';
  err.code = code;
  err.details = details;
  return err;
}

function validateTicketQuantity(qty, ticketId) {
  if (typeof qty !== 'number' || !Number.isSafeInteger(qty)) {
    throw createProjectionError(
      'INVALID_TICKET_QUANTITY',
      `Ticket "${ticketId}" has invalid quantity: ${String(qty)}. Expected positive safe integer.`,
      { ticketId, qty }
    );
  }
  if (qty <= 0) {
    const code = qty < 0 ? 'INVALID_NEGATIVE_TICKET_QUANTITY' : 'INVALID_TICKET_QUANTITY';
    throw createProjectionError(
      code,
      `Ticket "${ticketId}" has invalid non-positive quantity: ${qty}. Expected positive safe integer (> 0).`,
      { ticketId, qty }
    );
  }
  return qty;
}

function validateFiniteNumber(value, fieldName, entityId) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw createProjectionError(
      'INVALID_QUANTITY',
      `${fieldName} on "${entityId}" must be a finite number. Received: ${String(value)} (${typeof value})`,
      { entityId, value }
    );
  }
  return value;
}

/**
 * Computes pure dual hisob projections from tickets and production adjustments.
 *
 * @param {object} input
 * @param {Array<object>} [input.tickets=[]]
 * @param {Array<object>} [input.productionAdjustments=[]]
 * @returns {object} { optimistic, accounting, breakdown }
 */
function buildHisobProjections(input = {}) {
  const tickets = input.tickets || [];
  const adjustments = input.productionAdjustments || [];

  const seenTicketIds = new Set();
  const seenAdjustmentIds = new Set();

  // Intermediate aggregation: modelId -> workerId -> opName -> Accumulator
  const accMap = new Map();

  const getOrCreateAcc = (modelId, workerId, opName) => {
    let m = accMap.get(modelId);
    if (!m) {
      m = new Map();
      accMap.set(modelId, m);
    }
    let w = m.get(workerId);
    if (!w) {
      w = new Map();
      m.set(workerId, w);
    }
    let acc = w.get(opName);
    if (!acc) {
      acc = { confirmedQty: 0, pendingQty: 0, adjustmentQty: 0 };
      w.set(opName, acc);
    }
    return acc;
  };

  // 1. Process Tickets
  for (const t of tickets) {
    if (!t || typeof t !== 'object') {
      throw createProjectionError('INVALID_FACT_STRUCTURE', 'Ticket fact must be a valid object');
    }
    if (!t.ticketId || typeof t.ticketId !== 'string') {
      throw createProjectionError('INVALID_FACT_STRUCTURE', 'ticketId must be a non-empty string');
    }

    if (seenTicketIds.has(t.ticketId)) {
      throw createProjectionError(
        'DUPLICATE_TICKET_ID',
        `Duplicate ticketId detected: "${t.ticketId}".`,
        { ticketId: t.ticketId }
      );
    }
    seenTicketIds.add(t.ticketId);

    if (!t.modelId || typeof t.modelId !== 'string') {
      throw createProjectionError('INVALID_FACT_STRUCTURE', 'modelId must be a non-empty string', { ticketId: t.ticketId });
    }

    const qty = validateTicketQuantity(t.qty, t.ticketId);

    if (!VALID_TICKET_STATUSES.has(t.status)) {
      throw createProjectionError(
        'INVALID_TICKET_STATUS',
        `Unrecognized ticket status: "${String(t.status)}" on ticket "${t.ticketId}".`,
        { ticketId: t.ticketId, status: t.status }
      );
    }

    // Exclude CONFLICT, REJECTED, VOIDED
    if (t.status === 'CONFLICT' || t.status === 'REJECTED' || t.status === 'VOIDED' || t.status === 'PENDING_DELETE') {
      continue;
    }

    const entries = Array.isArray(t.entries) ? t.entries : [];
    for (const entry of entries) {
      if (!entry || entry.workerId === undefined || entry.workerId === null || entry.workerId === '') {
        continue;
      }
      const workerIdStr = String(entry.workerId).trim();
      const opName = String(entry.opName || '').trim();
      if (!opName) continue;

      const acc = getOrCreateAcc(t.modelId, workerIdStr, opName);

      if (t.status === 'CONFIRMED') {
        acc.confirmedQty += qty;
      } else if (t.status === 'PENDING_SYNC') {
        acc.pendingQty += qty;
      }
    }
  }

  // 2. Process Production Adjustments
  const adjustmentMap = new Map();
  for (const adj of adjustments) {
    if (!adj || typeof adj !== 'object') {
      throw createProjectionError('INVALID_FACT_STRUCTURE', 'Adjustment fact must be a valid object');
    }
    if (!adj.adjustmentId || typeof adj.adjustmentId !== 'string') {
      throw createProjectionError('INVALID_FACT_STRUCTURE', 'adjustmentId must be a non-empty string');
    }

    if (seenAdjustmentIds.has(adj.adjustmentId)) {
      throw createProjectionError(
        'DUPLICATE_ADJUSTMENT_ID',
        `Duplicate adjustmentId detected: "${adj.adjustmentId}".`,
        { adjustmentId: adj.adjustmentId }
      );
    }
    seenAdjustmentIds.add(adj.adjustmentId);

    if (!VALID_ADJUSTMENT_STATUSES.has(adj.status)) {
      throw createProjectionError(
        'INVALID_ADJUSTMENT_STATUS',
        `Unrecognized adjustment status: "${String(adj.status)}" on adjustment "${adj.adjustmentId}".`,
        { adjustmentId: adj.adjustmentId, status: adj.status }
      );
    }

    validateFiniteNumber(adj.deltaQty, 'adjustment.deltaQty', adj.adjustmentId);
    adjustmentMap.set(adj.adjustmentId, adj);
  }

  // Pass 2B: Reversal reference validation
  const approvedReversalsByOriginalId = new Map();

  for (const adj of adjustments) {
    const isReversal = Boolean(adj.originalAdjustmentId) || adj.provenance === 'REVERSAL';
    if (!isReversal) continue;

    if (!adj.originalAdjustmentId || adj.originalAdjustmentId === adj.adjustmentId) {
      throw createProjectionError(
        'INVALID_REVERSAL_REFERENCE',
        `Reversal adjustment "${adj.adjustmentId}" must specify a distinct originalAdjustmentId.`,
        { adjustmentId: adj.adjustmentId, originalAdjustmentId: adj.originalAdjustmentId }
      );
    }

    const original = adjustmentMap.get(adj.originalAdjustmentId);
    if (!original) {
      throw createProjectionError(
        'REVERSAL_ORIGINAL_NOT_FOUND',
        `Reversal "${adj.adjustmentId}" targets non-existent original adjustment "${adj.originalAdjustmentId}".`,
        { adjustmentId: adj.adjustmentId, originalAdjustmentId: adj.originalAdjustmentId }
      );
    }

    if (original.originalAdjustmentId || original.provenance === 'REVERSAL') {
      throw createProjectionError(
        'REVERSAL_OF_REVERSAL',
        `Reversal "${adj.adjustmentId}" targets another reversal "${original.adjustmentId}".`,
        { adjustmentId: adj.adjustmentId, originalAdjustmentId: original.adjustmentId }
      );
    }

    if (adj.companyId && original.companyId && adj.companyId !== original.companyId) {
      throw createProjectionError('REVERSAL_ENTITY_MISMATCH', `Company mismatch on reversal "${adj.adjustmentId}".`);
    }
    if (adj.modelId !== original.modelId) {
      throw createProjectionError('REVERSAL_ENTITY_MISMATCH', `Model mismatch on reversal "${adj.adjustmentId}".`);
    }
    if (String(adj.workerId).trim() !== String(original.workerId).trim()) {
      throw createProjectionError('REVERSAL_ENTITY_MISMATCH', `Worker mismatch on reversal "${adj.adjustmentId}".`);
    }
    if (adj.opName !== original.opName) {
      throw createProjectionError('REVERSAL_ENTITY_MISMATCH', `Operation mismatch on reversal "${adj.adjustmentId}".`);
    }

    if (roundFloat(adj.deltaQty) !== roundFloat(-original.deltaQty)) {
      throw createProjectionError(
        'INVALID_REVERSAL_DELTA',
        `Reversal "${adj.adjustmentId}" deltaQty (${adj.deltaQty}) does not equal inverse of original (${original.deltaQty}).`
      );
    }

    if (adj.status === 'APPROVED') {
      const existingReversal = approvedReversalsByOriginalId.get(adj.originalAdjustmentId);
      if (existingReversal) {
        throw createProjectionError(
          'DUPLICATE_REVERSAL',
          `Multiple approved reversals target the same original adjustment "${adj.originalAdjustmentId}": "${existingReversal}" and "${adj.adjustmentId}".`
        );
      }
      approvedReversalsByOriginalId.set(adj.originalAdjustmentId, adj.adjustmentId);
    }
  }

  // Pass 2C: Accumulate adjustments
  for (const adj of adjustments) {
    if (adj.status !== 'APPROVED') continue;

    const isReversal = Boolean(adj.originalAdjustmentId) || adj.provenance === 'REVERSAL';
    if (isReversal && adj.originalAdjustmentId) {
      const original = adjustmentMap.get(adj.originalAdjustmentId);
      if (original && original.status === 'REVERSED') {
        // Read compatibility: avoid double-subtraction
        continue;
      }
    }

    const workerIdStr = String(adj.workerId).trim();
    const opName = String(adj.opName).trim();
    const acc = getOrCreateAcc(adj.modelId, workerIdStr, opName);
    acc.adjustmentQty = roundFloat(acc.adjustmentQty + adj.deltaQty);
  }

  // 3. Assemble Output
  const optimistic = {};
  const accounting = {};
  const breakdown = {};

  const sortedModelIds = Array.from(accMap.keys()).sort();
  for (const modelId of sortedModelIds) {
    const workerMap = accMap.get(modelId);
    const sortedWorkerIds = Array.from(workerMap.keys()).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    });

    for (const workerIdStr of sortedWorkerIds) {
      const opMap = workerMap.get(workerIdStr);
      const sortedOpNames = Array.from(opMap.keys()).sort();

      for (const opName of sortedOpNames) {
        const acc = opMap.get(opName);
        const confirmedQty = roundFloat(acc.confirmedQty);
        const pendingQty = roundFloat(acc.pendingQty);
        const adjustmentQty = roundFloat(acc.adjustmentQty);

        const totalQty = roundFloat(confirmedQty + pendingQty + adjustmentQty);
        const accountingQty = roundFloat(confirmedQty + adjustmentQty);

        // Optimistic
        if (!optimistic[modelId]) optimistic[modelId] = {};
        if (!optimistic[modelId][workerIdStr]) optimistic[modelId][workerIdStr] = {};
        optimistic[modelId][workerIdStr][opName] = totalQty;

        // Accounting
        if (!accounting[modelId]) accounting[modelId] = {};
        if (!accounting[modelId][workerIdStr]) accounting[modelId][workerIdStr] = {};
        accounting[modelId][workerIdStr][opName] = accountingQty;

        // Breakdown
        if (!breakdown[modelId]) breakdown[modelId] = {};
        if (!breakdown[modelId][workerIdStr]) breakdown[modelId][workerIdStr] = {};
        breakdown[modelId][workerIdStr][opName] = {
          totalQty,
          confirmedQty,
          pendingQty,
          adjustmentQty,
          accountingQty
        };
      }
    }
  }

  return { optimistic, accounting, breakdown };
}

module.exports = {
  buildHisobProjections
};
