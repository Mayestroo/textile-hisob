import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersistenceSlice } from './createPersistenceSlice';
import { resetSessionGuardForTests } from '../sessionGuard';

function makeSlice() {
  let state: any = {
    licenseStatus: { companyId: 'company-a', activationId: 'activation-a', machineId: 'machine-a' },
    checkLicense: vi.fn().mockResolvedValue(undefined),
    addNotification: vi.fn(),
    setLoadingMessage: vi.fn()
  };
  const set = vi.fn((next: any) => {
    state = { ...state, ...(typeof next === 'function' ? next(state) : next) };
  });
  const slice = createPersistenceSlice(set as any, (() => state) as any, {} as any);
  return { slice, set, state: () => state };
}

describe('VPS-authoritative persistence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSessionGuardForTests();
    vi.stubGlobal('navigator', { userAgent: 'test', onLine: true });
    vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn() });
  });

  it('bootstraps from VPS before hydrating the company projection', async () => {
    const SyncBootstrap = vi.fn().mockResolvedValue({ success: true, result: { status: 'APPLIED' } });
    const dbRead = vi.fn().mockResolvedValue({ success: true, data: {
      companyId: 'company-a', workers: [], models: [], submittedTickets: [], printedPartyHistory: [], periods: []
    } });
    vi.stubGlobal('window', { electronAPI: {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      SyncBootstrap,
      dbRead
    } });
    const { slice, set } = makeSlice();

    await slice.initStore();

    expect(SyncBootstrap).toHaveBeenCalledWith('company-a');
    expect(dbRead).toHaveBeenCalledWith('company-a');
    expect(SyncBootstrap.mock.invocationCallOrder[0]).toBeLessThan(dbRead.mock.invocationCallOrder[0]);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ isServerConnected: false }));
  });

  it('does not hydrate a projection when the VPS bootstrap fails', async () => {
    const SyncBootstrap = vi.fn().mockResolvedValue({
      success: false, code: 'BOOTSTRAP_RECOVERY_REQUIRED', error: 'Local outbox needs recovery'
    });
    const dbRead = vi.fn();
    vi.stubGlobal('window', { electronAPI: {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      SyncBootstrap,
      dbRead
    } });
    const { slice, set, state } = makeSlice();

    await slice.initStore();

    expect(dbRead).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ models: expect.anything() }));
    expect(state().addNotification).toHaveBeenCalledWith('error', 'BOOTSTRAP_RECOVERY_REQUIRED', 'Local outbox needs recovery');
  });

  it('rejects cross-company projection data', async () => {
    const SyncBootstrap = vi.fn().mockResolvedValue({ success: true });
    const dbRead = vi.fn().mockResolvedValue({ success: true, data: { companyId: 'company-b', models: [{ id: 'wrong' }] } });
    vi.stubGlobal('window', { electronAPI: {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      SyncBootstrap,
      dbRead
    } });
    const { slice, set, state } = makeSlice();

    await slice.initStore();

    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ models: expect.anything() }));
    expect(state().addNotification).toHaveBeenCalledWith('error', '_PROJECTION_READ_FAILED', expect.any(String));
  });
});
