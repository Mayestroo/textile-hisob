import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelSlice } from './createModelSlice';

describe(' model mutation boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' })
      }
    });
  });

  it('fails closed without a company binding before state or persistence mutation', async () => {
    const model = {
      id: 'model-a',
      name: 'Model A',
      hisobSheetName: 'Model A-hisob',
      operations: [{ id: 'op-1', name: 'Sew', rate: 2 }],
      pattaOpsOrder: ['Sew'],
      hisobQuantities: {}
    };
    const state: any = {
      models: [model],
      ticketForms: {},
      pattaBatchConfigs: {},
      submittedTickets: [],
      printedPartyHistory: [],
      deletedModelIds: [],
      activeSheet: 'model-a',
      addNotification: vi.fn(),
      saveToDisk: vi.fn()
    };
    const set = vi.fn((next: any) => Object.assign(state, next));
    const slice = createModelSlice(set as any, (() => state) as any, {} as any);

    await slice.addModel('Model B');
    await slice.deleteModel('model-a');
    await slice.renameModel('model-a', 'Model C');
    await slice.syncNewOperation('model-a', 'Cut', 1);
    await slice.syncDeleteOperation('model-a', 'Sew');
    await slice.updateOperationRate('model-a', 'Sew', 4);
    await slice.updateOperationName('model-a', 'Sew', 'Cut');
    await slice.updateHisobQuantity('model-a', 1, 'Sew', 4);
    await slice.reorderOperations('model-a', ['Sew']);

    expect(set).not.toHaveBeenCalled();
    expect(state.saveToDisk).not.toHaveBeenCalled();
    expect(state.models).toEqual([model]);
    expect(state.addNotification).toHaveBeenCalledWith('error', '_RUNTIME_NOT_READY', expect.any(String));
  });

  it('routes model creation through the typed  command and reloads SQLite projection', async () => {
    const model = {
      id: 'Model-B', name: 'Model-B', hisobSheetName: 'Model-B-hisob', title: 'Model-B', party: '', color: 'Qora', size: 'XL',
      operations: [{ id: 'op-cut', name: 'Cut', rate: 5 }], pattaOpsOrder: ['Cut'], hisobQuantities: {}
    };
    const licenseStatus = { companyId: 'company-a' };
    const state: any = {
      licenseStatus,
      models: [], workers: [], ticketForms: {}, pattaBatchConfigs: {}, submittedTickets: [], printedPartyHistory: [],
      deletedModelIds: [], activeSheet: 'Model-B', notifications: [], addNotification: vi.fn(), saveToDisk: vi.fn()
    };
    const set = vi.fn((next: any) => Object.assign(state, next));
    const api = {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      WorkbookCommand: vi.fn().mockResolvedValue({ success: true, result: { committed: true } }),
      dbRead: vi.fn().mockImplementation(async () => {
        const created = api.WorkbookCommand.mock.calls[0][0].payload;
        return { success: true, data: { companyId: 'company-a', models: [{ ...model, id: created.id }], workers: [], printedPartyHistory: [], submittedTickets: [], periods: [] } };
      }),
      SyncReconnect: vi.fn().mockResolvedValue({ success: false })
    };
    vi.stubGlobal('window', { electronAPI: api });
    const slice = createModelSlice(set as any, (() => state) as any, {} as any);

    await slice.addModel('Model B', { templateType: 'blank' });

    const modelId = api.WorkbookCommand.mock.calls[0][0].payload.id;
    expect(modelId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(api.WorkbookCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'UpsertModel', companyId: 'company-a', entityId: modelId,
      payload: expect.objectContaining({ id: modelId, name: 'Model-B', operations: [] })
    }));
    expect(api.dbRead).toHaveBeenCalledWith('company-a');
    expect(api.SyncReconnect).toHaveBeenCalledWith('company-a');
    expect(state.models).toEqual([expect.objectContaining({ id: modelId, name: 'Model-B' })]);
    expect(state.saveToDisk).not.toHaveBeenCalled();
  });

  it('commits an operation rate only as the submitted final numeric value', async () => {
    const licenseStatus = { companyId: 'company-a' };
    const model = {
      id: 'model-a', name: 'Model A', hisobSheetName: 'Model A-hisob', title: 'Model A', party: '', color: 'Qora', size: 'XL',
      operations: [{ id: 'op-sew', name: 'Sew', rate: 10 }], pattaOpsOrder: ['Sew'], hisobQuantities: {}
    };
    const state: any = {
      licenseStatus,
      models: [model], workers: [], ticketForms: {}, pattaBatchConfigs: {}, submittedTickets: [], printedPartyHistory: [],
      deletedModelIds: [], activeSheet: 'model-a', addNotification: vi.fn(), saveToDisk: vi.fn()
    };
    const set = vi.fn((next: any) => Object.assign(state, next));
    const api = {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      WorkbookCommand: vi.fn().mockResolvedValue({ success: true, result: { committed: true } }),
      dbRead: vi.fn().mockResolvedValue({ success: true, data: {
        companyId: 'company-a', models: [{ ...model, operations: [{ id: 'op-sew', name: 'Sew', rate: 42 }] }],
        workers: [], printedPartyHistory: [], submittedTickets: [], periods: []
      } }),
      SyncReconnect: vi.fn().mockResolvedValue({ success: false })
    };
    vi.stubGlobal('window', { electronAPI: api });
    const slice = createModelSlice(set as any, (() => state) as any, {} as any);

    const saved = await slice.updateOperationRate('model-a', 'Sew', 42);

    expect(saved).toBe(true);
    expect(api.WorkbookCommand).toHaveBeenCalledTimes(1);
    expect(api.WorkbookCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'UpsertModel',
      payload: expect.objectContaining({ operations: [{ id: 'op-sew', name: 'Sew', rate: 42 }] })
    }));
    expect(state.models.find((item: any) => item.id === 'model-a').operations[0].rate).toBe(42);
  });

  it('maps  hisob edits to a production-adjustment command rather than a snapshot write', async () => {
    const model = {
      id: 'model-a', name: 'Model A', hisobSheetName: 'Model A-hisob', title: 'Model A', party: '', color: 'Qora', size: 'XL',
      operations: [{ id: 'op-cut', name: 'Cut', rate: 5 }], pattaOpsOrder: ['Cut'], hisobQuantities: { '1': { Cut: 5 } }
    };
    const licenseStatus = { companyId: 'company-a' };
    const state: any = { licenseStatus, models: [model], workers: [{ id: 1, name: 'Worker' }], addNotification: vi.fn(), saveToDisk: vi.fn() };
    const api = {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      RecordAdjustmentCommand: vi.fn().mockResolvedValue({ success: true, result: { committed: true } }),
      dbRead: vi.fn().mockResolvedValue({ success: true, data: { companyId: 'company-a', models: [{ ...model, hisobQuantities: { '1': { Cut: 8 } } }], workers: [{ id: 1, name: 'Worker' }], printedPartyHistory: [], submittedTickets: [], periods: [] } }),
      SyncReconnect: vi.fn().mockResolvedValue({ success: false })
    };
    vi.stubGlobal('window', { electronAPI: api });
    const set = vi.fn((next: any) => Object.assign(state, next));
    const slice = createModelSlice(set as any, (() => state) as any, {} as any);

    await slice.updateHisobQuantity('model-a', 1, 'Cut', 8);

    expect(api.RecordAdjustmentCommand).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-a', modelId: 'model-a', workerId: 1, opName: 'Cut', deltaQty: 3,
      reason: 'MANUAL_CORRECTION', status: 'APPROVED'
    }));
    expect('WorkbookCommand' in api).toBe(false);
    expect(api.dbRead).toHaveBeenCalledWith('company-a');
    expect(state.saveToDisk).not.toHaveBeenCalled();
  });
});
