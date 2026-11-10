import { describe, expect, it, vi } from 'vitest';
import { hydratePayrollValuation, hydrateWorkbookProjection, preserveWorkbookProjectionDrafts, runReconnect, runSyncPull, stalePayrollValuation } from '../businessMutations';

describe('payroll valuation workbook hydration', () => {
  const payroll = {
    companyId: 'company-a',
    period: { periodId: 'period-a', name: 'October', startDate: '2026-10-01', endDate: null, isClosed: false, restated: false },
    workers: [{ workerId: 7, gross: 0 }],
    accountingStatus: 'INCOMPLETE' as const,
    accountingReasons: ['SYNC_FRESHNESS_UNVERIFIED'],
    syncStatus: 'UNKNOWN' as const
  };

  it('retains scoped valuation and exact incomplete/unknown statuses through workbook hydration', () => {
    const hydrated = hydrateWorkbookProjection({
      companyId: 'company-a',
      currentPeriod: { id: 'period-a', name: 'October', startDate: '2026-10-01', isClosed: false },
      periods: [],
      payrollValuation: payroll
    }, 'company-a');

    expect(hydrated.payrollValuation).toEqual(payroll);
  });

  it('treats legacy missing values and mismatched company or period as unavailable, never carrying stale data', () => {
    for (const candidate of [undefined, { ...payroll, companyId: 'company-b' }, {
      ...payroll, period: { ...payroll.period, periodId: 'period-old' }
    }]) {
      expect(hydratePayrollValuation(candidate, 'company-a', 'period-a')).toMatchObject({
        accountingStatus: 'UNAVAILABLE',
        syncStatus: 'UNKNOWN',
        accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'],
        workers: []
      });
    }
  });

  it('downgrades previously current as-of valuation after disconnect without changing money', () => {
    const current = { ...payroll, accountingStatus: 'COMPLETE' as const, accountingReasons: [],
      syncStatus: 'CURRENT' as const, feedEvidence: { asOfCursor: '44', status: 'APPLIED_AS_OF' as const },
      workers: [{ workerId: 7, gross: 105, syncStatus: 'CURRENT', accountingStatus: 'COMPLETE', accountingReasons: [] }] };
    expect(stalePayrollValuation(current)).toMatchObject({ syncStatus: 'UNKNOWN', accountingStatus: 'INCOMPLETE',
      workers: [{ gross: 105, syncStatus: 'UNKNOWN' }], feedEvidence: { asOfCursor: '44', status: 'STALE_AS_OF' },
      accountingReasons: ['SYNC_FRESHNESS_UNVERIFIED'] });
    expect(stalePayrollValuation(payroll)).toBe(payroll);
  });
});

describe('workbook projection refresh draft preservation', () => {
  it('keeps local ticket drafts when a canonical SQLite projection reloads', () => {
    const draft = { 'model-a': { date: '2026-10-07', qty: '123', party: '17', color: '', size: '', entries: {} } };
    const refreshed = preserveWorkbookProjectionDrafts({
      models: [{ id: 'model-a', name: 'Model A' }],
      ticketForms: { 'model-a': { date: '2026-10-07', qty: '12', party: '17', color: '', size: '', entries: {} } },
      availableSizes: ['M'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '17', totalIshSoni: '', sizes: {} } }
    }, {
      ticketForms: draft,
      availableSizes: ['M', 'L'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '18', totalIshSoni: '', sizes: {} } }
    });

    expect(refreshed.models).toEqual([{ id: 'model-a', name: 'Model A' }]);
    expect(refreshed.ticketForms).toBe(draft);
    expect(refreshed.availableSizes).toEqual(['M']);
  });

  it('also keeps batch-setting drafts while their inputs are being saved', () => {
    const batchDrafts = { 'model-a': { partyNumber: '18', totalIshSoni: '', sizes: {} } };
    const refreshed = preserveWorkbookProjectionDrafts({
      ticketForms: {},
      availableSizes: ['M'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '17', totalIshSoni: '', sizes: {} } }
    }, {
      ticketForms: {},
      availableSizes: ['M', 'L'],
      pattaBatchConfigs: batchDrafts
    }, true);

    expect(refreshed.availableSizes).toEqual(['M', 'L']);
    expect(refreshed.pattaBatchConfigs).toBe(batchDrafts);
  });

  it('serializes the lightweight background pull with full reconnects per company', async () => {
    let releasePull: (() => void) | undefined;
    const order: string[] = [];
    const eAPI = {
      SyncPull: vi.fn(async () => {
        order.push('pull-start');
        await new Promise<void>((resolve) => { releasePull = resolve; });
        order.push('pull-end');
        return { success: true };
      }),
      SyncReconnect: vi.fn(async () => {
        order.push('reconnect');
        return { success: true };
      })
    };

    const pull = runSyncPull(eAPI, 'company-pull-queue');
    const reconnect = runReconnect(eAPI, 'company-pull-queue');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['pull-start']);
    releasePull?.();
    await Promise.all([pull, reconnect]);

    expect(order).toEqual(['pull-start', 'pull-end', 'reconnect']);
  });
});
