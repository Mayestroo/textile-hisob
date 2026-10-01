import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getElectronApi, resolveElectronRuntimeMode } from './runtimeMode';

describe('renderer runtime mode boundary', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps browser and old Electron bridges legacy-compatible', async () => {
    expect(await resolveElectronRuntimeMode(undefined)).toEqual({ success: true, mode: 'legacy' });
    expect(await resolveElectronRuntimeMode({})).toEqual({ success: true, mode: 'legacy' });
  });

  it('fails closed instead of starting legacy Firebase sync in a production build without Electron', async () => {
    await expect(resolveElectronRuntimeMode(undefined, { productionBuild: true })).resolves.toEqual({
      success: false,
      mode: 'sync',
      error: 'The production client requires its authenticated Electron runtime bridge',
      code: 'ELECTRON_RUNTIME_REQUIRED'
    });
  });

  it('fails closed when a legacy-shaped response reports failure', async () => {
    const getRuntimeMode = vi.fn().mockResolvedValue({ mode: 'legacy', success: false });

    await expect(resolveElectronRuntimeMode({ getRuntimeMode })).resolves.toEqual(expect.objectContaining({
      success: false,
      mode: 'sync',
      code: '_RUNTIME_NOT_READY'
    }));
  });

  it('fails closed when the runtime bridge throws', async () => {
    const getRuntimeMode = vi.fn().mockRejectedValue(new Error('bridge down'));

    await expect(resolveElectronRuntimeMode({ getRuntimeMode })).resolves.toEqual({
      success: false,
      mode: 'sync',
      error: 'bridge down',
      code: '_RUNTIME_NOT_READY'
    });
  });

  it('preserves a healthy  response', async () => {
    await expect(resolveElectronRuntimeMode({
      getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync', code: 'READY' })
    })).resolves.toEqual({ success: true, mode: 'sync', code: 'READY' });
  });

  it('reads the browser Electron API without requiring it in browser mode', () => {
    expect(getElectronApi()).toBeUndefined();
    vi.stubGlobal('window', { electronAPI: { isElectron: true } });
    expect(getElectronApi()).toEqual({ isElectron: true });
  });
});
