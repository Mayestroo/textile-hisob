import { describe, expect, it, vi } from 'vitest';

describe('store bridge', () => {
  it('synchronizes the active workbook sheet and VPS-licensed identity to UI/auth stores', async () => {
    const effects: Array<() => void> = [];
    const subscriptions: Array<(state: any, previous: any) => void> = [];
    const setActiveSheet = vi.fn();
    const setWorkbookState = vi.fn();
    const setAuth = vi.fn();
    const licenseStatus = {
      companyId: 'company-a', machineId: 'device-a', isActivated: true, isBlocked: false, role: 'admin'
    };
    const workbook = {
      activeSheet: 'Patta-Hisob',
      licenseStatus,
      subscribe: (callback: (state: any, previous: any) => void) => { subscriptions.push(callback); return () => {}; },
      getState: () => workbook,
      setState: setWorkbookState
    };
    vi.doMock('react', () => ({ useEffect: (effect: () => void) => effects.push(effect) }));
    vi.doMock('../workbookStore', () => ({ useWorkbookStore: workbook }));
    vi.doMock('../uiStore', () => ({ useUIStore: { getState: () => ({ setActiveSheet }) } }));
    vi.doMock('../authStore', () => ({
      useAuthStore: { getState: () => ({ setAuth, deviceId: null }) },
      applyRolePermissions: () => ['read']
    }));

    const { useStoreBridge, syncLicenseAuth } = await import('../bridge');
    useStoreBridge();
    effects.forEach((effect) => effect());

    expect(setActiveSheet).toHaveBeenCalledWith('Patta-Hisob');
    expect(setAuth).toHaveBeenCalledWith(expect.objectContaining({
      status: 'active', role: 'admin', companyId: 'company-a', deviceId: 'device-a'
    }));
    expect(subscriptions.length).toBe(2);

    subscriptions[1]({ ...workbook, licenseStatus: { ...licenseStatus } }, workbook);
    expect(setWorkbookState).not.toHaveBeenCalled();
    const changedLicense = { ...licenseStatus, activationId: 'activation-reauth' };
    subscriptions[1]({ ...workbook, licenseStatus: changedLicense }, workbook);
    expect(setWorkbookState).toHaveBeenCalledWith({ payrollValuation: {
      companyId: 'company-a', period: null, workers: [], accountingStatus: 'UNAVAILABLE',
      accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN'
    } });
    expect(setAuth).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: 'company-a', status: 'active' }));
    syncLicenseAuth({ ...licenseStatus, isBlocked: true });
    expect(setAuth).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'suspended', role: null, permissions: [] }));
    syncLicenseAuth(null);
    expect(setAuth).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'pending_approval', role: null, permissions: [] }));
  });
});
