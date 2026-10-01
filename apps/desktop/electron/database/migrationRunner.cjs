'use strict';

const { MIGRATIONS, getMigrationChecksum } = require('./schema.cjs');

/**
 * Reads the latest recorded version from schema_meta table.
 * Returns 0 if schema_meta does not exist or has no rows.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
function getMetaTableVersion(db) {
  try {
    const tableExists = db.prepare(`
      SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='schema_meta'
    `).get();

    if (!tableExists || tableExists.count === 0) {
      return 0;
    }

    const row = db.prepare(`
      SELECT MAX(version) as max_version FROM schema_meta
    `).get();

    return (row && row.max_version) ? Number(row.max_version) : 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Reads the fast mirror version from PRAGMA user_version.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
function getPragmaUserVersion(db) {
  const row = db.pragma('user_version', { simple: true });
  return Number(row || 0);
}

/**
 * Validates consistency between authoritative schema_meta and PRAGMA user_version mirror.
 * Fails closed with SCHEMA_VERSION_MISMATCH if they diverge.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} The verified current schema version
 */
function verifySchemaVersionConsistency(db) {
  const metaVersion = getMetaTableVersion(db);
  const pragmaVersion = getPragmaUserVersion(db);

  if (metaVersion !== pragmaVersion) {
    const err = new Error(
      `SCHEMA_VERSION_MISMATCH: Authoritative schema_meta version (${metaVersion}) does not match PRAGMA user_version mirror (${pragmaVersion})`
    );
    err.code = 'SCHEMA_VERSION_MISMATCH';
    err.metaVersion = metaVersion;
    err.pragmaVersion = pragmaVersion;
    throw err;
  }

  return metaVersion;
}

/**
 * Applies all pending migrations in order.
 * Each migration is wrapped in an IMMEDIATE transaction that updates both
 * the schema_meta table and PRAGMA user_version mirror.
 * If migration N fails, transaction rollback occurs and version remains at N-1.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ previousVersion: number, currentVersion: number, appliedCount: number }}
 */
function applyMigrations(db) {
  // First, verify consistency of existing schema state
  const currentVersion = verifySchemaVersionConsistency(db);
  let appliedCount = 0;
  let activeVersion = currentVersion;

  // Filter migrations with version > activeVersion
  const pending = MIGRATIONS
    .filter(m => m.version > activeVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const checksum = getMigrationChecksum(migration);
    const nowIso = new Date().toISOString();

    // Execute migration atomically inside an immediate transaction
    const executeMigrationTx = db.transaction(() => {
      // 1. Run schema DDL changes
      migration.up(db);

      // 2. Record migration in authoritative schema_meta table
      db.prepare(`
        INSERT INTO schema_meta (version, name, applied_at, checksum)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, nowIso, checksum);

      // 3. Mirror the new version in PRAGMA user_version
      db.pragma(`user_version = ${migration.version}`);
    });

    executeMigrationTx.immediate();
    appliedCount++;
    activeVersion = migration.version;

    // Verify consistency after migration commit
    verifySchemaVersionConsistency(db);
  }

  return {
    previousVersion: currentVersion,
    currentVersion: activeVersion,
    appliedCount
  };
}

module.exports = {
  getMetaTableVersion,
  getPragmaUserVersion,
  verifySchemaVersionConsistency,
  applyMigrations
};
