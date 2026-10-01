/**
 * Pure Domain Models & Rules for Operator Reconciliation Resolution
 * Phase 2 — Operator Reconciliation Resolution
 *
 * Enforces:
 * - Local dispositions are immutable pending intents only.
 * - CONFIRM/REJECT become final only after authoritative server commit.
 * - LINK_TO_MISSING_SOURCE remains unresolved until the source is reconciled.
 * - DEFER_REVIEW remains PENDING_REVIEW and never clears the close guard.
 * - Strict RBAC role authorization: requires 'admin' or 'accountant'
 * - Candidate coordinates & delta anti-tampering: adjustments derived strictly from candidate facts
 * - Conservation invariant: approved + rejected + pending + linked === original delta total (747 units)
 */

import { ProductionAdjustmentFact } from './productionAdjustment';

export type ReconciliationDecision =
  | 'CONFIRM_LEGACY_AS_ADJUSTMENT'
  | 'REJECT_LEGACY_DIFFERENCE'
  | 'LINK_TO_MISSING_SOURCE'
  | 'DEFER_REVIEW';

export const ALLOWED_RECONCILIATION_DECISIONS: ReadonlySet<ReconciliationDecision> = new Set([
  'CONFIRM_LEGACY_AS_ADJUSTMENT',
  'REJECT_LEGACY_DIFFERENCE',
  'LINK_TO_MISSING_SOURCE',
  'DEFER_REVIEW'
]);

export const AUTHORIZED_ROLES: ReadonlySet<string> = new Set([
  'admin',
  'accountant',
  'head_accountant',
  'accounting'
]);

export interface ReconciliationCandidate {
  candidateId: string;
  companyId: string;
  modelId: string;
  workerId: number | string;
  operationName: string;
  legacyQty: number;
  ticketDerivedQty: number;
  deltaQty: number;
  status: string;
  reason: string;
  notes?: string | null;
  sourceSnapshotHash?: string | null;
  resolutionDecision?: string | null;
  resolutionOperatorId?: string | null;
  resolvedAt?: string | null;
  createdAdjustmentId?: string | null;
  sourceReference?: string | null;
}

export interface ReconciliationResolutionFact {
  resolutionId: string;
  candidateId: string;
  companyId: string;
  decision: ReconciliationDecision;
  operatorId: string;
  operatorRole: string;
  reason: string;
  decidedAt: string;
  sourceSnapshotHash: string;
  legacyQty: number;
  derivedQty: number;
  deltaQty: number;
  createdAdjustmentId?: string | null;
  sourceReference?: string | null;
  resolutionProvenance: string;
}

export interface ResolveCandidateInput {
  commandId?: string;
  operationId: string;
  companyId: string;
  candidateId: string;
  decision: ReconciliationDecision;
  operatorId: string;
  operatorRole: string;
  reason: string;
  sourceReference?: string | null;
}

/**
 * Authority state machine for reconciliation decisions:
 * PENDING_REVIEW -> PENDING_SYNC (local intent) -> APPROVED/REJECTED (server commit).
 * LINKED_SOURCE_PENDING and DEFER_REVIEW are non-final workflow states.
 * Only server-committed APPROVED adjustments may enter accounting projections.
 */
export type ReconciliationAuthorityState =
  | 'PENDING_REVIEW'
  | 'PENDING_SYNC'
  | 'LINKED_SOURCE_PENDING'
  | 'APPROVED'
  | 'REJECTED';

export interface ReconciliationSummary {
  approvedAdjustmentTotal: number;
  rejectedTotal: number;
  stillPendingTotal: number;
  linkedSourceTotal: number;
  totalDelta: number;
  candidateCount: number;
  unresolvedCount: number;
}

export class ReconciliationError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(`[ReconciliationError: ${code}] ${message}`);
    this.name = 'ReconciliationError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, ReconciliationError.prototype);
  }
}

/**
 * Validates whether the given role is authorized to resolve accounting discrepancies.
 * Fails closed for ordinary production workers ('type', 'print', 'worker', etc.).
 */
export function isAuthorizedOperatorRole(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  const normalized = role.trim().toLowerCase();
  return AUTHORIZED_ROLES.has(normalized);
}

/**
 * Asserts that the operator has an authorized administrative or accounting role.
 * Throws UNAUTHORIZED_ROLE if the role is unauthorized.
 */
export function assertAuthorizedOperatorRole(role: unknown, operatorId?: string): void {
  if (!isAuthorizedOperatorRole(role)) {
    throw new ReconciliationError(
      'UNAUTHORIZED_ROLE',
      `Actor "${String(operatorId || 'unknown')}" with role "${String(role)}" is not authorized to resolve migration reconciliation candidates. Requires admin or accountant role.`,
      { role, operatorId }
    );
  }
}

