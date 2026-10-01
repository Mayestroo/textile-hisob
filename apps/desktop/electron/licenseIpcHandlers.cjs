function registerLicenseIpcHandlers({ ipcMain, app, license, rejectRendererCompanyAssignment, rejectRendererLicenseSettings }) {
  ipcMain.handle('license-status', async () => {
    try {
      return await license.checkRemoteActivation(app.getPath('userData'));
    } catch (err) {
      return {
        isActivated: false,
        machineId: license.getHardwareId(),
        message: err.message
      };
    }
  });

  ipcMain.handle('license-activate', (event, key) => {
    try {
      return license.saveLicense(app.getPath('userData'), key);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('license-request-activation', async () => {
    try {
      return await license.requestNewActivation(app.getPath('userData'));
    } catch (err) {
      return { success: false, error: err.message || 'Activation request failed' };
    }
  });

  ipcMain.handle('license-set-company', () => rejectRendererCompanyAssignment());
  ipcMain.handle('license-set-validation', () => rejectRendererLicenseSettings());
}

module.exports = { registerLicenseIpcHandlers };
