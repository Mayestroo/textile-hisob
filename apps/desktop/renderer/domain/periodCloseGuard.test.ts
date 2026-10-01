import { describe, it, expect } from 'vitest';
import { evaluatePeriodCloseGuard, assertCanClosePeriod } from './periodCloseGuard';

describe('Period-Close Safety Guard (Gate 11 / Item 30)', () => {
  const cleanInput = {
    companyId: 'comp_test',
    periodId: 'period_2026_09',
    outboxPendingCount: 0,
    outboxSendingCount: 0,
    outboxConflictCount: 0,
    outboxDeadLetterCount: 0,
    unresolvedReconciliationCount: 0
  };

  it('allows period close when all transactions are confirmed and no candidates exist', () => {
    const result = evaluatePeriodCloseGuard(cleanInput);
    expect(result.canClose).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(() => assertCanClosePeriod(cleanInput)).not.toThrow();
  });

  it('blocks period close when outbox has PENDING operations', () => {
    const input = { ...cleanInput, outboxPendingCount: 3 };
    const result = evaluatePeriodCloseGuard(input);
    expect(result.canClose).toBe(false);
    expect(result.blockers[0]).toContain('OUTBOX_PENDING');
    expect(() => assertCanClosePeriod(input)).toThrow(/OUTBOX_PENDING/);
  });

  it('blocks period close when outbox has SENDING operations in-flight', () => {
    const input = { ...cleanInput, outboxSendingCount: 1 };
    const result = evaluatePeriodCloseGuard(input);
    expect(result.canClose).toBe(false);
    expect(result.blockers[0]).toContain('OUTBOX_SENDING');
  });

  it('blocks period close when outbox has CONFLICT operations', () => {
    const input = { ...cleanInput, outboxConflictCount: 2 };
    const result = evaluatePeriodCloseGuard(input);
    expect(result.canClose).toBe(false);
    expect(result.blockers[0]).toContain('OUTBOX_CONFLICT');
  });

  it('blocks period close when outbox has DEAD_LETTER operations', () => {
    const input = { ...cleanInput, outboxDeadLetterCount: 1 };
    const result = evaluatePeriodCloseGuard(input);
    expect(result.canClose).toBe(false);
    expect(result.blockers[0]).toContain('OUTBOX_DEAD_LETTER');
  });

  it('blocks period close when unresolved reconciliation candidates exist', () => {
    const input = { ...cleanInput, unresolvedReconciliationCount: 5 };
    const result = evaluatePeriodCloseGuard(input);
    expect(result.canClose).toBe(false);
    expect(result.blockers[0]).toContain('UNRESOLVED_RECONCILIATION');
  });

  it('aggregates multiple simultaneous blockers in descriptive error report', () => {
    const input = {
      ...cleanInput,
      outboxPendingCount: 2,
      outboxConflictCount: 1,
      unresolvedReconciliationCount: 4
    };
    const result = evaluatePeriodCloseGuard(input);
    expect(result.canClose).toBe(false);
    expect(result.blockers).toHaveLength(3);
    expect(() => assertCanClosePeriod(input)).toThrow(/PERIOD_CLOSE_BLOCKED/);
  });
});
