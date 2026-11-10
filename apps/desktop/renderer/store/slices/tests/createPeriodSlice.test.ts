import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPeriodSlice } from '../createPeriodSlice';
import { createPattaBatchSlice } from '../createPattaBatchSlice';
declare const require: (id: string) => any;
declare const process: { cwd(): string };
const fs = require('node:fs');
const path = require('node:path');

function makeSlice() {
  const state: any = {
    currentPeriod: { id: 'period-a', name: 'Current', startDate: '2026-09-01', isClosed: false },
    periods: [],
    selectedArchiveFilename: null,
    selectedArchiveData: null,
    licenseStatus: { companyId: 'company-a' },
    models: [],
    workers: [],
    printedPartyHistory: [],
    submittedTickets: [],
    availableSizes: [],
    pattaBatchConfigs: {},
    saveToDisk: vi.fn(),
    addNotification: vi.fn()
  };
  const set = vi.fn((next: any) => Object.assign(state, next));
  const slice = createPeriodSlice(set as any, (() => state) as any, {} as any);
  return { slice, state, set };
}

describe(' period legacy-storage boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' })
      }
    });
  });

  it('fails closed without typed  bridges and does not fall back to legacy storage', async () => {
    const { slice, state, set } = makeSlice();

    await slice.startNewPeriod('Next', '2026-10-01');
    await slice.updateCurrentPeriod('Updated', '2026-10-01');
    await slice.closeCurrentPeriod('2026-09-30');
    await slice.loadArchivedPeriod('archive.json');

    expect(set).not.toHaveBeenCalled();
    expect(state.saveToDisk).not.toHaveBeenCalled();
    expect(state.addNotification).toHaveBeenCalledWith('error', '_COMMAND_REQUIRED', expect.any(String));
    expect(state.addNotification).toHaveBeenCalledWith('error', '_LEGACY_STORAGE_FORBIDDEN', expect.any(String));
  });

  it('routes period creation, update, close, and archive reads through  commands/API', async () => {
    const { slice, state, set } = makeSlice();
    const eAPI = {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
      WorkbookCommand: vi.fn().mockResolvedValue({ success: true, result: { committed: true } }),
      PeriodArchiveRead: vi.fn().mockResolvedValue({ success: true, data: { period: { id: 'period-a', name: 'Current' } } }),
      dbRead: vi.fn().mockResolvedValue({
        success: true,
        data: {
          companyId: 'company-a', models: [], workers: [], printedPartyHistory: [], submittedTickets: [],
          periods: [{ id: 'period-next', name: 'Next', startDate: '2026-10-01', isClosed: false }],
          currentPeriod: { id: 'period-next', name: 'Next', startDate: '2026-10-01', isClosed: false }
        }
      }),
      SyncReconnect: vi.fn().mockResolvedValue({ success: false })
    };
    vi.stubGlobal('window', { electronAPI: eAPI });

    await slice.startNewPeriod('Next', '2026-10-01');
    await slice.updateCurrentPeriod('Next renamed', '2026-10-02');
    await slice.closeCurrentPeriod('2026-10-31');
    await slice.loadArchivedPeriod('archive_period-next.json');

    expect(eAPI.WorkbookCommand.mock.calls.map(([command]) => command.commandType)).toEqual([
      'CreatePeriod', 'UpdatePeriod', 'ClosePeriod'
    ]);
    expect(eAPI.PeriodArchiveRead).toHaveBeenCalledWith({ companyId: 'company-a', filename: 'archive_period-next.json' });
    expect(state.saveToDisk).not.toHaveBeenCalled();
    expect(state.selectedArchiveData).toMatchObject({ period: { id: 'period-a' } });
    expect(set).toHaveBeenCalled();
  });

  it('keeps clearing the selected archive as a local UI action', async () => {
    const { slice, set } = makeSlice();

    await slice.loadArchivedPeriod(null);

    expect(set).toHaveBeenCalledWith({ selectedArchiveFilename: null, selectedArchiveData: null });
  });

  it('preserves completed parties as active across month close and archives submitted pattas', async () => {
    const { slice, state, set } = makeSlice();
    state.saveToDisk.mockResolvedValue(true);
    state.availableSizes = ['M'];
    state.models = [{ id: 'm1', name: 'Model 1', hisobQuantities: {} }];
    state.printedPartyHistory = [{
      id: 'party-1',
      partyNumber: 1,
      modelId: 'm1',
      modelName: 'Model 1',
      pattaCount: 2,
      pattaStartNumber: 1,
      pattaEndNumber: 2,
      ishSoniPerPatta: 50,
      totalIshSoni: 100,
      ishSoni: 100,
      sizes: { M: '2' },
      printedAt: '2026-09-01T10:00:00.000Z',
      archivedPattaNumbers: [],
      isClosed: false
    }];
    state.submittedTickets = [
      { id: 't1', partyRecordId: 'party-1', pattaNumber: 1, size: 'M', quantity: 50, workerId: 'w1', submittedAt: '2026-09-02T10:00:00.000Z' },
      { id: 't2', partyRecordId: 'party-1', pattaNumber: 2, size: 'M', quantity: 50, workerId: 'w2', submittedAt: '2026-09-03T10:00:00.000Z' }
    ];

    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'legacy' }),
        archiveSave: vi.fn().mockResolvedValue(true)
      }
    });

    const success = await slice.closeCurrentPeriod('2026-09-30');

    expect(success).toBe(true);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      printedPartyHistory: [
        expect.objectContaining({
          id: 'party-1',
          partyNumber: 1,
          isClosed: true,
          archivedPattaNumbers: [1, 2]
        })
      ],
      submittedTickets: []
    }));
    expect(state.addNotification).toHaveBeenCalledWith(
      'success',
      'Davr muvaffaqiyatli arxivlandi',
      expect.stringContaining('uzluksiz davom etadi')
    );
  });

  it('file-mode close then finish saves and reopens paired lifecycle proof without ending open carry', async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.opencode/deep-audit/output/local-test-db/patta-file-close-'));
    const file = path.join(root, 'workbook.json');
    try {
      const { slice, state, set } = makeSlice();
      state.saveToDisk = vi.fn(async (changes: any) => {
        fs.writeFileSync(file, JSON.stringify({ ...state, ...changes }));
        return true;
      });
      state.availableSizes = ['M'];
      state.printedPartyHistory = [
        { id: 'A', partyNumber: 1, modelId: 'm1', pattaCount: 2, pattaStartNumber: 1, pattaEndNumber: 2,
          ishSoniPerPatta: 10, totalIshSoni: 20, sizes: { M: '2' }, archivedPattaNumbers: [], isClosed: false },
        { id: 'B', partyNumber: 2, modelId: 'm1', pattaCount: 1, pattaStartNumber: 3, pattaEndNumber: 3,
          ishSoniPerPatta: 7, totalIshSoni: 7, sizes: { M: '1' }, archivedPattaNumbers: [], isClosed: false }
      ];
      state.submittedTickets = [
        { id: 'A1', partyRecordId: 'A', pattaNumber: 1, size: 'M', qty: 10, status: 'CONFIRMED', submittedAt: '2026-09-02' },
        { id: 'B1', partyRecordId: 'B', pattaNumber: 3, size: 'M', qty: 7, status: 'CONFIRMED', submittedAt: '2026-09-02' }
      ];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      vi.stubGlobal('window', { electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'legacy' }),
        archiveSave: vi.fn(async (filename: string, data: unknown) => {
          fs.writeFileSync(path.join(root, filename), JSON.stringify(data));
          return { success: true };
        })
      } });

      expect(await slice.closeCurrentPeriod('2026-09-30')).toBe(true);
      const afterClose = JSON.parse(fs.readFileSync(file, 'utf8'));
      const periodProof = afterClose.periods.find((period: any) => period.id === 'period-a');
      expect(periodProof).toMatchObject({ isClosed: true, closeOperationId: expect.any(String) });
      expect(afterClose.printedPartyHistory.find((party: any) => party.id === 'B'))
        .toMatchObject({ isClosed: true, monthClosedPeriodId: 'period-a' });
      expect(afterClose.printedPartyHistory.find((party: any) => party.id === 'A'))
        .toMatchObject({ isClosed: false, archivedPattaNumbers: [1] });

      Object.assign(state, afterClose);
      const batchSlice = createPattaBatchSlice(set as any, (() => state) as any, {} as any);
      await batchSlice.completePartySeries();
      const afterFinish = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(afterFinish.printedPartyHistory.find((party: any) => party.id === 'B'))
        .toMatchObject({ endedOperationId: expect.any(String), monthClosedPeriodId: 'period-a' });
      const carriedA = afterFinish.printedPartyHistory.find((party: any) => party.id === 'A');
      expect(carriedA.endedOperationId).toEqual(expect.any(String));
      expect(carriedA).not.toHaveProperty('monthClosedPeriodId');
      expect(afterFinish.periods.find((period: any) => period.id === 'period-a').closeOperationId)
        .toBe(periodProof.closeOperationId);
      expect(state.addNotification).toHaveBeenCalledWith('success', 'Partiya yakunlandi', expect.any(String));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('failed file close/finish saves leave proof unpublished and preserve current state', async () => {
    const { slice, state, set } = makeSlice();
    state.saveToDisk = vi.fn().mockResolvedValue(false);
    state.availableSizes = ['M'];
    state.printedPartyHistory = [{ id: 'B', partyNumber: 2, modelId: 'm1', pattaCount: 1, pattaStartNumber: 3,
      pattaEndNumber: 3, sizes: { M: '1' }, archivedPattaNumbers: [], isClosed: false, userNote: 'keep me' }];
    state.submittedTickets = [{ id: 'B1', partyRecordId: 'B', pattaNumber: 3, size: 'M', qty: 7, status: 'CONFIRMED' }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.stubGlobal('window', { electronAPI: {
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'legacy' }),
      archiveSave: vi.fn().mockResolvedValue({ success: true })
    } });
    expect(await slice.closeCurrentPeriod('2026-09-30')).toBe(false);
    expect(state.currentPeriod.id).toBe('period-a');
    expect(state.printedPartyHistory[0]).toMatchObject({ isClosed: false, userNote: 'keep me' });
    expect(set).not.toHaveBeenCalled();

    state.periods = [{ id: 'P', isClosed: true, closeOperationId: 'closeP' }];
    state.printedPartyHistory = [{ ...state.printedPartyHistory[0], isClosed: true, monthClosedPeriodId: 'P' }];
    const before = structuredClone(state.printedPartyHistory);
    const batchSlice = createPattaBatchSlice(set as any, (() => state) as any, {} as any);
    await batchSlice.completePartySeries();
    expect(state.printedPartyHistory).toEqual(before);
    expect(set).not.toHaveBeenCalled();
    expect(state.addNotification).not.toHaveBeenCalledWith('success', 'Partiya yakunlandi', expect.any(String));
  });
});
