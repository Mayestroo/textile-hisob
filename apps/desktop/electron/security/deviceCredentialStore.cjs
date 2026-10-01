'use strict';

const fs = require('fs');
const path = require('path');
const { isSafeCompanyId } = require('../database/companyPath.cjs');

/**
 * Resolves Electron's safeStorage API.
 * In Electron main process, require('electron').safeStorage is available.
 * Supports dependency injection for testing.
 *
 * @param {object} [injectedSafeStorage]
 * @returns {object|null}
 */
function getSafeStorage(injectedSafeStorage) {
  if (injectedSafeStorage) {
    return injectedSafeStorage;
  }
  try {
    const electron = require('electron');
    if (electron && electron.safeStorage) {
      return electron.safeStorage;
    }
  } catch {
    // Non-electron environment
  }
  return null;
}

/**
 * Resolves the credentials storage directory.
 * Defaults to <userData>/credentials in Electron runtime.
 * Supports dependency injection for testing.
 *
 * @param {string} [injectedBaseDir]
 * @returns {string}
 */
function getCredentialsDir(injectedBaseDir) {
  if (injectedBaseDir) {
    if (!fs.existsSync(injectedBaseDir)) {
      fs.mkdirSync(injectedBaseDir, { recursive: true });
    }
    return injectedBaseDir;
  }

  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const credsDir = path.join(app.getPath('userData'), 'credentials');
      if (!fs.existsSync(credsDir)) {
        fs.mkdirSync(credsDir, { recursive: true });
      }
      return credsDir;
    }
  } catch {
    // Fallback if app not yet ready or non-electron
  }

  const defaultDir = path.join(process.cwd(), '.credentials_vault');
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
  }
  return defaultDir;
}

/**
 * Resolves the path to the company-specific encrypted credential file.
 *
 * @param {string} companyId
 * @param {string} [baseDir]
 * @returns {string}
 */
function getCredentialFilePath(companyId, baseDir) {
  if (!isSafeCompanyId(companyId)) {
    throw new Error(`SECURITY_ERROR: Invalid or unsafe company ID "${companyId}"`);
  }
  const dir = getCredentialsDir(baseDir);
  return path.join(dir, `${companyId}.enc.json`);
}

/**
 * Securely stores a device credential for a company using OS-backed encryption (DPAPI on Windows).
 *
 * FAIL-CLOSED: If encryption is unavailable, throws ENCRYPTION_UNAVAILABLE.
 * Plaintext credential is NEVER written to disk.
 *
 * @param {string} companyId
 * @param {string} credential Plaintext bearer token
 * @param {object} [options={}]
 * @param {string} [options.deviceId='electron-workstation']
 * @param {object} [options.safeStorage] DI for testing
 * @param {string} [options.baseDir] DI for testing
 * @returns {boolean}
 */
function storeDeviceCredential(companyId, credential, options = {}) {
  if (!isSafeCompanyId(companyId)) {
    throw new Error(`SECURITY_ERROR: Invalid or unsafe company ID`);
  }
  if (!credential || typeof credential !== 'string' || credential.trim().length === 0) {
    throw new Error('VALIDATION_ERROR: Credential must be a non-empty string');
  }

  const safeStorage = getSafeStorage(options.safeStorage);
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    const err = new Error('ENCRYPTION_UNAVAILABLE: OS-backed credential encryption (safeStorage/DPAPI) is not available. Refusing to persist unencrypted credentials.');
    err.code = 'ENCRYPTION_UNAVAILABLE';
    throw err;
  }

  const encryptedBuffer = safeStorage.encryptString(credential.trim());
  const ciphertextHex = encryptedBuffer.toString('hex');

  const record = {
    companyId,
    deviceId: options.deviceId || 'electron-workstation',
    encryptedCredential: ciphertextHex,
    createdAt: new Date().toISOString(),
    credentialVersion: 1
  };

  const filePath = getCredentialFilePath(companyId, options.baseDir);
  const tempPath = `${filePath}.${Date.now()}.tmp`;

  // Atomic write
  fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);

  return true;
}

/**
 * Reads and decrypts a device credential for a company.
 *
 * FAIL-CLOSED: If encryption is unavailable or file missing/invalid, returns null or throws.
 *
 * @param {string} companyId
 * @param {object} [options={}]
 * @param {object} [options.safeStorage] DI for testing
 * @param {string} [options.baseDir] DI for testing
 * @returns {string|null} Plaintext credential or null if not found
 */
function readDeviceCredential(companyId, options = {}) {
  if (!isSafeCompanyId(companyId)) {
    return null;
  }

  const filePath = getCredentialFilePath(companyId, options.baseDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const safeStorage = getSafeStorage(options.safeStorage);
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    const err = new Error('ENCRYPTION_UNAVAILABLE: OS-backed credential encryption (safeStorage/DPAPI) is not available.');
    err.code = 'ENCRYPTION_UNAVAILABLE';
    throw err;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const record = JSON.parse(content);

    if (record.companyId !== companyId) {
      return null;
    }

    if (!record.encryptedCredential || typeof record.encryptedCredential !== 'string') {
      return null;
    }

    const encBuffer = Buffer.from(record.encryptedCredential, 'hex');
    const decrypted = safeStorage.decryptString(encBuffer);
    return decrypted;
  } catch (err) {
    if (err.code === 'ENCRYPTION_UNAVAILABLE') {
      throw err;
    }
    // Corrupt or tampered record fails closed
    return null;
  }
}

/**
 * Deletes a stored device credential for a company.
 *
 * @param {string} companyId
 * @param {object} [options={}]
 * @param {string} [options.baseDir] DI for testing
 * @returns {boolean}
 */
function deleteDeviceCredential(companyId, options = {}) {
  if (!isSafeCompanyId(companyId)) {
    return false;
  }

  const filePath = getCredentialFilePath(companyId, options.baseDir);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Checks whether a device credential exists for a company without decrypting it.
 *
 * @param {string} companyId
 * @param {object} [options={}]
 * @param {string} [options.baseDir] DI for testing
 * @returns {boolean}
 */
function hasDeviceCredential(companyId, options = {}) {
  if (!isSafeCompanyId(companyId)) {
    return false;
  }

  const filePath = getCredentialFilePath(companyId, options.baseDir);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const record = JSON.parse(content);
    return record.companyId === companyId && Boolean(record.encryptedCredential);
  } catch {
    return false;
  }
}

module.exports = {
  storeDeviceCredential,
  readDeviceCredential,
  deleteDeviceCredential,
  hasDeviceCredential,
  getCredentialFilePath
};
