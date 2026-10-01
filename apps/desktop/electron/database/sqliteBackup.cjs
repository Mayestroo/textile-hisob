'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
  getCompanyDatabase,
  closeCompanyDatabase,
  runDatabaseIntegrityChecks,
  configurePragmas
} = require('./databaseManager.cjs');
const { sanitizeCompanyDbPath, isSafeCompanyId } = require('./companyPath.cjs');
const { verifySchemaVersionConsistency } = require('./migrationRunner.cjs');

/**
 * Computes SHA-256 checksum of a file.
 * @param {string} filePath
 * @returns {string} Hex-encoded SHA-256
 */
function computeFileSha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Restores a previous destination after a platform-specific replacement
 * fallback cannot install the verified temporary backup.
 *
 * @param {string} previousPath
 * @param {string} destinationPath
 */
function restorePreviousBackup(previousPath, destinationPath) {
  let restoreDir;
  let restorePath;

  try {
    restoreDir = fs.mkdtempSync(
      path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.restore-`)
    );
    restorePath = path.join(restoreDir, path.basename(destinationPath));
    fs.copyFileSync(previousPath, restorePath);

    if (computeFileSha256(previousPath) !== computeFileSha256(restorePath)) {
      const verificationError = new Error('SQLite backup restoration copy verification failed');
      verificationError.code = 'BACKUP_RESTORE_VERIFICATION_FAILED';
      throw verificationError;
    }

    try {
      fs.renameSync(restorePath, destinationPath);
    } catch (renameError) {
      if (!fs.existsSync(destinationPath)) {
        throw renameError;
      }

      fs.unlinkSync(destinationPath);
      try {
        fs.renameSync(restorePath, destinationPath);
      } catch (retryError) {
        retryError.cause = renameError;
        throw retryError;
      }
    }
  } catch (restoreError) {
    restoreError.previousPath = previousPath;
    restoreError.destinationPath = destinationPath;
    if (restorePath) {
      restoreError.restoreStagingPath = restorePath;
    }
    throw restoreError;
  } finally {
    if (restoreDir) {
      fs.rmSync(restoreDir, { recursive: true, force: true });
    }
  }
}

/**
 * Installs a verified temporary backup without losing an existing destination.
 * POSIX can replace the destination with one rename; platforms that reject that
 * operation use a preserved sibling file and restore it if the final rename fails.
 *
 * @param {string} temporaryPath
 * @param {string} destinationPath
 */
function replaceVerifiedBackup(temporaryPath, destinationPath) {
  let previousDir;
  let previousPath;
  let preservePrevious = false;

  try {
    try {
      fs.renameSync(temporaryPath, destinationPath);
      return;
    } catch (directReplacementError) {
      if (!fs.existsSync(destinationPath)) {
        throw directReplacementError;
      }

      previousDir = fs.mkdtempSync(
        path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.previous-`)
      );
      previousPath = path.join(previousDir, path.basename(destinationPath));
      fs.renameSync(destinationPath, previousPath);

      try {
        fs.renameSync(temporaryPath, destinationPath);
        fs.rmSync(previousDir, { recursive: true, force: true });
        previousDir = undefined;
        previousPath = undefined;
      } catch (replacementError) {
        try {
          restorePreviousBackup(previousPath, destinationPath);
        } catch (restoreError) {
          preservePrevious = true;
          replacementError.restoreError = restoreError;
          replacementError.restorePath = previousPath;
        }
        throw replacementError;
      }
    }
  } finally {
    if (previousDir && (!preservePrevious || !fs.existsSync(previousPath))) {
      fs.rmSync(previousDir, { recursive: true, force: true });
    }
  }
}

/**
 * Performs a consistent point-in-time company SQLite backup using the
 * native SQLite Online Backup API (sqlite3_backup_*), properly handling WAL mode.
 *
 * @param {string} baseUserDataPath Base userData directory
 * @param {string} companyId Sanitized company ID
 * @param {string} destinationBackupPath Absolute path for backup file
 * @returns {Promise<{ success: boolean, backupPath: string, byteSize: number, sha256: string, schemaVersion: number, integrity: string, integrityCheck: string, foreignKeyCheck: Array<object> }>}
 */
