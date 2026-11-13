import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const { classifyLegacyStaj, fromMinorUnits, planStajAllocation, toMinorUnits } = require('../stajDebtLedger.cjs');
const { reducePayroll } = require('../payrollReducer.cjs');

describe('STAJ-001 exact debt allocation rules', () => {
  it('does not validate or deduct a legacy worker attribute', () => {
    expect(classifyLegacyStaj('5740000')).toMatchObject({ classification: 'RECONCILIATION_REQUIRED', deductionEligible: false });
    const payroll = reducePayroll({ id: 'p1', is_closed: false }, [{ worker_id: 7, worker_name: 'W', staj: 500000 }], [], [], [], {});
    expect(payroll.workers[0]).toMatchObject({ staj: 0, legacyStaj: 500000, net: 0, accountingStatus: 'INCOMPLETE' });
    expect(payroll.workers[0].accountingReasons).toContain('LEGACY_STAJ_REQUIRES_RECONCILIATION');
  });
  it('deducts a verified claim once and exact replay returns the same allocation', () => {
    const input = { companyId: 'c1', workerId: 7, periodId: 'p1', claimId: 'd1', claimAmount: '500000.00',
      availableEarnings: '2000000.00', operationId: 'op1' };
    const first = planStajAllocation(input);
    expect(first.allocation).toMatchObject({ amount: '500000.00', deficit: '0.00', status: 'SETTLED' });
    expect(planStajAllocation({ ...input, priorAllocations: [first.allocation] })).toEqual({ replay: true, allocation: first.allocation });
  });
  it('caps a partial allocation at earnings and leaves the remainder for review without auto-carry', () => {
    const result = planStajAllocation({ companyId: 'c1', workerId: 7, periodId: 'p1', claimId: 'd1', claimAmount: '500.00',
      availableEarnings: '125.25', operationId: 'op1' });
    expect(result.allocation).toMatchObject({ amount: '125.25', deficit: '374.75', status: 'REVIEW_REQUIRED' });
    expect(() => planStajAllocation({ companyId: 'c1', workerId: 7, periodId: 'p2', claimId: 'd1', claimAmount: '500.00',
      availableEarnings: '1000.00', operationId: 'op2', priorAllocations: [result.allocation] })).toThrow('STAJ_CLAIM_ALREADY_ALLOCATED');
  });
  it('never allocates more than the exact authorized amount and separates tenants', () => {
    expect(toMinorUnits('0.10') + toMinorUnits('0.20')).toBe(30n);
    expect(fromMinorUnits(30n)).toBe('0.30');
    expect(() => planStajAllocation({ companyId: 'c2', workerId: 7, periodId: 'p2', claimId: 'd1', claimAmount: '500.00',
      availableEarnings: '500.00', operationId: 'op2', priorAllocations: [{ companyId: 'c1', claimId: 'd1', operationId: 'op1' }] })).not.toThrow();
  });
  it('matches an independent Python Decimal oracle for full and insufficient-wage cases', () => {
    const oracle = path.resolve('scripts/verify/database/staj-decimal-oracle.py');
    for (const [debt, earnings] of [['500000.00', '2000000.00'], ['500.00', '125.25']]) {
      const expected = JSON.parse(spawnSync('python', [oracle, debt, earnings], { encoding: 'utf8' }).stdout);
      const actual = planStajAllocation({ companyId: 'c1', workerId: 7, periodId: 'p1', claimId: `d${debt}`,
        claimAmount: debt, availableEarnings: earnings, operationId: `op${earnings}` }).allocation;
      expect({ allocation: actual.amount, deficit: actual.deficit, status: actual.status }).toEqual(expected);
    }
  });
});
