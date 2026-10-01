'use strict';

const { isValidCompanyId } = require('./companyAuthority.cjs');
const databaseManager = require('./database/databaseManager.cjs');
const migrationRunner = require('./database/migrationRunner.cjs');
const { MIGRATIONS } = require('./database/schema.cjs');

const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version || 0;
const ACTIVATION_UI_READINESS_CODES = new Set([
  'COMPANY_BINDING_REQUIRED',
  'LICENSE_NOT_ACTIVATED',
  'DEVICE_CREDENTIAL_REQUIRED'
]);

const REQUIRED_DEPENDENCY_CONTRACTS = Object.freeze({
  databaseManager: ['getCompanyDatabase'],
  migrator: ['discoverLegacySource', 'migrateLegacyData'],
  parityReporter: ['generateParityReport'],
  commandPipeline: [
    'executeSubmitTicketCommand',
    'executeRecordAdjustmentCommand',
    'executeReverseAdjustmentCommand',
    'executeResolveReconciliationCandidateCommand'
  ],
  outboxManager: ['getOutboxDiagnostics', 'listPendingOperations'],
  projectionReader: ['loadWorkbookProjectionFromSqlite', 'rebuildCompanyProjections'],
  syncClient: ['SyncClient'],
  outboxDispatcher: ['dispatchOutbox'],
  changeFeedApplier: ['applyChangesBatch', 'getLocalCursor'],
  bootstrapApplier: ['getBootstrapState', 'applyBootstrapSnapshot'],
  bootstrapInitializer: ['ensureCompanyBootstrapped'],
  reconnectManager: ['executeReconnectProtocol'],
  leaseManager: ['acquireAndStoreLease', 'consumeNextPartyNumber']
});

function createReadinessError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.name = 'ReadinessError';
  error.code = code;
  error.details = details;
  error.readiness = true;
  return error;
}

/**
 * Resolves the process mode. Any value other than the exact opt-in value is
 * intentionally disabled, including test and development environments.
 */
function resolveRuntimeMode(env = process.env, options = {}) {
  if (options.packaged === true) return 'sync';
  return env.NOVDA_SYNC_ENABLED === '1' ? 'sync' : 'legacy';
}

function canOpenActivationUi(error) {
  return ACTIVATION_UI_READINESS_CODES.has(error?.code);
}

function loadDefaultDependencies() {
  const dependencies = {
    databaseManager,
    migrationRunner,
    migrator: null,
    parityReporter: null,
    commandPipeline: null,
    outboxManager: null,
    projectionReader: null,
    syncClient: null,
    outboxDispatcher: null,
    changeFeedApplier: null,
    reconnectManager: null,
    leaseManager: null
  };

  const modules = [
    ['migrator', './database/migrator.cjs'],
    ['parityReporter', './database/parityReporter.cjs'],
    ['commandPipeline', './database/commandPipeline.cjs'],
    ['outboxManager', './database/outboxManager.cjs'],
    ['projectionReader', './database/projectionReader.cjs'],
    ['syncClient', './sync/syncClient.cjs'],
    ['outboxDispatcher', './sync/outboxDispatcher.cjs'],
    ['changeFeedApplier', './sync/changeFeedApplier.cjs'],
    ['bootstrapApplier', './sync/bootstrapApplier.cjs'],
    ['bootstrapInitializer', './sync/bootstrapInitializer.cjs'],
    ['reconnectManager', './sync/reconnectManager.cjs'],
    ['leaseManager', './sync/leaseManager.cjs']
  ];

  for (const [name, modulePath] of modules) {
    try {
      dependencies[name] = require(modulePath);
    } catch {
      dependencies[name] = null;
    }
  }

  return dependencies;
}

function findMissingDependencies(dependencies) {
  const missing = [];
  for (const [name, members] of Object.entries(REQUIRED_DEPENDENCY_CONTRACTS)) {
    const dependency = dependencies?.[name];
    if (!dependency) {
      missing.push(name);
      continue;
    }
    for (const member of members) {
      if (typeof dependency[member] !== 'function') {
        missing.push(`${name}.${member}`);
      }
    }
  }
  return missing;
}

function rethrowStructuredDatabaseError(error, fallbackCode, message) {
  if (error?.readiness && error.code) {
    throw error;
  }
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : fallbackCode;
  throw createReadinessError(code, error?.message || message, {
    causeCode: error?.code,
    cause: error?.details
  });
}

/**
 * Proves that an explicitly requested sync runtime is safe to use.
 *
 * The verifier and integrity runner are injectable only to keep this boundary
 * deterministic in unit tests. Production callers use the real SQLite
 * migration and integrity implementations by default.
 */
