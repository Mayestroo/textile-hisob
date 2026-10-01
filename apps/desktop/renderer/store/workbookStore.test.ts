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
});
