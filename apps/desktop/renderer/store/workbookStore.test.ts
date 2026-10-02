import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkbookStore } from './workbookStore';

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

    await useWorkbookStore.getState().addCustomSize('XL');

    expect(useWorkbookStore.getState().availableSizes).toEqual(['S']);
    useWorkbookStore.setState(previousState, true);
  });

  it('keeps a selected numeric size in the shared catalog and batch config', async () => {
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

    expect(useWorkbookStore.getState().availableSizes).toEqual(['S', 'M', '42']);
    expect(useWorkbookStore.getState().pattaBatchConfigs['model-a'].sizes).toMatchObject({ '42': '3' });
    useWorkbookStore.setState(previousState, true);
  });
});