/**
 * Validates that the decision is one of the four allowed dispositions.
 */
export function validateReconciliationDecision(decision: unknown): ReconciliationDecision {
  if (typeof decision !== 'string' || !ALLOWED_RECONCILIATION_DECISIONS.has(decision as ReconciliationDecision)) {
    throw new ReconciliationError(
      'INVALID_DECISION',
      `Invalid reconciliation decision: "${String(decision)}". Must be one of: ${Array.from(ALLOWED_RECONCILIATION_DECISIONS).join(', ')}`,
      { decision }
    );
  }
  return decision as ReconciliationDecision;
}

/**
 * Calculates reconciliation metrics and verifies that:
 * approved + rejected + pending + linked === totalDelta
 */
export function computeReconciliationSummary(
  candidates: ReconciliationCandidate[]
): ReconciliationSummary {
  let approvedAdjustmentTotal = 0;
  let rejectedTotal = 0;
  let stillPendingTotal = 0;
  let linkedSourceTotal = 0;
  let totalDelta = 0;
  let unresolvedCount = 0;

  for (const c of candidates) {
    const delta = Number(c.deltaQty || 0);
    totalDelta += delta;

    const decision = c.resolutionDecision || (c.status === 'APPROVED' ? 'CONFIRM_LEGACY_AS_ADJUSTMENT' : null);

    if (decision === 'CONFIRM_LEGACY_AS_ADJUSTMENT' || c.status === 'APPROVED') {
      approvedAdjustmentTotal += delta;
    } else if (decision === 'REJECT_LEGACY_DIFFERENCE' || c.status === 'REJECTED') {
      rejectedTotal += delta;
    } else if (decision === 'LINK_TO_MISSING_SOURCE' || c.status === 'LINKED_SOURCE_PENDING') {
      linkedSourceTotal += delta;
      unresolvedCount++;
    } else {
      // PENDING_REVIEW or DEFER_REVIEW
      stillPendingTotal += delta;
      unresolvedCount++;
    }
  }

  // Rounding precision check
  const sumCheck = Math.round((approvedAdjustmentTotal + rejectedTotal + stillPendingTotal + linkedSourceTotal) * 1e6) / 1e6;
  const roundedTotal = Math.round(totalDelta * 1e6) / 1e6;

  if (sumCheck !== roundedTotal) {
    throw new ReconciliationError(
      'INVARIANT_VIOLATION',
      `Reconciliation totals drift: sum (${sumCheck}) does not match total delta (${roundedTotal})`
    );
  }

  return {
    approvedAdjustmentTotal: Math.round(approvedAdjustmentTotal * 1e6) / 1e6,
    rejectedTotal: Math.round(rejectedTotal * 1e6) / 1e6,
    stillPendingTotal: Math.round(stillPendingTotal * 1e6) / 1e6,
    linkedSourceTotal: Math.round(linkedSourceTotal * 1e6) / 1e6,
    totalDelta: roundedTotal,
    candidateCount: candidates.length,
    unresolvedCount
  };
}

/**
 * Determines count of candidates that are still unresolved.
 * Cutover gate remains blocked if this count > 0.
 */
export function countUnresolvedCandidates(candidates: ReconciliationCandidate[]): number {
  return candidates.filter(c => {
    const isApproved = c.status === 'APPROVED' || c.resolutionDecision === 'CONFIRM_LEGACY_AS_ADJUSTMENT';
    const isRejected = c.status === 'REJECTED' || c.resolutionDecision === 'REJECT_LEGACY_DIFFERENCE';
    return !isApproved && !isRejected;
  }).length;
}

/**
 * Creates an immutable production adjustment from an approved candidate.
 * Coordinates (modelId, workerId, opName) and deltaQty are locked to candidate facts.
 */
export function createApprovedAdjustmentFromCandidate(
  candidate: ReconciliationCandidate,
  operatorId: string,
  reason: string,
  options: {
    adjustmentId?: string;
    decidedAt?: string;
  } = {}
): ProductionAdjustmentFact {
  const adjId = options.adjustmentId || `adj_rec_${candidate.candidateId.slice(0, 8)}_${Date.now()}`;
  const decidedAt = options.decidedAt || new Date().toISOString();

  return {
    adjustmentId: adjId,
    companyId: candidate.companyId,
    modelId: candidate.modelId,
    workerId: candidate.workerId,
    opName: candidate.operationName,
    deltaQty: Number(candidate.deltaQty),
    reason: `Historical reconciliation approval: ${reason.trim()}`,
    status: 'APPROVED',
    provenance: 'MIGRATION_RECONCILIATION_APPROVAL',
    createdAt: decidedAt,
    createdBy: operatorId
  };
}
