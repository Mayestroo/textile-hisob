import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkbookStore } from './workbookStore';
import { useAuthStore } from './authStore';
import { buildPartyWorkSummary } from '../domain/pattaQuantity';

describe(' workbook batch command routing', () => {
  const model = {
    id: 'model-a', name: 'Model A', hisobSheetName: 'Model A-hisob', title: 'Model A', party: '', color: 'Qora', size: 'XL',
    operations: [{ id: 'op-cut', name: 'Cut', rate: 5 }], pattaOpsOrder: ['Cut'], hisobQuantities: {}, serverRevision: 0
  };
  const licenseStatus = { companyId: 'company-a', isActivated: true, machineId: 'machine-a' } as any;
  const party = {
    id: 'party-50', partyNumber: '50', modelId: 'model-a', modelName: 'Model A', color: 'Qora',
    pattaCount: 2, cumulativePattaCount: 2, ishSoniPerPatta: 100, totalIshSoni: 200,
    ishSoni: 200, cumulativeIshSoni: 200, sizes: { M: 2 },
    printedAt: '2026-09-29T10:00:00.000Z', isClosed: false, isArchived: false, serverRevision: 1
  };

  const installApi = (printedPartyHistory: any[] = [party], submittedTickets: any[] = []) => {
    const api = {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      WorkbookCommand: vi.fn().mockResolvedValue({ success: true, result: { committed: true } }),
      dbRead: vi.fn().mockResolvedValue({ success: true, data: {
        companyId: 'company-a', workers: [], models: [model], availableSizes: ['M', 'L'],
        pattaBatchConfigs: {}, printedPartyHistory, submittedTickets, periods: [], nextPartyNumber: 51
      } }),
      SyncReconnect: vi.fn().mockResolvedValue({ success: false })
    };
    vi.stubGlobal('window', { electronAPI: api });
    return api;
  };

  beforeEach(() => {
    useAuthStore.setState({ companyId: 'company-a' } as any);
    useWorkbookStore.setState({
      licenseStatus,
      workers: [],
      models: [model],
      availableSizes: ['M', 'L'],
      nextPartyNumber: 1,
      pattaBatchConfigs: { 'model-a': { partyNumber: '1', isCustomParty: false, totalIshSoni: '972', color: 'Qora', sizes: { M: '9', L: '' } } },
      printedPartyHistory: [],
      submittedTickets: [],
      deletedPartyIds: [],
      addNotification: vi.fn(),
      saveToDisk: vi.fn().mockResolvedValue(true)
    } as any);
  });

  it('submits a completed batch through the canonical  command and reloads SQLite state', async () => {
    const party = {
      id: 'party-new', partyNumber: '1', modelId: 'model-a', modelName: 'Model A', color: 'Qora',
      pattaCount: 9, cumulativePattaCount: 9, ...buildPartyWorkSummary(972, 9),
      cumulativeIshSoni: 972, sizes: { M: 9 }, printedAt: '2026-09-23T10:00:00.000Z', isClosed: false, serverRevision: 1
    };
    const api = {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      WorkbookCommand: vi.fn().mockResolvedValue({ success: true, result: { committed: true } }),
      dbRead: vi.fn().mockResolvedValue({ success: true, data: {
        companyId: 'company-a', workers: [], models: [model], availableSizes: ['M', 'L'],
        pattaBatchConfigs: { 'model-a': { partyNumber: '', totalIshSoni: '', sizes: { M: '', L: '' } } },
        printedPartyHistory: [party], submittedTickets: [], periods: [], nextPartyNumber: 2
      } }),
      SyncReconnect: vi.fn().mockResolvedValue({ success: false })
    };
    vi.stubGlobal('window', { electronAPI: api });

    await useWorkbookStore.getState().batchPrintCompleted([{
      modelId: 'model-a', partyNumber: '1', pattaCount: 9,
      ...buildPartyWorkSummary(972, 9), sizes: { M: '9', L: '' }, color: 'Qora'
    }]);

    expect(api.WorkbookCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'CompletePattaBatch',
      companyId: 'company-a',
      payload: expect.objectContaining({
        batchId: expect.stringMatching(/^batch_/),
        parties: [expect.objectContaining({
          id: expect.any(String), partyNumber: '1', modelId: 'model-a', pattaCount: 9,
          ishSoniPerPatta: 108, totalIshSoni: 972, ishSoni: 972, cumulativeIshSoni: 972,
          sizes: { M: 9, L: 0 }
        })],
        availableSizes: ['M', 'L'],
        configs: [expect.objectContaining({ modelId: 'model-a', sizes: { M: '', L: '' } })]
      })
    }));
    expect(api.dbRead).toHaveBeenCalledWith('company-a');
    expect(api.SyncReconnect).toHaveBeenCalledWith('company-a');
    expect(useWorkbookStore.getState().printedPartyHistory).toMatchObject([expect.objectContaining({ id: 'party-new', partyNumber: '1' })]);
    expect(useWorkbookStore.getState().saveToDisk).not.toHaveBeenCalled();
  });

  it('archives a party through the canonical  command without saving to legacy disk', async () => {
    const api = installApi([{ ...party, isClosed: true, isArchived: true }]);
    await useWorkbookStore.getState().deletePrintedPartyRecord('party-50');

    expect(api.WorkbookCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'ArchivePartyHistory',
      companyId: 'company-a',
      entityId: 'company-a',
      payload: expect.objectContaining({ partyRecordIds: ['party-50'] })
    }));
    expect(api.dbRead).toHaveBeenCalledWith('company-a');
    expect(useWorkbookStore.getState().saveToDisk).not.toHaveBeenCalled();
  });

  it('confirms actual party quantities through UpdateParty in ', async () => {
    const api = installApi([party], [
      { id: 'ticket-1', modelId: 'model-a', partyNumber: '50', qty: 60 },
      { id: 'ticket-2', modelId: 'model-a', partyNumber: '50', qty: 50 }
    ]);
    useWorkbookStore.setState({ printedPartyHistory: [party], submittedTickets: [
      { id: 'ticket-1', modelId: 'model-a', partyNumber: '50', qty: 60 },
      { id: 'ticket-2', modelId: 'model-a', partyNumber: '50', qty: 50 }
    ] } as any);

    await useWorkbookStore.getState().confirmPartyActualQuantities('party-50');

    expect(api.WorkbookCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'UpdateParty',
      companyId: 'company-a',
      entityId: 'party-50',
      payload: expect.objectContaining({
        partyRecordId: 'party-50', totalIshSoni: 110, ishSoni: 110, ishSoniPerPatta: 55
      })
    }));
    expect(useWorkbookStore.getState().saveToDisk).not.toHaveBeenCalled();
  });

  it.each(['2e1', '1.5', '-1', 'not-a-count', '9007199254740992'])(
    'rejects invalid party size count %s before submitting the  command',
    async (sizeCount) => {
      const addNotification = vi.fn();
      const WorkbookCommand = vi.fn();
      useWorkbookStore.setState({ addNotification } as any);
      vi.stubGlobal('window', {
        electronAPI: {
          getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
          WorkbookCommand
        }
      });

      await useWorkbookStore.getState().batchPrintCompleted([{
        modelId: 'model-a', partyNumber: '1', pattaCount: 9,
        ...buildPartyWorkSummary(972, 9), sizes: { M: sizeCount }, color: 'Qora'
      }]);

      expect(WorkbookCommand).not.toHaveBeenCalled();
      expect(addNotification).toHaveBeenCalledWith(
        'error',
        '_BATCH_INVALID',
        expect.stringContaining('INVALID_PATTA_SIZE_COUNT')
      );
    }
  );
});
