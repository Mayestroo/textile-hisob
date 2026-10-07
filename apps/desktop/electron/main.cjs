const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const child_process = require('child_process');
const license = require('./license.cjs');
const { isAllowedUpdateUrl, resolveAllowedRedirect, blockUnverifiedUpdate } = require('./updateSecurity.cjs');
const { configureSecureWebContents } = require('./windowSecurity.cjs');
const { isValidCompanyId, validateRequestedCompanyId } = require('./companyAuthority.cjs');
const { rejectRendererCompanyAssignment, rejectRendererLicenseSettings } = require('./licenseBoundary.cjs');
const { registerLicenseIpcHandlers } = require('./licenseIpcHandlers.cjs');
const { resolveApiBaseUrl } = require('./apiConfig.cjs');
const databaseManager = require('./database/databaseManager.cjs');
const migrator = require('./database/migrator.cjs');
const parityReporter = require('./database/parityReporter.cjs');
const commandPipeline = require('./database/commandPipeline.cjs');
const workbookCommandPipeline = require('./database/workbookCommandPipeline.cjs');
const outboxManager = require('./database/outboxManager.cjs');
const {
  loadWorkbookProjectionFromSqlite,
  rebuildCompanyProjections
} = require('./database/projectionReader.cjs');
const { storeOperatorSession, readOperatorSession, deleteOperatorSession } = require('./security/operatorSessionStore.cjs');
const { readDeviceCredential } = require('./security/deviceCredentialStore.cjs');
const {
  resolveRuntimeMode,
  canOpenActivationUi,
  assertReadiness,
  loadDefaultDependencies,
  createReadinessError
} = require('./runtimeMode.cjs');

let mainWindow;
const selectedRuntimeMode = resolveRuntimeMode(process.env, { packaged: app.isPackaged === true });

// ==================== SINGLE INSTANCE LOCK ====================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // If another instance is already running, quit immediately
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // If user attempted to launch a second instance, focus and restore our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);
}

// ==================== DATA LAYER ====================
function getDataDir() {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'NovdaData');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function getActiveCompanyId() {
  try {
    const lic = license.checkLicenseStatus(app.getPath('userData'));
    return isValidCompanyId(lic?.companyId) ? lic.companyId : null;
  } catch {
    return null;
  }
}

function assertRuntimeReady(targetCompanyId, options = {}) {
  if (selectedRuntimeMode !== 'sync') {
    throw createReadinessError(
      '_MODE_REQUIRED',
      'The  runtime is not enabled; no legacy fallback is allowed for this handler'
    );
  }

  const userData = app.getPath('userData');
  let licenseStatus;
  try {
    licenseStatus = license.checkLicenseStatus(userData);
  } catch (error) {
    throw createReadinessError(
      'LICENSE_STATUS_UNAVAILABLE',
      error?.message || 'The license status could not be read'
    );
  }

  const companyId = targetCompanyId || licenseStatus?.companyId;
  let db = null;
  let databaseError = null;
  let deviceCredential = null;
  let deviceCredentialError = null;

  if (isValidCompanyId(companyId)) {
    try {
      db = databaseManager.getCompanyDatabase(userData, companyId);
    } catch (error) {
      databaseError = error;
    }
    try {
      deviceCredential = readDeviceCredential(companyId);
    } catch (error) {
      deviceCredentialError = error;
    }
  }

  const readiness = assertReadiness({
    companyId,
    licenseStatus,
    db,
    deviceCredential,
    deviceCredentialError,
    databaseError,
    syncServerUrl: resolveApiBaseUrl({ allowHttp: !app.isPackaged }),
    dependencies: loadDefaultDependencies()
  });

  let bootstrapState;
  try {
    bootstrapState = require('./sync/bootstrapApplier.cjs').getBootstrapState(db, companyId);
  } catch (error) {
    throw createReadinessError(
      error?.code || '_BOOTSTRAP_STATE_INVALID',
      error?.message || 'The local authoritative bootstrap state is invalid'
    );
  }
  if (options.allowUnbootstrapped !== true && bootstrapState.status !== 'COMPLETE') {
    throw createReadinessError(
      '_BOOTSTRAP_REQUIRED',
      'The PostgreSQL authoritative bootstrap must complete before  business data is used'
    );
  }

  return { ...readiness, db, licenseStatus, bootstrapState };
}

function ErrorResponse(error, fallbackCode = '_READINESS_FAILED') {
  return {
    success: false,
    error: error?.message || ' operation rejected',
    code: error?.code || fallbackCode,
    details: error?.details || null
  };
}

function JsonWriteForbidden() {
  return {
    success: false,
    error: '_JSON_WRITE_FORBIDDEN: JSON snapshot writes are not available in  mode',
    code: '_JSON_WRITE_FORBIDDEN'
  };
}

