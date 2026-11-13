import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerSlice } from '../createWorkerSlice';
import { useAuthStore } from '../../authStore';

describe(' worker mutation boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' })
      }
    });
  });

  it('fails closed without a company binding before state or persistence mutation', async () => {
    const state: any = {
      workers: [{ id: 1, name: 'Worker A' }],
      deletedWorkerIds: [],
      submittedTickets: [],
      addNotification: vi.fn(),
      saveToDisk: vi.fn()
    };
    const set = vi.fn((next: any) => Object.assign(state, next));
    const slice = createWorkerSlice(set as any, (() => state) as any, {} as any);

    await slice.updateWorker(1, { name: 'Changed' });
    await slice.addWorker('Worker B');
    await slice.deleteWorker(1);

    expect(set).not.toHaveBeenCalled();
    expect(state.saveToDisk).not.toHaveBeenCalled();
    expect(state.workers).toEqual([{ id: 1, name: 'Worker A' }]);
    expect(state.addNotification).toHaveBeenCalledTimes(3);
    expect(state.addNotification).toHaveBeenCalledWith('error', '_RUNTIME_NOT_READY', expect.any(String));
  });

  it('routes worker profile and balance updates through the typed  command', async () => {
    const licenseStatus = { companyId: 'company-a' };
    const state: any = {
      licenseStatus,
      workers: [{ id: 1, name: 'Worker A', staj: 2, avans: 10, jarima: 5 }],
      periods: [{ id: 'period-current', name: 'Current', startDate: '2026-09-01', isClosed: false }],
      deletedWorkerIds: [], submittedTickets: [], addNotification: vi.fn(), saveToDisk: vi.fn()
    };
    const set = vi.fn((next: any) => Object.assign(state, next));
    const api = {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      WorkbookCommand: vi.fn().mockResolvedValue({ success: true, result: { committed: true } }),
      dbRead: vi.fn().mockResolvedValue({ success: true, data: { companyId: 'company-a', models: [], workers: [{ id: 1, name: 'Worker A2', staj: 3, avans: 20, jarima: 5 }], printedPartyHistory: [], submittedTickets: [], periods: state.periods } }),
      SyncReconnect: vi.fn().mockResolvedValue({ success: false })
    };
    vi.stubGlobal('window', { electronAPI: api });
    const slice = createWorkerSlice(set as any, (() => state) as any, {} as any);

    await slice.updateWorker(1, { name: 'Worker A2', staj: 3, avans: 20 }, { immediate: true });

    expect(api.WorkbookCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'UpsertWorker', companyId: 'company-a', entityId: '1',
      payload: expect.objectContaining({
        workerId: 1,
        name: 'Worker A2',
        staj: 3,
        balanceAdjustments: [expect.objectContaining({ type: 'AVANS', amountDelta: 10, periodId: 'period-current' })]
      })
    }));
    expect(api.dbRead).toHaveBeenCalledWith('company-a');
    expect(api.SyncReconnect).toHaveBeenCalledWith('company-a');
    expect(state.saveToDisk).not.toHaveBeenCalled();
  });

  it('uses persisted selected-period balances for safe Oklad/Magazin deltas and requires payroll permissions', async () => {
    useAuthStore.setState({ companyId: 'company-a', permissions: ['edit:workers', 'edit:avans'] as any });
    const licenseStatus = { companyId: 'company-a' };
    const currentPeriod = { id: 'period-current', name: 'Current', startDate: '2026-09-01', isClosed: false };
    const state: any = {
      licenseStatus, currentPeriod, workers: [{ id: 1, name: 'Worker', oklad: 1, magazin: 1 }],
      periods: [currentPeriod], addNotification: vi.fn(), saveToDisk: vi.fn(),
      payrollValuation: { companyId: 'company-a', period: { periodId: 'period-current' }, workers: [] }
    };
    const api = {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      WorkbookCommand: vi.fn().mockResolvedValue({ success: true, result: { committed: true } }),
      dbRead: vi.fn().mockResolvedValue({ success: true, data: {
        companyId: 'company-a', currentPeriod,
        workers: [{ id: 1, name: 'Worker', staj: 0, avans: 0, jarima: 0, oklad: 500000, magazin: 40000 }],
        periods: [currentPeriod],
        payrollValuation: { companyId: 'company-a', period: { periodId: 'period-current' },
          workers: [{ workerId: 1, accountingReasons: [] }] }
      } }),
      SyncReconnect: vi.fn().mockResolvedValue({ success: false })
    };
    vi.stubGlobal('window', { electronAPI: api });
    const set = vi.fn((next: any) => Object.assign(state, next));
    const slice = createWorkerSlice(set as any, (() => state) as any, {} as any);
    expect(await slice.updateWorker(1, { oklad: 2000000, magazin: 100000 })).toBe(true);
    const [command] = api.WorkbookCommand.mock.calls[0];
    expect(command.payload.balanceAdjustments).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'OKLAD', amountDelta: 1500000, periodId: 'period-current' }),
      expect.objectContaining({ type: 'MAGAZIN', amountDelta: 60000, periodId: 'period-current' })
    ]));
    expect(api.dbRead).toHaveBeenCalledWith('company-a');
    expect(state.saveToDisk).not.toHaveBeenCalled();

    useAuthStore.setState({ permissions: [] as any });
    api.WorkbookCommand.mockClear();
    expect(await slice.updateWorker(1, { oklad: 3000000 })).toBe(false);
    expect(api.WorkbookCommand).not.toHaveBeenCalled();
    expect(state.addNotification).toHaveBeenCalledWith('error', 'FORBIDDEN', expect.any(String));
  });

  it('rejects invalid manual money and legacy-only persistence without clamping', async () => {
    useAuthStore.setState({ companyId: 'company-a', permissions: ['edit:workers', 'edit:avans'] as any });
    const licenseStatus = { companyId: 'company-a' };
    const currentPeriod = { id: 'period-current', name: 'Current', startDate: '2026-09-01', isClosed: false };
    const state: any = { licenseStatus, currentPeriod, workers: [{ id: 1, name: 'Worker' }], periods: [currentPeriod],
      addNotification: vi.fn(), saveToDisk: vi.fn() };
    const api = { getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'legacy' }),
      WorkbookCommand: vi.fn(), dbRead: vi.fn(), SyncReconnect: vi.fn() };
    vi.stubGlobal('window', { electronAPI: api });
    const set = vi.fn((next: any) => Object.assign(state, next));
    const slice = createWorkerSlice(set as any, (() => state) as any, {} as any);
    expect(await slice.updateWorker(1, { oklad: -1 })).toBe(false);
    expect(await slice.updateWorker(1, { magazin: 10.5 })).toBe(false);
    expect(await slice.updateWorker(1, { oklad: 100 })).toBe(false);
    expect(api.WorkbookCommand).not.toHaveBeenCalled();
    expect(state.saveToDisk).not.toHaveBeenCalled();
  });

  it('does not create an outbox command or reconnect for unchanged normalized worker values', async () => {
    const state: any = { licenseStatus: { companyId: 'company-a' },
      workers: [{ id: 1, name: 'Worker', staj: 0, avans: 1000, jarima: 0 }],
      addNotification: vi.fn(), saveToDisk: vi.fn() };
    const api = { getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      WorkbookCommand: vi.fn(), SyncReconnect: vi.fn() };
    vi.stubGlobal('window', { electronAPI: api });
    const set = vi.fn();
    const slice = createWorkerSlice(set as any, (() => state) as any, {} as any);
    for (const updates of [{ avans: 1000 }, { jarima: 0 }, { name: '  Worker  ' }, { staj: 0 }, {}]) {
      expect(await slice.updateWorker(1, updates)).toBe(true);
    }
    expect(api.WorkbookCommand).not.toHaveBeenCalled();
    expect(api.SyncReconnect).not.toHaveBeenCalled();
    expect(state.saveToDisk).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('queues a worker create without a client worker ID even when deletedWorkerIds is populated', async () => {
    const licenseStatus = { companyId: 'company-a' };
    const state: any = {
      licenseStatus,
      workers: [{ id: 199, name: 'Existing Worker', staj: 0, avans: 0, jarima: 0 }],
      deletedWorkerIds: Array.from({ length: 201 }, (_, index) => index + 200),
      submittedTickets: [],
      periods: [],
      addNotification: vi.fn(),
      saveToDisk: vi.fn()
    };
    const set = vi.fn((next: any) => Object.assign(state, next));
    const api = {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      WorkbookCommand: vi.fn().mockResolvedValue({ success: true, result: { status: 'PENDING_SYNC' } }),
      dbRead: vi.fn().mockResolvedValue({ success: true, data: { companyId: 'company-a', workers: state.workers, models: [], printedPartyHistory: [], submittedTickets: [], periods: [] } }),
      SyncReconnect: vi.fn().mockResolvedValue({ success: false })
    };
    vi.stubGlobal('window', { electronAPI: api });
    const slice = createWorkerSlice(set as any, (() => state) as any, {} as any);

    expect(await slice.addWorker('New Worker')).toBe(true);

    const [command] = api.WorkbookCommand.mock.calls[0];
    expect(command).toMatchObject({ commandType: 'CreateWorker', companyId: 'company-a' });
    expect(command.entityId).toBe(`pending-worker:${command.payload.requestId}`);
    expect(command.payload.workerId).toBeUndefined();
    expect(command.payload.id).toBeUndefined();
    expect(command.payload.deletedWorkerIds).toBeUndefined();
    expect(command.operationId).not.toBe(command.payload.requestId);
    expect(command.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(state.saveToDisk).not.toHaveBeenCalled();
  });
});
