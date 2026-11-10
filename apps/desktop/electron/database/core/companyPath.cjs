'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Validates whether a company ID string is safe and conforms to identifier rules.
 * Accepts only alphanumeric characters, underscores, and hyphens.
 * Explicitly rejects null bytes, path traversal sequences (..), and path separators.
 *
 * @param {any} companyId
 * @returns {boolean}
 */
function isSafeCompanyId(companyId) {
  if (!companyId || typeof companyId !== 'string') {
    return false;
  }
  if (companyId.includes('\0') || companyId.includes('/') || companyId.includes('\\') || companyId.includes('..')) {
    return false;
  }
  // Windows invalid filename characters: < > : " / \ | ? *
  if (/[<>:"/\\|?*]/.test(companyId)) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(companyId);
}

/**
 * Resolves and creates the canonical base directory for company databases:
 * <baseUserDataPath>/NovdaData/companies
 *
 * @param {string} baseUserDataPath
 * @returns {string} Absolute path to canonical companies directory
 */
function getCompaniesBaseDir(baseUserDataPath) {
  if (!baseUserDataPath || typeof baseUserDataPath !== 'string') {
    throw new Error('Invalid baseUserDataPath: must be a non-empty string');
  }
  const baseDir = path.resolve(baseUserDataPath, 'NovdaData', 'companies');
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }
  return baseDir;
}

/**
 * Resolves the directory for a specific company:
 * <baseUserDataPath>/NovdaData/companies/<companyId>
 *
 * @param {string} baseUserDataPath
 * @param {string} companyId
 * @returns {string} Absolute path to company directory
 */
function getCompanyDir(baseUserDataPath, companyId) {
  if (!isSafeCompanyId(companyId)) {
    throw new Error(`Invalid company ID "${companyId}": must contain only alphanumeric, dash, or underscore characters and cannot escape base directory`);
  }

  const baseDir = getCompaniesBaseDir(baseUserDataPath);
  const targetDir = path.resolve(baseDir, companyId);

  // Boundary check: target directory must reside strictly within baseDir
  if (!targetDir.startsWith(baseDir + path.sep)) {
    throw new Error(`Path traversal detected: company directory for "${companyId}" escapes companies directory`);
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  return targetDir;
}

/**
 * Resolves the canonical database path for a company:
 * <baseUserDataPath>/NovdaData/companies/<companyId>/hisob.sqlite
 *
 * @param {string} baseUserDataPath
 * @param {string} companyId
 * @returns {string} Absolute path to the company's hisob.sqlite file
 */
function sanitizeCompanyDbPath(baseUserDataPath, companyId) {
  const companyDir = getCompanyDir(baseUserDataPath, companyId);
  const targetFile = path.resolve(companyDir, 'hisob.sqlite');

  // Verify targetFile strictly resides inside companyDir
  if (!targetFile.startsWith(companyDir + path.sep)) {
    throw new Error('Path traversal detected: target database file escapes company directory');
  }

  return targetFile;
}

module.exports = {
  isSafeCompanyId,
  getCompaniesBaseDir,
  getCompanyDir,
  sanitizeCompanyDbPath
};
