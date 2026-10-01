import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { blockUnverifiedUpdate, isAllowedUpdateUrl, resolveAllowedRedirect } from './updateSecurity.cjs';

describe('updater URL security', () => {
  it('requires HTTPS and an exact trusted host', () => {
    expect(isAllowedUpdateUrl('https://github.com/org/release.exe')).toBe(true);
    expect(isAllowedUpdateUrl('http://github.com/org/release.exe')).toBe(false);
    expect(isAllowedUpdateUrl('https://evil-github.com/release.exe')).toBe(false);
    expect(isAllowedUpdateUrl('https://trusted.example.com.evil.com/release.exe')).toBe(false);
    expect(isAllowedUpdateUrl('https://eviltrusted.example.com/release.exe')).toBe(false);
    expect(isAllowedUpdateUrl('https://untrusted-storage.example/update.exe')).toBe(false);
    expect(isAllowedUpdateUrl('https://untrusted-download.example/update.exe')).toBe(false);
  });

  it('rejects untrusted redirect destinations and accepts trusted relative redirects', () => {
    expect(resolveAllowedRedirect('https://github.com/org/a.exe', 'https://evil.example/a.exe')).toBeNull();
    expect(resolveAllowedRedirect('https://github.com/org/a.exe', 'http://github.com/b.exe')).toBeNull();
    expect(resolveAllowedRedirect('https://github.com/org/a.exe', 'https://github.com/org/b.exe')).toBe('https://github.com/org/b.exe');
    expect(resolveAllowedRedirect('https://github.com/org/a.exe', '../b.exe')).toBe('https://github.com/b.exe');
  });

  it('blocks  executable download and installation until a verified manifest exists', () => {
    expect(blockUnverifiedUpdate('sync')).toMatchObject({
      success: false,
      code: 'UPDATE_AUTHENTICITY_REQUIRED'
    });
    expect(blockUnverifiedUpdate('legacy')).toBeNull();

    const mainSource = fs.readFileSync(path.resolve(__dirname, 'main.cjs'), 'utf8');
    const downloadHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('download-app-update'"), mainSource.indexOf("ipcMain.handle('install-app-update'"));
    const installHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('install-app-update'"), mainSource.indexOf('// ==================== WINDOW ===================='));
    expect(downloadHandler).toContain('blockUnverifiedUpdate(selectedRuntimeMode)');
    expect(installHandler).toContain('blockUnverifiedUpdate(selectedRuntimeMode)');
    expect(installHandler.indexOf('blockUnverifiedUpdate')).toBeLessThan(installHandler.indexOf('child_process.spawn'));
  });
});
