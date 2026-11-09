import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkbookStore } from '../workbookStore';

const valuation = {
  companyId: 'company-a', period: { id: 'period-a' }, workers: [{ workerId: 1 }],
  accountingStatus: 'COMPLETE', accountingReasons: [], syncStatus: 'SYNCED'
} as any;

describe('license context payroll invalidation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['changed company', { isActivated: true, companyId: 'company-b', machineId: 'device-a' }],
    ['null context', null],
    ['invalid context', { isActivated: false, companyId: 'company-a', machineId: 'device-a' }]
  ])('clears valuation for %s', async (_label, status) => {
    const previous = useWorkbookStore.getState();
    vi.stubGlobal('window', { electronAPI: { getLicenseStatus: vi.fn().mockResolvedValue(status) } });
    useWorkbookStore.setState({
      licenseStatus: { isActivated: true, companyId: 'company-a', machineId: 'device-a' } as any,
      payrollValuation: valuation
    });
    try {
      await useWorkbookStore.getState().checkLicense();
      expect(useWorkbookStore.getState().payrollValuation).toMatchObject({
        companyId: status?.companyId || '', period: null, workers: [],
        accountingStatus: 'UNAVAILABLE', syncStatus: 'UNKNOWN'
      });
    } finally {
      useWorkbookStore.setState(previous, true);
    }
  });

  it('preserves valuation on a same-context license refresh', async () => {
    const previous = useWorkbookStore.getState();
    const status = { isActivated: true, companyId: ' company-a ', machineId: 'device-a', expiry: 'later' };
    vi.stubGlobal('window', { electronAPI: { getLicenseStatus: vi.fn().mockResolvedValue(status) } });
    useWorkbookStore.setState({
      licenseStatus: { isActivated: true, companyId: 'company-a', machineId: 'device-a' } as any,
      payrollValuation: valuation
    });
    try {
      await useWorkbookStore.getState().checkLicense();
      expect(useWorkbookStore.getState().payrollValuation).toBe(valuation);
    } finally {
      useWorkbookStore.setState(previous, true);
    }
  });
});