function LegacyStorageForbidden() {
  return {
    success: false,
    error: '_LEGACY_STORAGE_FORBIDDEN: archive and backup JSON storage is unavailable in  mode',
    code: '_LEGACY_STORAGE_FORBIDDEN'
  };
}

function validateTargetCompanyId(companyId) {
  return validateRequestedCompanyId(companyId, getActiveCompanyId());
}

function getCompanyDbPath(companyId) {
  const compId = companyId || getActiveCompanyId();
  const safeCompId = (compId || 'company_main').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getDataDir(), `hisob_database_${safeCompId}.json`);
}

function getBackupsDir(companyId) {
  const compId = companyId || getActiveCompanyId();
  const safeCompId = compId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(getDataDir(), 'backups', safeCompId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getArchivesDir(companyId) {
  const compId = companyId || getActiveCompanyId();
  const safeCompId = compId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(getDataDir(), 'archives', safeCompId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLocalTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function readDb(companyId) {
  const compId = companyId || getActiveCompanyId();
  const p = getCompanyDbPath(compId);
  
  if (!fs.existsSync(p)) {
    // Migration fallback: if company specific db doesn't exist, check legacy hisob_database.json
    const legacyPath = path.join(getDataDir(), 'hisob_database.json');
    if (fs.existsSync(legacyPath)) {
      try {
        const legacyData = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        // Only allow legacy data if it matches company_main or matches the current company
        if (compId === 'company_main' || !legacyData.companyId || legacyData.companyId === compId) {
          return legacyData;
        }
      } catch {}
    }
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// Serialized per-company write queues to prevent read-modify-write races
const companyWriteQueues = new Map();

function enqueueCompanyWrite(companyId, task) {
  const safeCompId = companyId || 'company_main';
  const currentPromise = companyWriteQueues.get(safeCompId) || Promise.resolve();
  const nextPromise = currentPromise
    .catch(() => {})
    .then(() => task());
  companyWriteQueues.set(safeCompId, nextPromise);
  return nextPromise;
}

async function writeDbAsync(data, companyId) {
  const compId = companyId || data?.companyId || getActiveCompanyId();
  if (data && typeof data === 'object') {
    data.companyId = compId;
  }
  const p = getCompanyDbPath(compId);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${p}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const json = JSON.stringify(data);
  await fs.promises.writeFile(tempPath, json, 'utf-8');

  try {
    await fs.promises.rename(tempPath, p);
  } catch (renameErr) {
    if (renameErr.code === 'EEXIST' || renameErr.code === 'EPERM') {
      try {
        await fs.promises.unlink(p);
      } catch {}
      await fs.promises.rename(tempPath, p);
    } else {
      try { await fs.promises.unlink(tempPath); } catch {}
      throw renameErr;
    }
  }
}

const companyBackupTimes = new Map();
async function maybeCreateBackup(data, force = false, companyId) {
  const compId = companyId || data?.companyId || getActiveCompanyId();
  const now = Date.now();
  const lastTime = companyBackupTimes.get(compId) || 0;
  if (!force && (now - lastTime < 3 * 60 * 1000)) {
    return;
  }
  companyBackupTimes.set(compId, now);
  try {
    const compBackupDir = getBackupsDir(compId);
    if (!fs.existsSync(compBackupDir)) {
      fs.mkdirSync(compBackupDir, { recursive: true });
    }
    const ts = getLocalTimestamp();
    const nonce = Math.random().toString(36).slice(2, 6);
    const backupPath = path.join(compBackupDir, `backup_${ts}_${nonce}.json`);
    const tempBackupPath = `${backupPath}.tmp`;
    await fs.promises.writeFile(tempBackupPath, JSON.stringify(data), 'utf-8');
    await fs.promises.rename(tempBackupPath, backupPath);

    // Asynchronously prune older backups (keep last 30) without blocking
    setImmediate(async () => {
      try {
        const files = (await fs.promises.readdir(compBackupDir)).filter(f => f.endsWith('.json')).sort();
        if (files.length > 30) {
          for (const f of files.slice(0, files.length - 30)) {
            try { await fs.promises.unlink(path.join(compBackupDir, f)); } catch {}
          }
        }
      } catch {}
    });
  } catch (err) {
    console.warn('[Main] Backup write error:', err);
  }
}

// ==================== IPC HANDLERS ====================
ipcMain.handle('get-runtime-mode', () => {
  if (selectedRuntimeMode === 'legacy') {
    return { success: true, mode: 'legacy' };
  }

  try {
    const ready = assertRuntimeReady(undefined, { allowUnbootstrapped: true });
    return {
      success: true,
      mode: 'sync',
      bootstrapComplete: ready.bootstrapState.status === 'COMPLETE'
    };
  } catch (error) {
    return { ...ErrorResponse(error), mode: 'sync' };
  }
});

ipcMain.handle('db-read', (event, targetCompanyId) => {
  if (selectedRuntimeMode === 'sync') {
    try {
      const ready = assertRuntimeReady(targetCompanyId);
      return {
        success: true,
        data: loadWorkbookProjectionFromSqlite(ready.db, ready.companyId)
      };
    } catch (error) {
      return ErrorResponse(error);
    }
  }

  try {
    return { success: true, data: readDb(validateTargetCompanyId(targetCompanyId)) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('db-write', async (event, data, options = {}) => {
  if (selectedRuntimeMode === 'sync') {
    return JsonWriteForbidden();
  }

  let compId;
  try {
    compId = validateTargetCompanyId(options?.companyId || data?.companyId);
    if (data?.companyId !== undefined && data.companyId !== compId) {
      throw new Error('Payload company context does not match the active company');
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
  return enqueueCompanyWrite(compId, async () => {
    try {
      await writeDbAsync(data, compId);
      const isMajor = options?.forceBackup || false;
      await maybeCreateBackup(data, isMajor, compId);
      return { success: true, savedAt: new Date().toISOString() };
    } catch (err) {
      console.error('[Main] db-write error:', err);
      return { success: false, error: err.message };
    }
  });
});

// Phase 5: Fast Delta Patch IPC with serialized queue
ipcMain.handle('db-patch', async (event, patches, options = {}) => {
  if (selectedRuntimeMode === 'sync') {
    return JsonWriteForbidden();
  }

  let compId;
  try {
    compId = validateTargetCompanyId(options?.companyId || patches?.companyId);
    if (patches?.companyId !== undefined && patches.companyId !== compId) {
      throw new Error('Patch company context does not match the active company');
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
  return enqueueCompanyWrite(compId, async () => {
    try {
      const current = readDb(compId) || {};
      const updated = { ...current, ...patches, companyId: compId, updatedAt: new Date().toISOString() };
      await writeDbAsync(updated, compId);
      return { success: true, savedAt: updated.updatedAt };
    } catch (err) {
      console.error('[Main] db-patch error:', err);
      return { success: false, error: err.message };
    }
  });
});

// ====================  LOCAL SQLITE / MIGRATION IPC ====================
// Domain-limited read-only / controlled migration IPC boundaries.
// Renderer CANNOT provide raw SQL, arbitrary file paths, or cross-company context.

ipcMain.handle('migration-status', (event, targetCompanyId) => {
  try {
    const ready = assertRuntimeReady(targetCompanyId);
    const compId = ready.companyId;
    const userData = app.getPath('userData');
    const discovery = migrator.discoverLegacySource(userData, compId);
    const db = ready.db;
    const lastRun = db.prepare(`
      SELECT * FROM migration_runs WHERE company_id = ? ORDER BY started_at DESC LIMIT 1
    `).get(compId);
    return {
      success: true,
      companyId: compId,
      discovery,
      lastRun: lastRun || null
    };
  } catch (err) {
    return ErrorResponse(err);
  }
});

ipcMain.handle('migration-verify', (event, targetCompanyId) => {
  try {
    const compId = assertRuntimeReady(targetCompanyId).companyId;
    const userData = app.getPath('userData');
    const report = parityReporter.generateParityReport(userData, compId);
    return { success: true, report };
  } catch (err) {
    return ErrorResponse(err);
  }
});

ipcMain.handle('migration-run', (event, targetCompanyId) => {
  try {
    const compId = assertRuntimeReady(targetCompanyId).companyId;
    const userData = app.getPath('userData');
    const result = migrator.migrateLegacyData(userData, compId);
    return { success: true, result };
  } catch (err) {
    return ErrorResponse(err);
  }
});

// ====================  COMMAND PIPELINE & OUTBOX IPC ====================
// Domain-limited write seam. Raw SQL and arbitrary table writes are strictly disallowed.

ipcMain.handle('command-submit-ticket', (event, command) => {
  try {
    const compId = assertRuntimeReady(command?.companyId).companyId;
    const userData = app.getPath('userData');
    const result = commandPipeline.executeSubmitTicketCommand(userData, compId, command);
    return { success: true, result };
  } catch (err) {
    return ErrorResponse(err, 'COMMAND_FAILED');
  }
});

ipcMain.handle('command-record-adjustment', (event, command) => {
  try {
    const compId = assertRuntimeReady(command?.companyId).companyId;
    const userData = app.getPath('userData');
    const result = commandPipeline.executeRecordAdjustmentCommand(userData, compId, command);
    return { success: true, result };
  } catch (err) {
    return ErrorResponse(err, 'COMMAND_FAILED');
  }
});

ipcMain.handle('command-reverse-adjustment', (event, command) => {
  try {
    const compId = assertRuntimeReady(command?.companyId).companyId;
    const userData = app.getPath('userData');
    const result = commandPipeline.executeReverseAdjustmentCommand(userData, compId, command);
    return { success: true, result };
  } catch (err) {
    return ErrorResponse(err, 'COMMAND_FAILED');
  }
});

// Fixed reconciliation intent endpoint; this is deliberately not a generic command executor.
ipcMain.handle('command-resolve-reconciliation', (event, command) => {
  try {
    const validatedCompanyId = validateTargetCompanyId(command?.companyId);
    const compId = assertRuntimeReady(validatedCompanyId).companyId;
    const userData = app.getPath('userData');
    const result = commandPipeline.executeResolveReconciliationCandidateCommand(userData, compId, command);
    return { success: true, result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: err.code || 'COMMAND_FAILED',
      details: err.details || null
    };
  }
});

ipcMain.handle('workbook-command', (event, command) => {
  try {
    const ready = assertRuntimeReady(command?.companyId);
    const result = workbookCommandPipeline.executeWorkbookCommand(
      app.getPath('userData'),
      ready.companyId,
      command
    );
    return { success: true, result };
  } catch (error) {
    return ErrorResponse(error, 'WORKBOOK_COMMAND_FAILED');
  }
});

ipcMain.handle('ticket-draft-save', (event, args) => {
  try {
    const ready = assertRuntimeReady(args?.companyId);
    const result = workbookCommandPipeline.saveTicketDraft(
      app.getPath('userData'),
      ready.companyId,
      args?.companyId,
      args?.modelId,
      args?.form
    );
    return result;
  } catch (error) {
    return ErrorResponse(error, 'TICKET_DRAFT_SAVE_FAILED');
  }
});

ipcMain.handle('outbox-diagnostics', (event, targetCompanyId) => {
  try {
    const ready = assertRuntimeReady(targetCompanyId);
    const compId = ready.companyId;
    const userData = app.getPath('userData');
    const db = ready.db;
    const diagnostics = outboxManager.getOutboxDiagnostics(db, compId);
    return { success: true, diagnostics };
  } catch (err) {
    return ErrorResponse(err);
  }
});

ipcMain.handle('outbox-pending', (event, args) => {
  try {
    const ready = assertRuntimeReady(typeof args === 'string' ? args : args?.companyId);
    const compId = ready.companyId;
    const limit = typeof args === 'object' && typeof args?.limit === 'number' ? args.limit : 100;
    const userData = app.getPath('userData');
    const db = ready.db;
    const pending = outboxManager.listPendingOperations(db, compId, limit);
    return { success: true, pending };
  } catch (err) {
    return ErrorResponse(err);
  }
});

ipcMain.handle('rebuild-projections', (event, targetCompanyId) => {
  try {
    const compId = assertRuntimeReady(targetCompanyId).companyId;
    const userData = app.getPath('userData');
    const projections = rebuildCompanyProjections(userData, compId);
    return { success: true, projections };
  } catch (err) {
    return ErrorResponse(err);
  }
});

// ====================  DISTRIBUTED SYNC IPC (FEATURE GATED) ====================
// Gated by NOVDA_SYNC_ENABLED=1 to prevent silent production cutover.
const isSyncEnabled = selectedRuntimeMode === 'sync';

if (isSyncEnabled) {
  const { SyncClient } = require('./sync/syncClient.cjs');
  const { ensureCompanyBootstrapped } = require('./sync/bootstrapInitializer.cjs');
  const { dispatchOutbox } = require('./sync/outboxDispatcher.cjs');
  const { executePullOnlyProtocol, executeReconnectProtocol } = require('./sync/reconnectManager.cjs');
  const { acquireAndStoreLease, consumeNextPartyNumber } = require('./sync/leaseManager.cjs');

  function createSyncClient(compId, withOperator = true) {
    const deviceToken = readDeviceCredential(compId);
    if (!deviceToken) throw new Error('DEVICE_AUTH_REQUIRED');
    const deviceId = license.checkLicenseStatus(app.getPath('userData')).machineId;
    return new SyncClient({
      token: deviceToken,
      operatorToken: withOperator ? readOperatorSession(compId) : '',
      deviceId,
      clientVersion: app.getVersion(),
      baseUrl: resolveApiBaseUrl({ allowHttp: !app.isPackaged }),
      allowHttp: !app.isPackaged
    });
  }

  ipcMain.handle('operator-login', async (event, args) => {
    try {
      const compId = assertRuntimeReady(args?.companyId).companyId;
      const session = await createSyncClient(compId, false).loginOperator(args?.operatorId, args?.password);
      storeOperatorSession(compId, session.token);
      return { success: true, session: { operatorId: session.operatorId, companyId: session.companyId, expiresAt: session.expiresAt } };
    } catch (err) {
      return ErrorResponse(err, 'OPERATOR_LOGIN_FAILED');
    }
  });

  ipcMain.handle('operator-revoke', async (event, targetCompanyId) => {
    try {
      const compId = assertRuntimeReady(targetCompanyId).companyId;
      await createSyncClient(compId).revokeOperator();
      deleteOperatorSession(compId);
      return { success: true };
    } catch (err) {
      return ErrorResponse(err, 'OPERATOR_REVOKE_FAILED');
    }
  });

  ipcMain.handle('sync-dispatch', async (event, targetCompanyId) => {
    try {
      const ready = assertRuntimeReady(targetCompanyId);
      const compId = ready.companyId;
      const userData = app.getPath('userData');
      const db = ready.db;
      const syncClient = createSyncClient(compId);
      const result = await dispatchOutbox(db, compId, syncClient, { baseUserDataPath: userData });
      return { success: true, result };
    } catch (err) {
      return ErrorResponse(err, 'SYNC_DISPATCH_FAILED');
    }
  });

  ipcMain.handle('sync-bootstrap', async (event, targetCompanyId) => {
    try {
      const ready = assertRuntimeReady(targetCompanyId, { allowUnbootstrapped: true });
      const compId = ready.companyId;
      const syncClient = createSyncClient(compId, false);
      const result = await ensureCompanyBootstrapped(ready.db, compId, syncClient);
      return { success: true, result };
    } catch (error) {
      return ErrorResponse(error, '_BOOTSTRAP_FAILED');
    }
  });

  ipcMain.handle('sync-pull', async (event, targetCompanyId) => {
    try {
      const ready = assertRuntimeReady(targetCompanyId);
      const compId = ready.companyId;
      const syncClient = createSyncClient(compId, false);
      const result = await executePullOnlyProtocol(ready.db, compId, syncClient, { maxPages: 10 });
      return { success: true, result };
    } catch (err) {
      return ErrorResponse(err, 'SYNC_PULL_FAILED');
    }
  });

  ipcMain.handle('sync-reconnect', async (event, targetCompanyId) => {
    try {
      const ready = assertRuntimeReady(targetCompanyId);
      const compId = ready.companyId;
      const userData = app.getPath('userData');
      const db = ready.db;
      const syncClient = createSyncClient(compId);
      const result = await executeReconnectProtocol(db, compId, syncClient, { baseUserDataPath: userData });
      return { success: true, result };
    } catch (err) {
      return ErrorResponse(err, 'SYNC_RECONNECT_FAILED');
    }
  });

  ipcMain.handle('period-archive-read', async (event, args) => {
    try {
      const ready = assertRuntimeReady(args?.companyId);
      const filename = typeof args?.filename === 'string' ? args.filename : '';
      if (!filename || filename.length > 256) throw Object.assign(new Error('INVALID_PERIOD_ARCHIVE'), { code: 'INVALID_PERIOD_ARCHIVE' });
      const period = ready.db.prepare(`
        SELECT id FROM periods WHERE company_id = ? AND (id = ? OR archive_filename = ?) AND is_closed = 1
      `).get(ready.companyId, filename, filename);
      if (!period) throw Object.assign(new Error('PERIOD_ARCHIVE_NOT_FOUND'), { code: 'PERIOD_ARCHIVE_NOT_FOUND' });
      const localArchive = require('./database/projectionReader.cjs').loadPeriodArchiveFromSqlite(
        ready.db, ready.companyId, period.id
      );
      if (localArchive?.data) return { success: true, data: localArchive.data };
      const remoteArchive = await createSyncClient(ready.companyId, false).getPeriodArchive(period.id);
      if (!remoteArchive || typeof remoteArchive !== 'object') throw Object.assign(new Error('PERIOD_ARCHIVE_NOT_FOUND'), { code: 'PERIOD_ARCHIVE_NOT_FOUND' });
      const archiveData = remoteArchive.archive_json || remoteArchive.data || remoteArchive;
      return { success: true, data: typeof archiveData === 'string' ? JSON.parse(archiveData) : archiveData };
    } catch (error) {
      return ErrorResponse(error, 'PERIOD_ARCHIVE_READ_FAILED');
    }
  });

  ipcMain.handle('lease-acquire', async (event, args) => {
    try {
      const ready = assertRuntimeReady(typeof args === 'string' ? args : args?.companyId);
      const compId = ready.companyId;
      const blockSize = typeof args === 'object' && typeof args?.blockSize === 'number' ? args.blockSize : 50;
      const db = ready.db;
      const syncClient = createSyncClient(compId, false);
      const lease = await acquireAndStoreLease(db, compId, syncClient, blockSize);
      return { success: true, lease };
    } catch (err) {
      return ErrorResponse(err, 'LEASE_ACQUIRE_FAILED');
    }
  });

  ipcMain.handle('lease-consume', (event, targetCompanyId) => {
    try {
      const ready = assertRuntimeReady(targetCompanyId);
      const compId = ready.companyId;
      const db = ready.db;
      const nextNum = consumeNextPartyNumber(db, compId);
      return { success: true, number: nextNum };
    } catch (err) {
      return ErrorResponse(err, 'LEASE_CONSUME_FAILED');
    }
  });
}

function getArchiveIndexPath(companyId) {
  return path.join(getArchivesDir(companyId), 'index.json');
}

function updateArchiveIndex(entry, companyId) {
  try {
    const p = getArchiveIndexPath(companyId);
    let list = [];
    if (fs.existsSync(p)) {
      try { list = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
    }
    list = list.filter(i => i.filename !== entry.filename);
    list.unshift(entry);
    fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) {}
}

function sanitizeArchiveFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const base = path.basename(filename);
  if (!/^[a-zA-Z0-9_\-.]+\.json$/i.test(base)) return null;
  return base;
}

function resolveSecurePath(dir, filename) {
  const safeName = sanitizeArchiveFilename(filename);
  if (!safeName) return null;
  const resolvedDir = path.resolve(dir);
  const target = path.resolve(resolvedDir, safeName);
  if (!target.startsWith(resolvedDir + path.sep) && target !== resolvedDir) {
    return null;
  }
  return target;
}

ipcMain.handle('archives-list-meta', (event, companyId) => {
  if (selectedRuntimeMode === 'sync') return LegacyStorageForbidden();
  try {
    companyId = validateTargetCompanyId(companyId);
    const p = getArchiveIndexPath(companyId);
    if (fs.existsSync(p)) {
      return { success: true, archives: JSON.parse(fs.readFileSync(p, 'utf-8')) };
    }
    return { success: true, archives: [] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('archives-list', (event, companyId) => {
  if (selectedRuntimeMode === 'sync') return LegacyStorageForbidden();
  try {
    companyId = validateTargetCompanyId(companyId);
    const p = getArchiveIndexPath(companyId);
    if (fs.existsSync(p)) {
      try {
        const cached = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (Array.isArray(cached) && cached.length > 0) {
          return { success: true, archives: cached };
        }
      } catch {}
    }

    const dir = getArchivesDir(companyId);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json').sort().reverse();
    const list = files.map(filename => {
      try {
        const fullPath = resolveSecurePath(dir, filename);
        if (!fullPath) return { filename };
        const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        return {
          filename,
          period: raw.period,
          archivedAt: raw.archivedAt,
          workersCount: (raw.workers || []).length
        };
      } catch { return { filename }; }
    });

    try { fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8'); } catch {}
    return { success: true, archives: list };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('archive-save', (event, args) => {
  if (selectedRuntimeMode === 'sync') return LegacyStorageForbidden();
  try {
    let { filename, data, companyId } = args || {};
    companyId = validateTargetCompanyId(companyId);
    const dir = getArchivesDir(companyId);
    const filepath = resolveSecurePath(dir, filename);
    if (!filepath) {
      return { success: false, error: 'Xavfsizlik xatosi: Noto\'g\'ri fayl nomi' };
    }
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
    updateArchiveIndex({
      filename: path.basename(filepath),
      period: data.period,
      archivedAt: data.archivedAt || new Date().toISOString(),
      workersCount: (data.workers || []).length
    }, companyId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('archive-read', (event, args) => {
  if (selectedRuntimeMode === 'sync') return LegacyStorageForbidden();
  try {
    const rawFilename = typeof args === 'string' ? args : args?.filename;
    const companyId = validateTargetCompanyId(typeof args === 'object' ? args?.companyId : undefined);
    const aDir = getArchivesDir(companyId);
    const bDir = getBackupsDir(companyId);

    let filepath = resolveSecurePath(aDir, rawFilename);
    if (!filepath || !fs.existsSync(filepath)) {
      filepath = resolveSecurePath(bDir, rawFilename);
    }
    if (!filepath || !fs.existsSync(filepath)) {
      return { success: false, error: 'Fayl topilmadi yoki ruxsat berilmagan' };
    }
    return { success: true, data: JSON.parse(fs.readFileSync(filepath, 'utf-8')) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('backups-list', (event, companyId) => {
  if (selectedRuntimeMode === 'sync') return LegacyStorageForbidden();
  try {
    companyId = validateTargetCompanyId(companyId);
    const bDir = getBackupsDir(companyId);
    const aDir = getArchivesDir(companyId);

    const bFiles = fs.existsSync(bDir) ? fs.readdirSync(bDir).filter(f => f.endsWith('.json')).map(f => ({ filename: f, dir: bDir, isArchive: false })) : [];
    const aFiles = fs.existsSync(aDir) ? fs.readdirSync(aDir).filter(f => f.endsWith('.json')).map(f => ({ filename: f, dir: aDir, isArchive: true })) : [];

    const all = [...aFiles, ...bFiles];
    const backups = all.map(item => {
      try {
        const fullPath = path.join(item.dir, item.filename);
        const stat = fs.statSync(fullPath);
        const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        
        let filledOpsCount = 0;
        for (const m of (raw.models || [])) {
          for (const wOps of Object.values(m.hisobQuantities || {})) {
            filledOpsCount += Object.keys(wOps || {}).length;
          }
        }

        return {
          filename: item.filename,
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
          isArchive: item.isArchive,
          filledOpsCount,
          workersCount: (raw.workers || []).length,
          modelsCount: (raw.models || []).length
        };
      } catch {
        return {
          filename: item.filename,
          size: 0,
          createdAt: '',
          isArchive: item.isArchive,
          filledOpsCount: 0,
          workersCount: 0,
          modelsCount: 0
        };
      }
    }).sort((a, b) => (b.filename > a.filename ? 1 : -1));

    return { success: true, backups };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('backup-read', (event, args) => {
  if (selectedRuntimeMode === 'sync') return LegacyStorageForbidden();
  try {
    const rawFilename = typeof args === 'string' ? args : args?.filename;
    const companyId = validateTargetCompanyId(typeof args === 'object' ? args?.companyId : undefined);
    const bDir = getBackupsDir(companyId);
    const aDir = getArchivesDir(companyId);

    let filepath = resolveSecurePath(bDir, rawFilename);
    if (!filepath || !fs.existsSync(filepath)) {
      filepath = resolveSecurePath(aDir, rawFilename);
    }
    if (!filepath || !fs.existsSync(filepath)) {
      return { success: false, error: 'Zaxira fayli topilmadi yoki ruxsat berilmagan' };
    }
    return { success: true, data: JSON.parse(fs.readFileSync(filepath, 'utf-8')) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('backup-restore', async (event, args) => {
  if (selectedRuntimeMode === 'sync') return LegacyStorageForbidden();
  try {
    const rawFilename = typeof args === 'string' ? args : args?.filename;
    const companyId = validateTargetCompanyId(typeof args === 'object' ? args?.companyId : undefined);
    const bDir = getBackupsDir(companyId);
    const aDir = getArchivesDir(companyId);

    let filepath = resolveSecurePath(bDir, rawFilename);
    if (!filepath || !fs.existsSync(filepath)) {
      filepath = resolveSecurePath(aDir, rawFilename);
    }
    if (!filepath || !fs.existsSync(filepath)) {
      return { success: false, error: 'Zaxira fayli topilmadi yoki ruxsat berilmagan' };
    }
    const raw = await fs.promises.readFile(filepath, 'utf-8');
    const data = JSON.parse(raw);
    if (data?.companyId && data.companyId !== companyId) {
      return { success: false, error: 'Zaxira boshqa korxonaga tegishli' };
    }
    await enqueueCompanyWrite(companyId, async () => {
      const current = readDb(companyId);
      await maybeCreateBackup(current, true, companyId);
      await writeDbAsync(data, companyId);
    });
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerLicenseIpcHandlers({
  ipcMain,
  app,
  license,
  rejectRendererCompanyAssignment,
  rejectRendererLicenseSettings
});

ipcMain.handle('get-data-dir', () => {
  return getDataDir();
});

ipcMain.handle('print-html', async (event, { html, title }) => {
  return new Promise((resolve) => {
    let printWin = new BrowserWindow({
      show: false,
      parent: mainWindow || undefined,
      title: title || 'Novda-hisob-kitob - Print',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: false
      }
    });

    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, `patta_print_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.html`);

    fs.writeFile(tempFile, html, 'utf-8', (writeErr) => {
      if (writeErr) {
        if (printWin && !printWin.isDestroyed()) printWin.close();
        return resolve({ success: false, failureReason: writeErr.message });
      }

      printWin.loadFile(tempFile);

      printWin.webContents.on('did-finish-load', () => {
        setTimeout(() => {
          if (!printWin || printWin.isDestroyed()) {
            return resolve({ success: false, failureReason: 'Window destroyed' });
          }

          printWin.webContents.print(
            {
              silent: false,
              printBackground: true,
              color: true
            },
            (success, failureReason) => {
              try {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
              } catch {}
              try {
                if (printWin && !printWin.isDestroyed()) printWin.close();
              } catch {}
              resolve({ success, failureReason });
            }
          );
        }, 300);
      });

      printWin.webContents.on('did-fail-load', (e, code, desc) => {
        try {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        } catch {}
        try {
          if (printWin && !printWin.isDestroyed()) printWin.close();
        } catch {}
        resolve({ success: false, failureReason: desc });
      });
    });
  });
});

// ==================== AUTO UPDATER ====================
function downloadFile(url, destPath, onProgress, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects while downloading update'));

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return reject(new Error('Noto\'g\'ri URL formati: ' + url));
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.get(url, (res) => {
      // Handle HTTP redirects (301, 302, 303, 307, 308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = resolveAllowedRedirect(url, res.headers.location);
        res.resume();
        if (!nextUrl) return reject(new Error('Xavfsizlik xatosi: Ishonchsiz redirect manzili'));
        return downloadFile(nextUrl, destPath, onProgress, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Yuklab olishda xatolik: HTTP ${res.statusCode}`));
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      const fileStream = fs.createWriteStream(destPath);

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (onProgress) {
          const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          onProgress({ downloadedBytes, totalBytes, percent });
        }
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => resolve(destPath));
      });

      fileStream.on('error', (err) => {
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
        reject(err);
      });
    });

    req.on('error', (err) => {
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
      reject(err);
    });

    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Yuklab olish vaqti tugadi (Timeout)'));
    });
  });
}

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

let lastDownloadedUpdatePath = null;

ipcMain.handle('download-app-update', async (event, { url, version }) => {
  const blocked = blockUnverifiedUpdate(selectedRuntimeMode);
  if (blocked) return blocked;
  if (!url) return { success: false, error: 'URL kiritilmagan' };
  if (!isAllowedUpdateUrl(url)) {
    return {
      success: false,
      error: 'Xavfsizlik xatosi: Ishonchsiz yangilanish serveri yoki protokol (Faqat ruxsat berilgan HTTPS qabul qilinadi)'
    };
  }
  const tempDir = app.getPath('temp');
  const safeVer = (version || 'latest').replace(/[^a-zA-Z0-9.-]/g, '_');
  const destPath = path.join(tempDir, `Novda-Update-${safeVer}.exe`);

  try {
    await downloadFile(url, destPath, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-update-progress', progress);
      }
    });
    lastDownloadedUpdatePath = destPath;
    return { success: true, filePath: destPath };
  } catch (err) {
    console.error('Update download error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('install-app-update', async (event, { filePath }) => {
  const blocked = blockUnverifiedUpdate(selectedRuntimeMode);
  if (blocked) return blocked;
  const tempDir = app.getPath('temp');
  const resolvedPath = path.resolve(filePath || '');
  const resolvedTemp = path.resolve(tempDir);

  if (
    !filePath ||
    !resolvedPath.startsWith(resolvedTemp + path.sep) ||
    !resolvedPath.toLowerCase().endsWith('.exe') ||
    (lastDownloadedUpdatePath && resolvedPath !== path.resolve(lastDownloadedUpdatePath)) ||
    !fs.existsSync(resolvedPath)
  ) {
    return { success: false, error: 'Xavfsizlik xatosi: Noto\'g\'ri yoki tekshirilmagan o\'rnatuvchi fayli' };
  }
  try {
    const child = child_process.spawn(resolvedPath, [], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    setTimeout(() => {
      app.quit();
    }, 400);

    return { success: true };
  } catch (err) {
    console.error('Update install error:', err);
    return { success: false, error: err.message };
  }
});

// ==================== WINDOW ====================
async function createWindow() {
  if (selectedRuntimeMode === 'sync') {
    try {
      assertRuntimeReady(undefined, { allowUnbootstrapped: true });
    } catch (error) {
      if (!canOpenActivationUi(error)) {
        console.error('[Main]  readiness failed before window creation:', error?.code || '_RUNTIME_NOT_READY');
        app.exitCode = 1;
        app.quit();
        return;
      }
    }
  }

  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const indexHtml = path.resolve(__dirname, '../../../dist/index.html');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'Novda - Hisob-Kitob Tizimi',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    },
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0f172a'
  });

  configureSecureWebContents(mainWindow.webContents, {
    appEntryPath: indexHtml,
    openExternal: (url) => shell.openExternal(url)
  });
  mainWindow.loadFile(indexHtml);

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer]: ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`did-fail-load: ${errorCode} - ${errorDescription}`);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('render-process-gone:', details);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

process.on('uncaughtException', (err) => {
  console.error('Main process uncaughtException:', err);
});

app.on('before-quit', () => {
  try {
    databaseManager.closeAllCompanyDatabases();
  } catch (err) {
    console.warn('[Main] Error closing databases on quit:', err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
