/**
 * Pure Dual Projections Engine
 * Phase 2 — Step 2
 *
 * Implements pure domain projections:
 * 1. hisobOptimisticQuantities (Floor projection: CONFIRMED + PENDING_SYNC + APPROVED adjustments)
 * 2. hisobAccountingQuantities (Authoritative accounting: CONFIRMED + server-authoritative APPROVED adjustments)
 *
 * Pure domain logic:
 * - Zero side effects
 * - Zero external state / caches
 * - No Zustand, Electron, SQLite, Firebase, network, or clock dependencies
 * - Deterministic, order-independent, and fail-closed against corruption.
 */

import {
  ProductionAdjustmentFact,
  ProductionAdjustmentStatus
} from './productionAdjustment';

export type TicketStatus =
  | 'PENDING_SYNC'
  | 'CONFIRMED'
  | 'CONFLICT'
  | 'REJECTED'
  | 'VOIDED';

export interface TicketEntryFact {
  workerId: number | string;
  opName: string;
  workerNameSnapshot?: string;
  rateSnapshot?: number;
  brak?: string;
}

export interface TicketFact {
  ticketId: string;
  modelId: string;
  qty: number;
  status: TicketStatus;
  entries: TicketEntryFact[];
  partyNumber?: string;
  pattaNumber?: number;
  submittedAt?: string;
  companyId?: string;
}

export interface OperationProjectionBreakdown {
  totalQty: number;      // Optimistic floor total (confirmedQty + pendingQty + adjustmentQty)
  confirmedQty: number;  // From CONFIRMED tickets
  pendingQty: number;    // From PENDING_SYNC tickets
  adjustmentQty: number; // From APPROVED production adjustments
  accountingQty: number; // Authoritative accounting total (confirmedQty + adjustmentQty)
}

export interface HisobProjectionsResult {
  optimistic: Record<string, Record<string | number, Record<string, number>>>;
  accounting: Record<string, Record<string | number, Record<string, number>>>;
  breakdown: Record<string, Record<string | number, Record<string, OperationProjectionBreakdown>>>;
}

export interface BuildProjectionsInput {
  tickets?: TicketFact[];
  productionAdjustments?: ProductionAdjustmentFact[];
}

export type ProjectionValidationErrorCode =
  | 'DUPLICATE_TICKET_ID'
  | 'DUPLICATE_ADJUSTMENT_ID'
  | 'INVALID_QUANTITY'
  | 'INVALID_TICKET_QUANTITY'
  | 'INVALID_NEGATIVE_TICKET_QUANTITY'
  | 'INVALID_TICKET_STATUS'
  | 'INVALID_ADJUSTMENT_STATUS'
  | 'INVALID_FACT_STRUCTURE'
  | 'REVERSAL_ORIGINAL_NOT_FOUND'
  | 'INVALID_REVERSAL_REFERENCE'
  | 'REVERSAL_ENTITY_MISMATCH'
  | 'INVALID_REVERSAL_DELTA'
  | 'DUPLICATE_REVERSAL'
  | 'REVERSAL_OF_REVERSAL';

