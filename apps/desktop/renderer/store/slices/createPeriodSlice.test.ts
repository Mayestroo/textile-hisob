import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPeriodSlice } from './createPeriodSlice';

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
});
