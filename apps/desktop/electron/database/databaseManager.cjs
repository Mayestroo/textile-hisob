'use strict';

const Database = require('better-sqlite3');
const { sanitizeCompanyDbPath, isSafeCompanyId } = require('./companyPath.cjs');
const { applyMigrations, verifySchemaVersionConsistency } = require('./migrationRunner.cjs');

/**
 * Map of managed company SQLite database connections.
 * Key: sanitized companyId, Value: Database instance.
 * @type {Map<string, Database>}
 */
const activeCompanyConnections = new Map();

/**
 * Runs an integrity check on the database.
 * Returns 'ok' if healthy; throws an error if corruption or errors are detected.
 *
 * @param {Database} db
 * @returns {string} 'ok'
 */
function runIntegrityCheck(db) {
  const result = db.pragma('integrity_check', { simple: true });
  if (result !== 'ok') {
    const err = new Error(`SQLite database integrity check failed: ${result}`);
    err.code = 'DATABASE_CORRUPT';
    err.details = result;
    throw err;
  }
  return 'ok';
}

/**
 * Runs SQLite's foreign-key consistency check.
 * Returns an empty array if no violations are found; otherwise fails closed.
 *
 * @param {Database} db
 * @returns {Array<object>}
 */
function runForeignKeyCheck(db) {
  const rows = db.prepare('PRAGMA foreign_key_check').all();
  if (rows.length > 0) {
    const error = new Error(`SQLite foreign-key check failed: ${JSON.stringify(rows)}`);
    error.code = 'DATABASE_FOREIGN_KEY_VIOLATION';
    error.details = rows;
    throw error;
  }
  return [];
}

/**
 * Runs both independent SQLite health checks.
 *
 * @param {Database} db
 * @returns {{ integrityCheck: 'ok', foreignKeyCheck: Array<object> }}
 */
function runDatabaseIntegrityChecks(db) {
  return {
    integrityCheck: runIntegrityCheck(db),
    foreignKeyCheck: runForeignKeyCheck(db)
  };
}

/**
 * Configures required SQLite pragmas on a newly opened database connection:
 * - WAL journal mode
 * - foreign keys = ON
 * - busy_timeout = 5000ms
 * - synchronous = NORMAL
 *
 * @param {Database} db
 */
function configurePragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
}

/**
 * Gets or opens a managed connection to the company database.
 * Automatically runs integrity check and applies schema migrations if needed.
 *
 * @param {string} baseUserDataPath
 * @param {string} companyId
 * @param {object} [options={}]
 * @param {boolean} [options.skipMigration=false]
 * @returns {Database}
 */
function getCompanyDatabase(baseUserDataPath, companyId, options = {}) {
  if (!isSafeCompanyId(companyId)) {
    throw new Error(`Invalid or unsafe company ID: "${companyId}"`);
  }

  // Return existing managed connection if already open
  if (activeCompanyConnections.has(companyId)) {
    const existingDb = activeCompanyConnections.get(companyId);
    if (existingDb.open) {
      runDatabaseIntegrityChecks(existingDb);
      return existingDb;
    }
    activeCompanyConnections.delete(companyId);
  }

  const dbPath = sanitizeCompanyDbPath(baseUserDataPath, companyId);
  const db = new Database(dbPath);

  try {
    configurePragmas(db);
    runIntegrityCheck(db);

    if (!options.skipMigration) {
      applyMigrations(db);
    } else {
      verifySchemaVersionConsistency(db);
    }

    // The connection is not ready for  use until migrations and both
    // independent SQLite health checks have completed successfully.
    runDatabaseIntegrityChecks(db);

    activeCompanyConnections.set(companyId, db);
    return db;
  } catch (err) {
    if (db.open) {
      db.close();
    }
    throw err;
  }
}

/**
 * Closes the database connection for a specific company if open.
 *
 * @param {string} companyId
 * @returns {boolean} True if a connection was closed
 */
function closeCompanyDatabase(companyId) {
  if (activeCompanyConnections.has(companyId)) {
    const db = activeCompanyConnections.get(companyId);
    activeCompanyConnections.delete(companyId);
    if (db.open) {
      db.close();
      return true;
    }
  }
  return false;
}

/**
 * Closes all active company database connections.
 */
function closeAllCompanyDatabases() {
  for (const [companyId, db] of activeCompanyConnections.entries()) {
    try {
      if (db.open) {
        db.close();
      }
    } catch (e) {
      console.warn(`[DatabaseManager] Error closing database for "${companyId}":`, e);
    }
  }
  activeCompanyConnections.clear();
}

/**
 * Runs a transactional operation against the company database.
 * Uses BEGIN IMMEDIATE to acquire a write lock upfront and avoid deadlocks.
 *
 * @param {string} baseUserDataPath
 * @param {string} companyId
 * @param {Function} fn Function to execute inside transaction
 * @returns {any} Result of fn
 */
function runTransaction(baseUserDataPath, companyId, fn) {
  const db = getCompanyDatabase(baseUserDataPath, companyId);
  const tx = db.transaction(fn);
  return tx.immediate();
}

module.exports = {
  getCompanyDatabase,
  runIntegrityCheck,
  runForeignKeyCheck,
  runDatabaseIntegrityChecks,
  configurePragmas,
  closeCompanyDatabase,
  closeAllCompanyDatabases,
  runTransaction
};
