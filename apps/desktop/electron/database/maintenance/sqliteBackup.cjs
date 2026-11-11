'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
  getCompanyDatabase,
  runDatabaseIntegrityChecks
} = require('../core/databaseManager.cjs');
const { sanitizeCompanyDbPath, isSafeCompanyId } = require('../core/companyPath.cjs');
const { verifySchemaCompatibility } = require('../core/migrationRunner.cjs');

function assertBackupCompany(db, companyId) {
  // Backup/restore never rebinds a tenant, including outbox/archive-only files.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  for (const { name } of tables) {
    if (!db.prepare(`PRAGMA table_info(${quote(name)})`).all().some(column => column.name === 'company_id')) continue;
    if (db.prepare(`SELECT 1 FROM ${quote(name)} WHERE company_id IS NOT ? LIMIT 1`).get(companyId)) {
      throw Object.assign(new Error('BACKUP_COMPANY_MISMATCH'), { code: 'BACKUP_COMPANY_MISMATCH' });
    }
  }
}

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
  const canonical = file => {
    const absolute = path.resolve(file);
    const resolved = fs.existsSync(absolute) ? fs.realpathSync(absolute)
      : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (canonical(db.name) === canonical(destinationBackupPath)) {
    throw Object.assign(new Error('BACKUP_DESTINATION_IS_SOURCE'), { code: 'BACKUP_DESTINATION_IS_SOURCE' });
  }
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
      verifySchemaCompatibility(backupDb);
      assertBackupCompany(backupDb, companyId);
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
 * Restores a verified standalone backup into a NEW isolated target. Existing
 * profiles/WAL files must be preserved and moved aside by an operator with the app
 * stopped. This helper never deletes a potentially newer fact or pending command.
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

  if (fs.existsSync(`${backupFilePath}-wal`) && fs.statSync(`${backupFilePath}-wal`).size > 0) {
    throw Object.assign(new Error('BACKUP_NOT_STANDALONE: create an online backup first'), { code: 'BACKUP_NOT_STANDALONE' });
  }
  // Verify source before even creating a target directory.
  const sourceDb = new Database(backupFilePath, { readonly: true });
  let schemaVersion = 0;
  try {
    runDatabaseIntegrityChecks(sourceDb);
    verifySchemaCompatibility(sourceDb);
    assertBackupCompany(sourceDb, targetCompanyId);
    const verRow = sourceDb.prepare('PRAGMA user_version').get();
    schemaVersion = verRow ? (verRow.user_version ?? verRow['user_version'] ?? 0) : 0;
  } finally {
    sourceDb.close();
  }

  // Never close another active same-company profile merely to restore a copy.
  const targetDbPath = sanitizeCompanyDbPath(targetBaseUserDataPath, targetCompanyId);
  const targetDir = path.dirname(targetDbPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  if ([targetDbPath, `${targetDbPath}-wal`, `${targetDbPath}-shm`].some(file => fs.existsSync(file))) {
    throw Object.assign(new Error('RESTORE_TARGET_EXISTS: restore to a new isolated profile'), { code: 'RESTORE_TARGET_EXISTS' });
  }
  const staging = fs.mkdtempSync(path.join(targetDir, '.restore-'));
  const stagedFile = path.join(staging, 'profile.sqlite');
  let integrityChecks;
  try {
    fs.copyFileSync(backupFilePath, stagedFile, fs.constants.COPYFILE_EXCL);
    const restoredDb = new Database(stagedFile, { readonly: true });
    try {
      verifySchemaCompatibility(restoredDb);
      integrityChecks = runDatabaseIntegrityChecks(restoredDb);
      assertBackupCompany(restoredDb, targetCompanyId);
    } finally { restoredDb.close(); }
    // Atomic no-overwrite publication on the same filesystem. Unsupported hard
    // links fail safely; never fall back to overwriting or deleting the target.
    fs.linkSync(stagedFile, targetDbPath);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
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
