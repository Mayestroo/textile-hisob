/**
 * Novda Hisob-Kitob  — Period-Close Safety Guard (Gate 11 / Item 30)
 *
 * Verifies that a payroll/accounting period cannot be closed or archived while
 * asynchronous transactions remain unconfirmed, in-flight, conflicted, or in DEAD_LETTER,
 * or while unexplained legacy reconciliation candidates remain unresolved.
 *
 * Invariant: Accounting reports and period snapshots may only derive from
 * confirmed, authoritative facts.
 */

export interface PeriodCloseGuardInput {
  companyId: string;
  periodId: string;
  outboxPendingCount: number;
  outboxSendingCount: number;
  outboxConflictCount: number;
  outboxDeadLetterCount: number;
  unresolvedReconciliationCount: number;
}

export interface PeriodCloseGuardResult {
  canClose: boolean;
  blockers: string[];
  details: {
    pending: number;
    sending: number;
    conflict: number;
    deadLetter: number;
    unresolvedReconciliation: number;
  };
}

/**
 * Assesses whether a period can be safely closed.
 * Fails closed if any in-flight outbox state or reconciliation difference exists.
 *
 * @param input Metrics describing outbox and reconciliation state
 * @returns Evaluation result with active blockers
 */
export function evaluatePeriodCloseGuard(input: PeriodCloseGuardInput): PeriodCloseGuardResult {
  const blockers: string[] = [];

  if (input.outboxPendingCount > 0) {
    blockers.push(`OUTBOX_PENDING: ${input.outboxPendingCount} transaction(s) pending local sync`);
  }

  if (input.outboxSendingCount > 0) {
    blockers.push(`OUTBOX_SENDING: ${input.outboxSendingCount} transaction(s) actively in-flight to server`);
  }

  if (input.outboxConflictCount > 0) {
    blockers.push(`OUTBOX_CONFLICT: ${input.outboxConflictCount} unresolved transaction conflict(s) exist`);
  }

  if (input.outboxDeadLetterCount > 0) {
    blockers.push(`OUTBOX_DEAD_LETTER: ${input.outboxDeadLetterCount} transaction(s) halted in DEAD_LETTER queue`);
  }

  if (input.unresolvedReconciliationCount > 0) {
    blockers.push(`UNRESOLVED_RECONCILIATION: ${input.unresolvedReconciliationCount} unexplained reconciliation candidate(s) awaiting review`);
  }

  return {
    canClose: blockers.length === 0,
    blockers,
    details: {
      pending: input.outboxPendingCount,
      sending: input.outboxSendingCount,
      conflict: input.outboxConflictCount,
      deadLetter: input.outboxDeadLetterCount,
      unresolvedReconciliation: input.unresolvedReconciliationCount
    }
  };
}

/**
 * Asserts that a period can be closed, throwing a descriptive error if blocked.
 *
 * @param input
 * @throws Error if period closure is blocked
 */
export function assertCanClosePeriod(input: PeriodCloseGuardInput): void {
  const result = evaluatePeriodCloseGuard(input);
  if (!result.canClose) {
    const error = new Error(`PERIOD_CLOSE_BLOCKED: Cannot close period "${input.periodId}". Active blockers:\n- ${result.blockers.join('\n- ')}`);
    (error as any).code = 'PERIOD_CLOSE_BLOCKED';
    (error as any).blockers = result.blockers;
    (error as any).details = result.details;
    throw error;
  }
}