export class ProjectionValidationError extends Error {
  readonly code: ProjectionValidationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ProjectionValidationErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[ProjectionValidationError: ${code}] ${message}`);
    this.name = 'ProjectionValidationError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, ProjectionValidationError.prototype);
  }
}

const VALID_TICKET_STATUSES: ReadonlySet<TicketStatus> = new Set([
  'PENDING_SYNC',
  'CONFIRMED',
  'CONFLICT',
  'REJECTED',
  'VOIDED'
]);

const VALID_ADJUSTMENT_STATUSES: ReadonlySet<ProductionAdjustmentStatus> = new Set([
  'PENDING_REVIEW',
  'APPROVED',
  'REVERSED'
]);

/**
 * Internal helper to round float sums cleanly to 6 decimal precision.
 */
export function roundFloat(num: number): number {
  return Math.round((num + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Validates that a quantity is a strictly finite number.
 * Fails closed on NaN, Infinity, -Infinity, strings, null, undefined, etc.
 */
function validateFiniteNumber(val: unknown, fieldName: string, contextId: string): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new ProjectionValidationError(
      'INVALID_QUANTITY',
      `Field "${fieldName}" must be a finite number, received: ${String(val)} (${typeof val})`,
      { fieldName, value: val, contextId }
    );
  }
  return val;
}

/**
 * Validates that a ticket quantity is a strictly positive safe integer.
 * In accordance with business domain rules (ticketValidation.ts), tickets must
 * have qty > 0 and Number.isSafeInteger(qty).
 * Rejects 0, negative values, fractional values, NaN, Infinity, and non-numeric types.
 */
function validateTicketQuantity(qty: unknown, contextId: string): number {
  if (typeof qty !== 'number' || Number.isNaN(qty) || !Number.isFinite(qty)) {
    throw new ProjectionValidationError(
      'INVALID_TICKET_QUANTITY',
      `Ticket "${contextId}" quantity must be a valid finite number, received: ${String(qty)} (${typeof qty})`,
      { ticketId: contextId, qty }
    );
  }
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    if (qty < 0) {
      throw new ProjectionValidationError(
        'INVALID_NEGATIVE_TICKET_QUANTITY',
        `Ticket quantity cannot be negative. Found qty ${qty} on ticket "${contextId}".`,
        { ticketId: contextId, qty }
      );
    }
    throw new ProjectionValidationError(
      'INVALID_TICKET_QUANTITY',
      `Ticket "${contextId}" quantity must be a positive safe integer (> 0), received: ${qty}`,
      { ticketId: contextId, qty }
    );
  }
  return qty;
}

/**
 * Normalizes a legacy SubmittedTicketRecord into a TicketFact.
 * Default status is 'CONFIRMED'.
 */
export function normalizeLegacyTicket(
  legacy: {
    id: string;
    modelId: string;
    qty: number;
    entries?: Array<{ workerId: number | string; opName: string; rateSnapshot?: number }>;
    partyNumber?: string;
    pattaNumber?: number;
    submittedAt?: string;
  },
  status: TicketStatus = 'CONFIRMED'
): TicketFact {
  return {
    ticketId: legacy.id,
    modelId: legacy.modelId,
    qty: legacy.qty,
    status,
    entries: (legacy.entries || []).map((e) => ({
      workerId: e.workerId,
      opName: e.opName,
      rateSnapshot: e.rateSnapshot
    })),
    partyNumber: legacy.partyNumber,
    pattaNumber: legacy.pattaNumber,
    submittedAt: legacy.submittedAt
  };
}

/**
 * Pure projection builder.
 * Computes deterministic optimistic and authoritative accounting hisob projections
 * from normalized ticket facts and production adjustment facts.
 */
export function buildHisobProjections(input: BuildProjectionsInput): HisobProjectionsResult {
  const tickets = input.tickets || [];
  const adjustments = input.productionAdjustments || [];

  // 1. Duplicate Defense & Validation Sets
  const seenTicketIds = new Set<string>();
  const seenAdjustmentIds = new Set<string>();

  // Intermediate aggregation maps: modelId -> workerId -> opName -> breakdown
  // Worker IDs stored as strings internally for consistent hashing/sorting
  interface Accumulator {
    confirmedQty: number;
    pendingQty: number;
    adjustmentQty: number;
  }
  const accMap = new Map<string, Map<string, Map<string, Accumulator>>>();

  const getOrCreateAcc = (modelId: string, workerId: string, opName: string): Accumulator => {
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

  // 2. Process Tickets
  for (const t of tickets) {
    if (!t || typeof t !== 'object') {
      throw new ProjectionValidationError('INVALID_FACT_STRUCTURE', 'Ticket fact must be a valid object');
    }
    if (!t.ticketId || typeof t.ticketId !== 'string') {
      throw new ProjectionValidationError('INVALID_FACT_STRUCTURE', 'ticketId must be a non-empty string');
    }

    if (seenTicketIds.has(t.ticketId)) {
      throw new ProjectionValidationError(
        'DUPLICATE_TICKET_ID',
        `Duplicate ticketId detected: "${t.ticketId}". Projection input must be uniquely identified.`,
        { ticketId: t.ticketId }
      );
    }
    seenTicketIds.add(t.ticketId);

    if (!t.modelId || typeof t.modelId !== 'string') {
      throw new ProjectionValidationError('INVALID_FACT_STRUCTURE', 'modelId must be a non-empty string', {
        ticketId: t.ticketId
      });
    }

    const qty = validateTicketQuantity(t.qty, t.ticketId);

    if (!VALID_TICKET_STATUSES.has(t.status)) {
      throw new ProjectionValidationError(
        'INVALID_TICKET_STATUS',
        `Unrecognized ticket status: "${String(t.status)}" on ticket "${t.ticketId}".`,
        { ticketId: t.ticketId, status: t.status }
      );
    }

    // Invariant Filtering:
    // CONFLICT, REJECTED, VOIDED contribute to NEITHER projection
    if (t.status === 'CONFLICT' || t.status === 'REJECTED' || t.status === 'VOIDED') {
      continue;
    }

    // Process entries
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

  // 3. Process Production Adjustments. APPROVED is accounting-effective only
  // after authoritative server acceptance; local reconciliation intents are not
  // stored in this fact table and therefore cannot enter either projection.
  // Pass 3A: Check duplicates, validate status/deltaQty, build adjustment lookup map
  const adjustmentMap = new Map<string, ProductionAdjustmentFact>();
  for (const adj of adjustments) {
    if (!adj || typeof adj !== 'object') {
      throw new ProjectionValidationError('INVALID_FACT_STRUCTURE', 'Adjustment fact must be a valid object');
    }
    if (!adj.adjustmentId || typeof adj.adjustmentId !== 'string') {
      throw new ProjectionValidationError('INVALID_FACT_STRUCTURE', 'adjustmentId must be a non-empty string');
    }

    if (seenAdjustmentIds.has(adj.adjustmentId)) {
      throw new ProjectionValidationError(
        'DUPLICATE_ADJUSTMENT_ID',
        `Duplicate adjustmentId detected: "${adj.adjustmentId}". Projection input must be uniquely identified.`,
        { adjustmentId: adj.adjustmentId }
      );
    }
    seenAdjustmentIds.add(adj.adjustmentId);

    if (!VALID_ADJUSTMENT_STATUSES.has(adj.status)) {
      throw new ProjectionValidationError(
        'INVALID_ADJUSTMENT_STATUS',
        `Unrecognized adjustment status: "${String(adj.status)}" on adjustment "${adj.adjustmentId}".`,
        { adjustmentId: adj.adjustmentId, status: adj.status }
      );
    }

    validateFiniteNumber(adj.deltaQty, 'adjustment.deltaQty', adj.adjustmentId);
    adjustmentMap.set(adj.adjustmentId, adj);
  }

  // Pass 3B: Reversal Reference Validation (Enforces Invariants A - J before any accumulation)
  // Track active approved reversals per originalAdjustmentId to block duplicate reversals (Invariant I)
  const approvedReversalsByOriginalId = new Map<string, string>();

  for (const adj of adjustments) {
    const isReversal = Boolean(adj.originalAdjustmentId) || adj.provenance === 'REVERSAL';
    if (!isReversal) {
      continue;
    }

    // A & C. Must have distinct originalAdjustmentId
    if (!adj.originalAdjustmentId || adj.originalAdjustmentId === adj.adjustmentId) {
      throw new ProjectionValidationError(
        'INVALID_REVERSAL_REFERENCE',
        `Reversal adjustment "${adj.adjustmentId}" must specify a distinct originalAdjustmentId.`,
        { adjustmentId: adj.adjustmentId, originalAdjustmentId: adj.originalAdjustmentId }
      );
    }

    // A. Referenced original must exist in adjustmentMap
    const original = adjustmentMap.get(adj.originalAdjustmentId);
    if (!original) {
      throw new ProjectionValidationError(
        'REVERSAL_ORIGINAL_NOT_FOUND',
        `Reversal adjustment "${adj.adjustmentId}" references non-existent adjustment "${adj.originalAdjustmentId}".`,
        { adjustmentId: adj.adjustmentId, originalAdjustmentId: adj.originalAdjustmentId }
      );
    }

    // B. Referenced original must NOT itself be a reversal
    if (original.originalAdjustmentId || original.provenance === 'REVERSAL') {
      throw new ProjectionValidationError(
        'REVERSAL_OF_REVERSAL',
        `Reversal adjustment "${adj.adjustmentId}" cannot reference another reversal "${original.adjustmentId}".`,
        { adjustmentId: adj.adjustmentId, originalAdjustmentId: original.adjustmentId }
      );
    }

    // D, E, F, G. Cross-entity validation (companyId, modelId, workerId, opName)
    if (String(adj.companyId || '').trim() !== String(original.companyId || '').trim()) {
      throw new ProjectionValidationError(
        'REVERSAL_ENTITY_MISMATCH',
        `Reversal adjustment "${adj.adjustmentId}" companyId "${adj.companyId}" does not match original "${original.companyId}".`,
        { adjustmentId: adj.adjustmentId, field: 'companyId' }
      );
    }
    if (String(adj.modelId || '').trim() !== String(original.modelId || '').trim()) {
      throw new ProjectionValidationError(
        'REVERSAL_ENTITY_MISMATCH',
        `Reversal adjustment "${adj.adjustmentId}" modelId "${adj.modelId}" does not match original "${original.modelId}".`,
        { adjustmentId: adj.adjustmentId, field: 'modelId' }
      );
    }
    if (String(adj.workerId ?? '').trim() !== String(original.workerId ?? '').trim()) {
      throw new ProjectionValidationError(
        'REVERSAL_ENTITY_MISMATCH',
        `Reversal adjustment "${adj.adjustmentId}" workerId "${adj.workerId}" does not match original "${original.workerId}".`,
        { adjustmentId: adj.adjustmentId, field: 'workerId' }
      );
    }
    if (String(adj.opName || '').trim() !== String(original.opName || '').trim()) {
      throw new ProjectionValidationError(
        'REVERSAL_ENTITY_MISMATCH',
        `Reversal adjustment "${adj.adjustmentId}" opName "${adj.opName}" does not match original "${original.opName}".`,
        { adjustmentId: adj.adjustmentId, field: 'opName' }
      );
    }

    // H. Exact inverse delta match using roundFloat
    if (roundFloat(adj.deltaQty) !== roundFloat(-original.deltaQty)) {
      throw new ProjectionValidationError(
        'INVALID_REVERSAL_DELTA',
        `Reversal adjustment "${adj.adjustmentId}" deltaQty (${adj.deltaQty}) does not exactly negate original deltaQty (${original.deltaQty}).`,
        { adjustmentId: adj.adjustmentId, reversalDelta: adj.deltaQty, originalDelta: original.deltaQty }
      );
    }

    // I. Only one active APPROVED reversal may target one original adjustment
    if (adj.status === 'APPROVED') {
      const existingReversalId = approvedReversalsByOriginalId.get(adj.originalAdjustmentId);
      if (existingReversalId) {
        throw new ProjectionValidationError(
          'DUPLICATE_REVERSAL',
          `Multiple approved reversals detected for original adjustment "${adj.originalAdjustmentId}": "${existingReversalId}" and "${adj.adjustmentId}".`,
          { originalAdjustmentId: adj.originalAdjustmentId, firstReversalId: existingReversalId, secondReversalId: adj.adjustmentId }
        );
      }
      approvedReversalsByOriginalId.set(adj.originalAdjustmentId, adj.adjustmentId);
    }
  }

  // Pass 3C: Accumulation
  for (const adj of adjustments) {
    // Invariant Filtering:
    // PENDING_REVIEW: excluded from both projections
    // REVERSED: excluded from both projections
    if (adj.status !== 'APPROVED') {
      continue;
    }

    // Reversal Safety:
    // If this fact is a reversal referencing an originalAdjustmentId, AND that original fact
    // was ALSO marked 'REVERSED' in the same batch, skip the reversal fact delta to avoid double-subtraction.
    if (adj.originalAdjustmentId) {
      const original = adjustmentMap.get(adj.originalAdjustmentId);
      if (original && original.status === 'REVERSED') {
        // Original already contributes 0 because its status is REVERSED.
        // Applying the inverse delta would cause an unwanted negative net.
        continue;
      }
    }

    const modelId = String(adj.modelId || '').trim();
    const workerIdStr = String(adj.workerId ?? '').trim();
    const opName = String(adj.opName || '').trim();

    if (!modelId || !workerIdStr || !opName) {
      continue;
    }

    const acc = getOrCreateAcc(modelId, workerIdStr, opName);
    acc.adjustmentQty += adj.deltaQty;
  }

  // 4. Construct Deterministically Sorted Output Structures
  const optimistic: Record<string, Record<string | number, Record<string, number>>> = {};
  const accounting: Record<string, Record<string | number, Record<string, number>>> = {};
  const breakdown: Record<string, Record<string | number, Record<string, OperationProjectionBreakdown>>> = {};

  const sortedModelIds = Array.from(accMap.keys()).sort();

  for (const modelId of sortedModelIds) {
    const modelAcc = accMap.get(modelId)!;
    const sortedWorkerIds = Array.from(modelAcc.keys()).sort((a, b) => {
      // Numerical sort if both are numeric, else lexical
      const numA = Number(a);
      const numB = Number(b);
      if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
        return numA - numB;
      }
      return a.localeCompare(b);
    });

    optimistic[modelId] = {};
    accounting[modelId] = {};
    breakdown[modelId] = {};

    for (const workerIdStr of sortedWorkerIds) {
      const workerAcc = modelAcc.get(workerIdStr)!;
      const sortedOpNames = Array.from(workerAcc.keys()).sort();

      const optWorkerOps: Record<string, number> = {};
      const accWorkerOps: Record<string, number> = {};
      const brkWorkerOps: Record<string, OperationProjectionBreakdown> = {};

      for (const opName of sortedOpNames) {
        const acc = workerAcc.get(opName)!;

        // Round to 6 decimal places to prevent floating point accumulation drift (e.g. 0.1 + 0.2)
        const confirmedQty = roundFloat(acc.confirmedQty);
        const pendingQty = roundFloat(acc.pendingQty);
        const adjustmentQty = roundFloat(acc.adjustmentQty);

        // Formulas:
        // Optimistic Floor: CONFIRMED + PENDING_SYNC + APPROVED adjustments
        const totalQty = roundFloat(confirmedQty + pendingQty + adjustmentQty);

        // Authoritative Accounting: CONFIRMED + APPROVED adjustments
        const accountingQty = roundFloat(confirmedQty + adjustmentQty);

        optWorkerOps[opName] = totalQty;
        accWorkerOps[opName] = accountingQty;
        brkWorkerOps[opName] = {
          totalQty,
          confirmedQty,
          pendingQty,
          adjustmentQty,
          accountingQty
        };
      }

      optimistic[modelId][workerIdStr] = optWorkerOps;
      accounting[modelId][workerIdStr] = accWorkerOps;
      breakdown[modelId][workerIdStr] = brkWorkerOps;
    }
  }

  return {
    optimistic,
    accounting,
    breakdown
  };
}

/**
 * Accessor: retrieves optimistic quantity for a specific model, worker, and operation.
 */
export function getOptimisticQuantity(
  result: HisobProjectionsResult,
  modelId: string,
  workerId: number | string,
  opName: string
): number {
  return result.optimistic[modelId]?.[String(workerId)]?.[opName] ?? 0;
}

/**
 * Accessor: retrieves authoritative accounting quantity for a specific model, worker, and operation.
 */
export function getAccountingQuantity(
  result: HisobProjectionsResult,
  modelId: string,
  workerId: number | string,
  opName: string
): number {
  return result.accounting[modelId]?.[String(workerId)]?.[opName] ?? 0;
}

/**
 * Accessor: retrieves breakdown metadata for a specific model, worker, and operation.
 */
export function getOperationBreakdown(
  result: HisobProjectionsResult,
  modelId: string,
  workerId: number | string,
  opName: string
): OperationProjectionBreakdown {
  return (
    result.breakdown[modelId]?.[String(workerId)]?.[opName] ?? {
      totalQty: 0,
      confirmedQty: 0,
      pendingQty: 0,
      adjustmentQty: 0,
      accountingQty: 0
    }
  );
}

