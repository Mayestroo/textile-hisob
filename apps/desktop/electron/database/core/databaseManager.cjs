'use strict';

const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeCompanyDbPath, isSafeCompanyId } = require('./companyPath.cjs');
const { applyMigrations, verifySchemaVersionConsistency } = require('./migrationRunner.cjs');

/**
 * Map of managed company SQLite database connections.
 * Key: canonical file path, Value: owning company and connection.
 * A company can exist in both an active and an isolated restore/upgrade profile.
 * @type {Map<string, { companyId: string, db: Database }>}
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
  const runCheck = () => db.prepare('PRAGMA integrity_check').all().map((row) => String(row.integrity_check));
  let results = runCheck();
  if (results.length !== 1 || results[0] !== 'ok') {
    const repairableIndexErrors = results.map((message) => {
      const match = message.match(/^(?:wrong # of entries in index|row \d+ missing from index|row \d+ out of order in index) ([A-Za-z0-9_]+)$/);
      return match?.[1] || null;
    });
    const indexes = [...new Set(repairableIndexErrors.filter(Boolean))];
    const allIndexOnly = indexes.length > 0 && repairableIndexErrors.every(Boolean);
    const existingIndexes = allIndexOnly
      ? new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((row) => row.name))
      : new Set();
    if (allIndexOnly && indexes.every((name) => existingIndexes.has(name))) {
      for (const name of indexes) db.exec(`REINDEX "${name}"`);
      results = runCheck();
    }
  }
  if (results.length !== 1 || results[0] !== 'ok') {
    const result = results.join('; ');
    const err = new Error(`SQLite database integrity check failed: ${result}`);
    err.code = 'DATABASE_CORRUPT';
    err.details = results;
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

  const dbPath = sanitizeCompanyDbPath(baseUserDataPath, companyId);
  const canonicalPath = path.join(fs.realpathSync(path.dirname(dbPath)), path.basename(dbPath));
  const connectionKey = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  // Reuse only this exact file, never another profile containing the same tenant.
  if (activeCompanyConnections.has(connectionKey)) {
    const existingDb = activeCompanyConnections.get(connectionKey).db;
    if (existingDb.open) {
      runDatabaseIntegrityChecks(existingDb);
      return existingDb;
    }
    activeCompanyConnections.delete(connectionKey);
  }

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

    activeCompanyConnections.set(connectionKey, { companyId, db });
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
  let closed = false;
  for (const [key, entry] of activeCompanyConnections) {
    if (entry.companyId !== companyId) continue;
    const { db } = entry;
    activeCompanyConnections.delete(key);
    if (db.open) {
      db.close();
      closed = true;
    }
  }
  return closed;
}

/**
 * Closes all active company database connections.
 */
function closeAllCompanyDatabases() {
  for (const { companyId, db } of activeCompanyConnections.values()) {
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