async function backupCompanyDatabase(baseUserDataPath, companyId, destinationBackupPath) {
  if (!isSafeCompanyId(companyId)) {
    throw new Error(`Invalid or unsafe company ID for backup: "${companyId}"`);
  }

  // Ensure destination directory exists
  const destDir = path.dirname(destinationBackupPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const db = getCompanyDatabase(baseUserDataPath, companyId);
  const temporaryDir = fs.mkdtempSync(
    path.join(destDir, `.${path.basename(destinationBackupPath)}.tmp-`)
  );
  const temporaryBackupPath = path.join(temporaryDir, path.basename(destinationBackupPath));

  try {
    // better-sqlite3 db.backup uses sqlite3_backup_* API which safely snapshots WAL mode
    await db.backup(temporaryBackupPath);

    // Verify the staged backup before it can replace a known-good destination.
    const backupDb = new Database(temporaryBackupPath, { readonly: true });
    let schemaVersion = 0;
    let integrityChecks;
    try {
      integrityChecks = runDatabaseIntegrityChecks(backupDb);
      const verRow = backupDb.prepare('PRAGMA user_version').get();
      schemaVersion = verRow ? (verRow.user_version ?? verRow['user_version'] ?? 0) : 0;
    } finally {
      backupDb.close();
    }

    const stats = fs.statSync(temporaryBackupPath);
    const sha256 = computeFileSha256(temporaryBackupPath);

    replaceVerifiedBackup(temporaryBackupPath, destinationBackupPath);

    return {
      success: true,
      backupPath: destinationBackupPath,
      byteSize: stats.size,
      sha256,
      schemaVersion,
      integrity: 'ok',
      ...integrityChecks
    };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

/**
 * Restores a company SQLite database from a verified backup into an isolated or active userData directory.
 *
 * @param {string} backupFilePath Source backup file
 * @param {string} targetBaseUserDataPath Target base userData directory
 * @param {string} targetCompanyId Target company ID
 * @returns {{ success: boolean, targetPath: string, schemaVersion: number, integrity: string, integrityCheck: string, foreignKeyCheck: Array<object>, sha256: string }}
 */
function restoreCompanyDatabase(backupFilePath, targetBaseUserDataPath, targetCompanyId) {
  if (!isSafeCompanyId(targetCompanyId)) {
    throw new Error(`Invalid or unsafe target company ID for restore: "${targetCompanyId}"`);
  }

  if (!fs.existsSync(backupFilePath)) {
    throw new Error(`Backup file does not exist: "${backupFilePath}"`);
  }

  // Step 1: Verify source backup integrity before restoring
  const sourceDb = new Database(backupFilePath, { readonly: true });
  let schemaVersion = 0;
  try {
    runDatabaseIntegrityChecks(sourceDb);
    const verRow = sourceDb.prepare('PRAGMA user_version').get();
    schemaVersion = verRow ? (verRow.user_version ?? verRow['user_version'] ?? 0) : 0;
  } finally {
    sourceDb.close();
  }

  // Step 2: Ensure target directory exists and close active connections
  const targetDbPath = sanitizeCompanyDbPath(targetBaseUserDataPath, targetCompanyId);
  const targetDir = path.dirname(targetDbPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  closeCompanyDatabase(targetCompanyId);

  // Clean target WAL and SHM files if present
  const walPath = `${targetDbPath}-wal`;
  const shmPath = `${targetDbPath}-shm`;
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

  // Step 3: Copy backup file to target location
  fs.copyFileSync(backupFilePath, targetDbPath);

  // Step 4: Verify restored database opens cleanly, runs integrity check, and applies pragmas
  const restoredDb = new Database(targetDbPath);
  let integrityChecks;
  try {
    configurePragmas(restoredDb);
    verifySchemaVersionConsistency(restoredDb);
    integrityChecks = runDatabaseIntegrityChecks(restoredDb);
  } finally {
    restoredDb.close();
  }

  const sha256 = computeFileSha256(targetDbPath);

  return {
    success: true,
    targetPath: targetDbPath,
    schemaVersion,
    integrity: 'ok',
    ...integrityChecks,
    sha256
  };
}

module.exports = {
  backupCompanyDatabase,
  restoreCompanyDatabase,
  computeFileSha256
};
