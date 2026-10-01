import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerSlice } from './createWorkerSlice';

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
