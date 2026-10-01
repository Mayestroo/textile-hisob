import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const {
  configureSecureWebContents,
  isAllowedAppNavigation,
  isAllowedExternalWindow
} = require('./windowSecurity.cjs');

describe('Electron window navigation boundary', () => {
  it('allows only the exact local application entry file', () => {
    const entry = path.join(os.tmpdir(), 'Novda', 'dist', 'index.html');
    const entryUrl = pathToFileURL(entry).href;

    expect(isAllowedAppNavigation(entryUrl, entry)).toBe(true);
    expect(isAllowedAppNavigation(`${entryUrl}?remote=1`, entry)).toBe(false);
    expect(isAllowedAppNavigation('https://sync.novdatextile.uz/admin-app', entry)).toBe(false);
    expect(isAllowedAppNavigation('javascript:alert(1)', entry)).toBe(false);
    expect(isAllowedAppNavigation(pathToFileURL(path.join(os.tmpdir(), 'other.html')).href, entry)).toBe(false);
  });

  it('opens only the explicitly approved Telegram support URL externally', () => {
    expect(isAllowedExternalWindow('https://t.me/mayestr0')).toBe(true);
    expect(isAllowedExternalWindow('https://t.me.evil.example/mayestr0')).toBe(false);
    expect(isAllowedExternalWindow('https://t.me/mayestr0.evil')).toBe(false);
    expect(isAllowedExternalWindow('https://user@t.me/mayestr0')).toBe(false);
    expect(isAllowedExternalWindow('http://t.me/mayestr0')).toBe(false);
  });

  it('blocks navigation, redirects, webviews, and child windows while forwarding only the allowed support link', () => {
    const listeners = new Map<string, (event: any, value?: string) => void>();
    let openHandler: ((details: { url: string }) => { action: string }) | undefined;
    const webContents = {
      on: vi.fn((event: string, listener: (event: any, value?: string) => void) => listeners.set(event, listener)),
      setWindowOpenHandler: vi.fn((handler) => { openHandler = handler; })
    };
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const entry = path.join(os.tmpdir(), 'Novda', 'dist', 'index.html');
    configureSecureWebContents(webContents, { appEntryPath: entry, openExternal });

    const navigation = { preventDefault: vi.fn() };
    listeners.get('will-navigate')!(navigation, 'https://example.org');
    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    const redirect = { preventDefault: vi.fn() };
    listeners.get('will-redirect')!(redirect, 'file:///C:/Windows/win.ini');
    expect(redirect.preventDefault).toHaveBeenCalledOnce();
    const webview = { preventDefault: vi.fn() };
    listeners.get('will-attach-webview')!(webview);
    expect(webview.preventDefault).toHaveBeenCalledOnce();

    expect(openHandler?.({ url: 'https://example.org' })).toEqual({ action: 'deny' });
    expect(openHandler?.({ url: 'https://t.me/mayestr0' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://t.me/mayestr0');
  });

  it('requires a real absolute application entry path before installing security hooks', () => {
    const webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() };
    expect(() => configureSecureWebContents(webContents, { appEntryPath: 'index.html' })).toThrow('APP_ENTRY_PATH_REQUIRED');
    expect(webContents.on).not.toHaveBeenCalled();
  });
});
