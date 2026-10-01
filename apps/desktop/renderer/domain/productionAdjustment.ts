/**
 * Canonical Production Adjustment Fact Model
 * Phase 2 — Step 2
 *
 * Replaces direct mutable hisob aggregate overrides with immutable, delta-based
 * adjustment facts that preserve full provenance and auditability.
 */

export type ProductionAdjustmentStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REVERSED';

// For  reconciliation facts, APPROVED means authoritatively committed by the
// server. A local operator decision must remain an outbox intent until then.

export interface ProductionAdjustmentFact {
  adjustmentId: string;
  companyId: string;
  modelId: string;
  workerId: number | string;
  opName: string;
  deltaQty: number;
  reason: string;
  status: ProductionAdjustmentStatus;
  provenance: string;
  createdAt: string;
  createdBy: string;
  originalAdjustmentId?: string;
}

export interface CreateAdjustmentDraftParams {
  adjustmentId?: string;
  companyId: string;
  modelId: string;
  workerId: number | string;
  opName: string;
  deltaQty: number;
  reason: string;
  status?: ProductionAdjustmentStatus;
  provenance?: string;
  createdAt?: string;
  createdBy: string;
}

export interface CreateReversalParams {
  reversalId?: string;
  reason?: string;
  createdAt?: string;
  createdBy: string;
}

export interface MigrationReconciliationCandidateInput {
  candidateId: string;
  companyId: string;
  modelId: string;
  workerId: number | string;
  operationName: string;
  legacyQty: number;
  ticketDerivedQty: number;
  deltaQty: number;
  status?: string;
  reason?: string;
}

/**
 * Validates numeric values strictly as finite numbers.
 * Rejects NaN, Infinity, -Infinity, non-numeric strings.
 */
export function assertFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid ${fieldName}: expected finite number, received ${String(value)} (${typeof value})`);
  }
  return value;
}

/**
 * Creates a valid ProductionAdjustmentFact draft.
 * Adjustments are strictly delta-based (e.g. +12 or -7), never absolute totals.
 */
export function createProductionAdjustmentDraft(params: CreateAdjustmentDraftParams): ProductionAdjustmentFact {
  const delta = assertFiniteNumber(params.deltaQty, 'deltaQty');

  if (!params.companyId || typeof params.companyId !== 'string') {
    throw new TypeError('companyId must be a non-empty string');
  }
  if (!params.modelId || typeof params.modelId !== 'string') {
    throw new TypeError('modelId must be a non-empty string');
  }
  if (params.workerId === undefined || params.workerId === null || params.workerId === '') {
    throw new TypeError('workerId must be provided');
  }
  if (!params.opName || typeof params.opName !== 'string') {
    throw new TypeError('opName must be a non-empty string');
  }
  if (!params.reason || typeof params.reason !== 'string') {
    throw new TypeError('reason must be a non-empty string');
  }
  if (!params.createdBy || typeof params.createdBy !== 'string') {
    throw new TypeError('createdBy must be a non-empty string');
  }

  const id = params.adjustmentId || `adj_${params.companyId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  return {
    adjustmentId: id,
    companyId: params.companyId,
    modelId: params.modelId,
    workerId: params.workerId,
    opName: params.opName,
    deltaQty: delta,
    reason: params.reason,
    status: params.status || 'PENDING_REVIEW',
    provenance: params.provenance || 'MANUAL_CORRECTION',
    createdAt: params.createdAt || new Date().toISOString(),
    createdBy: params.createdBy
  };
}

/**
 * Creates an immutable reversal fact for an existing approved adjustment.
 * Delta is strictly the inverse (-deltaQty).
 */
export function createReversalAdjustment(
  original: ProductionAdjustmentFact,
  params: CreateReversalParams
): ProductionAdjustmentFact {
  if (!original || typeof original !== 'object') {
    throw new TypeError('original adjustment must be a valid ProductionAdjustmentFact object');
  }
  assertFiniteNumber(original.deltaQty, 'original.deltaQty');
  if (original.status !== 'APPROVED') {
    throw new Error(
      `Cannot reverse adjustment "${original.adjustmentId}" with status "${String(original.status)}". Only APPROVED adjustments can be reversed.`
    );
  }
  if (original.originalAdjustmentId || original.provenance === 'REVERSAL') {
    throw new TypeError(`Cannot reverse an adjustment that is already a reversal: "${original.adjustmentId}"`);
  }

  const id = params.reversalId || `rev_${original.adjustmentId}_${Date.now()}`;

  return {
    adjustmentId: id,
    companyId: original.companyId,
    modelId: original.modelId,
    workerId: original.workerId,
    opName: original.opName,
    deltaQty: -original.deltaQty,
    reason: params.reason || `Reversal of adjustment ${original.adjustmentId}: ${original.reason}`,
    status: 'APPROVED',
    provenance: 'REVERSAL',
    createdAt: params.createdAt || new Date().toISOString(),
    createdBy: params.createdBy,
    originalAdjustmentId: original.adjustmentId
  };
}

/**
 * Converts a Step 1 migration reconciliation candidate into a canonical
 * ProductionAdjustmentFact upon explicit user/administrative approval.
 * Note: candidates do NOT become adjustments automatically.
 */
export function convertCandidateToAdjustmentFact(
  candidate: MigrationReconciliationCandidateInput,
  approval: {
    adjustmentId?: string;
    approvedBy: string;
    approvedAt?: string;
    notes?: string;
    status?: ProductionAdjustmentStatus;
  }
): ProductionAdjustmentFact {
  assertFiniteNumber(candidate.deltaQty, 'candidate.deltaQty');

  const id = approval.adjustmentId || `adj_recon_${candidate.candidateId}`;

  return {
    adjustmentId: id,
    companyId: candidate.companyId,
    modelId: candidate.modelId,
    workerId: candidate.workerId,
    opName: candidate.operationName,
    deltaQty: candidate.deltaQty,
    reason: approval.notes || `Approved migration reconciliation candidate ${candidate.candidateId}`,
    status: approval.status || 'APPROVED',
    provenance: 'MIGRATION_RECONCILIATION_APPROVAL',
    createdAt: approval.approvedAt || new Date().toISOString(),
    createdBy: approval.approvedBy
  };
}
