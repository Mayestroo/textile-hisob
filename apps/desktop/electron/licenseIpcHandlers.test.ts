import { describe, expect, it, vi } from 'vitest';

const { registerLicenseIpcHandlers } = require('./licenseIpcHandlers.cjs');

describe('production license IPC handler registration', () => {
  function setup() {
    const handlers = new Map<string, (...args: any[]) => any>();
    const ipcMain = { handle: vi.fn((name: string, handler: (...args: any[]) => any) => handlers.set(name, handler)) };
    const app = { getPath: vi.fn(() => 'user-data') };
    const license = {
      checkRemoteActivation: vi.fn(),
      requestNewActivation: vi.fn(),
      getHardwareId: vi.fn(() => 'machine-a'),
      saveLicense: vi.fn()
    };
    const rejectRendererCompanyAssignment = vi.fn(() => ({ success: false, code: 'AUTHORIZATION_UNAVAILABLE' }));
    const rejectRendererLicenseSettings = vi.fn(() => ({ success: false, code: 'AUTHORIZATION_UNAVAILABLE' }));
    registerLicenseIpcHandlers({ ipcMain, app, license, rejectRendererCompanyAssignment, rejectRendererLicenseSettings });
    return { handlers, app, license, rejectRendererCompanyAssignment, rejectRendererLicenseSettings };
  }

  it('rejects renderer company and validation mutations through registered production handlers', async () => {
    const { handlers, rejectRendererCompanyAssignment, rejectRendererLicenseSettings } = setup();
    const companyResult = handlers.get('license-set-company')!(null, { companyId: 'company-b' });
    const settingsResult = handlers.get('license-set-validation')!(null, true);
    expect(companyResult).toEqual({ success: false, code: 'AUTHORIZATION_UNAVAILABLE' });
    expect(settingsResult).toEqual({ success: false, code: 'AUTHORIZATION_UNAVAILABLE' });
    expect(rejectRendererCompanyAssignment).toHaveBeenCalled();
    expect(rejectRendererLicenseSettings).toHaveBeenCalled();
  });

  it('checks remote signed activation through the main-process IPC handler', async () => {
    const { handlers, app, license } = setup();
    license.checkRemoteActivation.mockResolvedValue({ isActivated: true, companyId: 'company-a' });
    await expect(handlers.get('license-status')!(null)).resolves.toEqual({ isActivated: true, companyId: 'company-a' });
    expect(license.checkRemoteActivation).toHaveBeenCalledWith('user-data');
    expect(app.getPath).toHaveBeenCalledWith('userData');
  });

  it('requests a replacement activation only through the main-process API', async () => {
    const { handlers, app, license } = setup();
    license.requestNewActivation.mockResolvedValue({ success: true, status: { activationRequestStatus: 'PENDING' } });
    await expect(handlers.get('license-request-activation')!(null)).resolves.toMatchObject({ success: true });
    expect(license.requestNewActivation).toHaveBeenCalledWith('user-data');
    expect(app.getPath).toHaveBeenCalledWith('userData');
  });
});