function assertReadiness(input = {}) {
  const {
    companyId,
    licenseStatus,
    db,
    deviceCredential,
    syncServerUrl,
    databaseError,
    deviceCredentialError,
    dependencies = loadDefaultDependencies(),
    verifySchemaVersionConsistency = migrationRunner.verifySchemaVersionConsistency,
    runDatabaseIntegrityChecks = databaseManager.runDatabaseIntegrityChecks,
    expectedSchemaVersion = LATEST_SCHEMA_VERSION
  } = input;

  if (!isValidCompanyId(companyId)) {
    throw createReadinessError(
      'COMPANY_BINDING_REQUIRED',
      'A valid explicit company binding is required for sync readiness'
    );
  }

  if (!isValidCompanyId(licenseStatus?.companyId)) {
    throw createReadinessError(
      'COMPANY_BINDING_REQUIRED',
      'The active license does not contain a valid company binding'
    );
  }

  if (licenseStatus.companyId !== companyId) {
    throw createReadinessError(
      'COMPANY_BINDING_MISMATCH',
      `License company "${licenseStatus.companyId}" does not match requested company "${companyId}"`,
      { licensedCompanyId: licenseStatus.companyId, requestedCompanyId: companyId }
    );
  }

  if (licenseStatus.isRevoked === true || String(licenseStatus.status || '').toLowerCase() === 'revoked') {
    throw createReadinessError('LICENSE_REVOKED', 'The active license is revoked');
  }

  if (licenseStatus.isActivated !== true) {
    throw createReadinessError('LICENSE_NOT_ACTIVATED', 'An activated license is required for sync readiness');
  }

  if (licenseStatus.isBlocked === true) {
    throw createReadinessError('LICENSE_BLOCKED', 'The active license is blocked');
  }

  if (typeof deviceCredentialError !== 'undefined' && deviceCredentialError) {
    rethrowStructuredDatabaseError(
      deviceCredentialError,
      'DEVICE_CREDENTIAL_UNAVAILABLE',
      'The device credential could not be read'
    );
  }

  if (typeof deviceCredential !== 'string' || deviceCredential.trim().length === 0) {
    throw createReadinessError('DEVICE_CREDENTIAL_REQUIRED', 'A device credential is required for sync readiness');
  }

  let parsedSyncUrl;
  try {
    parsedSyncUrl = new URL(String(syncServerUrl));
  } catch {
    throw createReadinessError('SYNC_SERVER_URL_INVALID', 'The sync server URL is malformed');
  }
  if (
    !parsedSyncUrl.hostname
    || (parsedSyncUrl.protocol !== 'http:' && parsedSyncUrl.protocol !== 'https:')
  ) {
    throw createReadinessError(
      'SYNC_SERVER_URL_INVALID',
      'The sync server URL must be an absolute http or https URL'
    );
  }

  if (databaseError) {
    rethrowStructuredDatabaseError(databaseError, 'DATABASE_OPEN_FAILED', 'The company SQLite database could not be opened');
  }

  if (!db || db.open !== true) {
    throw createReadinessError('DATABASE_OPEN_FAILED', 'The company SQLite database is not open');
  }

  let schemaVersion;
  try {
    schemaVersion = verifySchemaVersionConsistency(db);
  } catch (error) {
    rethrowStructuredDatabaseError(error, 'SCHEMA_VERSION_CHECK_FAILED', 'SQLite schema consistency could not be verified');
  }
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion !== expectedSchemaVersion) {
    throw createReadinessError(
      'SCHEMA_VERSION_MISMATCH',
      `SQLite schema version ${String(schemaVersion)} is not the current version ${String(expectedSchemaVersion)}`,
      { schemaVersion, expectedSchemaVersion }
    );
  }

  let integrity;
  try {
    integrity = runDatabaseIntegrityChecks(db);
  } catch (error) {
    rethrowStructuredDatabaseError(error, 'DATABASE_INTEGRITY_FAILED', 'SQLite integrity checks failed');
  }
  if (integrity?.integrityCheck !== 'ok') {
    throw createReadinessError(
      'DATABASE_INTEGRITY_FAILED',
      'SQLite PRAGMA integrity_check did not return ok',
      { integrityCheck: integrity?.integrityCheck }
    );
  }
  if (!Array.isArray(integrity?.foreignKeyCheck)) {
    throw createReadinessError(
      'DATABASE_FOREIGN_KEY_CHECK_FAILED',
      'SQLite foreign-key check did not return a row list'
    );
  }
  if (integrity.foreignKeyCheck.length > 0) {
    throw createReadinessError(
      'DATABASE_FOREIGN_KEY_VIOLATION',
      'SQLite foreign-key check returned violations',
      { foreignKeyCheck: integrity.foreignKeyCheck }
    );
  }

  const missingDependencies = findMissingDependencies(dependencies);
  if (missingDependencies.length > 0) {
    throw createReadinessError(
      'SYNC_DEPENDENCIES_UNAVAILABLE',
      'Required sync runtime dependencies are unavailable',
      { missing: missingDependencies }
    );
  }

  return { mode: 'sync', companyId };
}

module.exports = {
  LATEST_SCHEMA_VERSION,
  REQUIRED_DEPENDENCY_CONTRACTS,
  createReadinessError,
  resolveRuntimeMode,
  canOpenActivationUi,
  loadDefaultDependencies,
  assertReadiness
};
