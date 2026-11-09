import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkbookStore } from './workbookStore';
import { preserveBatchSettingsDraft } from './businessMutations';

describe('workbook store  patta boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks protected patta mutations before the legacy slice runs', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' })
      }
    });

    const previousState = useWorkbookStore.getState();
    useWorkbookStore.setState({ availableSizes: ['S'] });

    await useWorkbookStore.getState().addCustomSize('model-a', 'XL');

    expect(useWorkbookStore.getState().availableSizes).toEqual(['S']);
    useWorkbookStore.setState(previousState, true);
  });

  it('keeps an entered numeric size in only its model definition and draft', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' })
      }
    });

    const previousState = useWorkbookStore.getState();
    useWorkbookStore.setState({
      models: [{ id: 'model-a', name: 'Model A', color: 'Qora' } as any],
      availableSizes: ['S', 'M'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '', totalIshSoni: '', color: 'Qora', sizes: {} } }
    });

    await useWorkbookStore.getState().updatePattaBatchSize('model-a', '42', '3');

    expect(useWorkbookStore.getState().availableSizes).toEqual(['S', 'M']);
    expect(useWorkbookStore.getState().pattaBatchConfigs['model-a'].sizes).toMatchObject({ '42': '3' });
    useWorkbookStore.setState(previousState, true);
  });

  it('blocks removal of a positive count and keeps add/remove scoped to the chosen model', async () => {
    vi.stubGlobal('window', {
      electronAPI: { getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'legacy' }) }
    });
    const previousState = useWorkbookStore.getState();
    const saveToDisk = vi.fn().mockResolvedValue(true);
    useWorkbookStore.setState({
      models: [{ id: 'model-a', name: 'Model A', color: 'Qora' }, { id: 'model-b', name: 'Model B', color: 'Qora' }] as any,
      availableSizes: ['S', '40-42'],
      pattaBatchConfigs: {
        'model-a': { partyNumber: '', totalIshSoni: '', color: 'Qora', sizes: { '40-42': '3', S: '2' }, sizeNames: ['S', '40-42'] },
        'model-b': { partyNumber: '', totalIshSoni: '', color: 'Qora', sizes: { S: '1' }, sizeNames: ['S'] }
      },
      saveToDisk
    } as any);

    try {
      await useWorkbookStore.getState().deleteCustomSize('model-a', '40-42');
      expect(useWorkbookStore.getState().pattaBatchConfigs['model-a'].sizeNames).toEqual(['S', '40-42']);
      expect(useWorkbookStore.getState().pattaBatchConfigs['model-b']).toMatchObject({ sizes: { S: '1' }, sizeNames: ['S'] });
      useWorkbookStore.setState((state) => ({ pattaBatchConfigs: { ...state.pattaBatchConfigs, 'model-a': { ...state.pattaBatchConfigs['model-a'], sizes: { ...state.pattaBatchConfigs['model-a'].sizes, '40-42': '0' } } } }));
      await useWorkbookStore.getState().deleteCustomSize('model-a', '40-42');
      expect(useWorkbookStore.getState().pattaBatchConfigs['model-a'].sizeNames).toEqual(['S']);
      await useWorkbookStore.getState().addCustomSize('model-a', 'XXL');
      expect(useWorkbookStore.getState().pattaBatchConfigs['model-a'].sizeNames).toEqual(['S', 'XXL']);
      expect(useWorkbookStore.getState().pattaBatchConfigs['model-b'].sizeNames).toEqual(['S']);
      expect(saveToDisk).toHaveBeenCalled();
    } finally {
      useWorkbookStore.setState(previousState, true);
    }
  });

  it('updates a size count immediately while runtime readiness is still pending', async () => {
    let resolveRuntime!: (value: any) => void;
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn(() => new Promise((resolve) => { resolveRuntime = resolve; }))
      }
    });

    const previousState = useWorkbookStore.getState();
    useWorkbookStore.setState({
      licenseStatus: { companyId: 'company-a' } as any,
      models: [{ id: 'model-a', name: 'Model A', color: 'Qora' } as any],
      availableSizes: ['S'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '', totalIshSoni: '', color: 'Qora', sizes: {} } }
    });

    const pending = useWorkbookStore.getState().updatePattaBatchSize('model-a', 'S', '12');
    expect(useWorkbookStore.getState().pattaBatchConfigs['model-a'].sizes.S).toBe('12');
    resolveRuntime({ success: true, mode: 'sync' });
    await pending;
    useWorkbookStore.setState(previousState, true);
  });

  it('preserves the latest batch input when a command reload returns an older projection', () => {
    const latestConfig = { partyNumber: '54', totalIshSoni: '100', color: 'Qora', sizes: { XXS: '' } };
    const refreshed = preserveBatchSettingsDraft({
      availableSizes: ['S'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '54', totalIshSoni: '100', color: 'Qora', sizes: { XXS: '1' } } },
      models: [{ id: 'model-a' }]
    }, {
      availableSizes: ['S', 'XXS'],
      pattaBatchConfigs: { 'model-a': latestConfig }
    });

    expect(refreshed.availableSizes).toEqual(['S', 'XXS']);
    expect(refreshed.pattaBatchConfigs['model-a'].sizes.XXS).toBe('');
    expect(refreshed.models).toEqual([{ id: 'model-a' }]);
  });
});
