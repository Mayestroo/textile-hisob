const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getRuntimeMode: () => ipcRenderer.invoke('get-runtime-mode'),
  dbRead: (companyId) => ipcRenderer.invoke('db-read', companyId),
  dbWrite: (data, options) => ipcRenderer.invoke('db-write', data, options),
  dbPatch: (patches, options) => ipcRenderer.invoke('db-patch', patches, options),
  archivesList: (companyId) => ipcRenderer.invoke('archives-list', companyId),
  archivesListMeta: (companyId) => ipcRenderer.invoke('archives-list-meta', companyId),
  archiveSave: (filename, data, companyId) => ipcRenderer.invoke('archive-save', { filename, data, companyId }),
  archiveRead: (filename, companyId) => ipcRenderer.invoke('archive-read', { filename, companyId }),
  backupsList: (companyId) => ipcRenderer.invoke('backups-list', companyId),
  backupRead: (filename, companyId) => ipcRenderer.invoke('backup-read', { filename, companyId }),
  backupRestore: (filename, companyId) => ipcRenderer.invoke('backup-restore', { filename, companyId }),
  getLicenseStatus: () => ipcRenderer.invoke('license-status'),
  activateLicense: (key) => ipcRenderer.invoke('license-activate', key),
  requestActivation: () => ipcRenderer.invoke('license-request-activation'),
  setLicenseCompany: (companyId, companyName) => ipcRenderer.invoke('license-set-company', { companyId, companyName }),
  setLicenseValidation: (requireTicketValidation) => ipcRenderer.invoke('license-set-validation', requireTicketValidation),
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  printHtml: (options) => ipcRenderer.invoke('print-html', options),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  downloadAppUpdate: (options) => ipcRenderer.invoke('download-app-update', options),
  installAppUpdate: (options) => ipcRenderer.invoke('install-app-update', options),
  onUpdateProgress: (callback) => {
    const handler = (event, progress) => callback(progress);
    ipcRenderer.on('app-update-progress', handler);
    return () => ipcRenderer.removeListener('app-update-progress', handler);
  },
  //  Migration verification IPC (domain-limited, strictly no generic SQL)
  MigrationStatus: (companyId) => ipcRenderer.invoke('migration-status', companyId),
  MigrationVerify: (companyId) => ipcRenderer.invoke('migration-verify', companyId),
  MigrationRun: (companyId) => ipcRenderer.invoke('migration-run', companyId),
  //  Local Command Pipeline & Outbox IPC
  SubmitTicketCommand: (command) => ipcRenderer.invoke('command-submit-ticket', command),
  RecordAdjustmentCommand: (command) => ipcRenderer.invoke('command-record-adjustment', command),
  ReverseAdjustmentCommand: (command) => ipcRenderer.invoke('command-reverse-adjustment', command),
  ResolveReconciliationCandidate: (command) => ipcRenderer.invoke('command-resolve-reconciliation', command),
  WorkbookCommand: (command) => ipcRenderer.invoke('workbook-command', command),
  TicketDraftSave: (args) => ipcRenderer.invoke('ticket-draft-save', args),
  OutboxDiagnostics: (companyId) => ipcRenderer.invoke('outbox-diagnostics', companyId),
  OutboxPending: (options) => ipcRenderer.invoke('outbox-pending', options),
  RebuildProjections: (companyId) => ipcRenderer.invoke('rebuild-projections', companyId),
  //  Distributed Sync & Leases IPC
  SyncBootstrap: (companyId) => ipcRenderer.invoke('sync-bootstrap', companyId),
  SyncDispatch: (companyId) => ipcRenderer.invoke('sync-dispatch', companyId),
  SyncPull: (companyId) => ipcRenderer.invoke('sync-pull', companyId),
  SyncReconnect: (companyId) => ipcRenderer.invoke('sync-reconnect', companyId),
  PeriodArchiveRead: (args) => ipcRenderer.invoke('period-archive-read', args),
  OperatorLogin: (companyId, operatorId, password) => ipcRenderer.invoke('operator-login', { companyId, operatorId, password }),
  OperatorRevoke: (companyId) => ipcRenderer.invoke('operator-revoke', companyId),
  LeaseAcquire: (companyId, blockSize) => ipcRenderer.invoke('lease-acquire', { companyId, blockSize }),
  LeaseConsume: (companyId) => ipcRenderer.invoke('lease-consume', companyId),
  isElectron: true
});
