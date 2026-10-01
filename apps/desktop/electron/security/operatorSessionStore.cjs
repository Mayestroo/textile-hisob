'use strict';

const fs = require('fs');
const path = require('path');

function safeStorage(injected) {
  if (injected) return injected;
  try { return require('electron').safeStorage; } catch { return null; }
}

function storeOperatorSession(companyId, token, options = {}) {
  if (!companyId || !token) throw new Error('Company and operator session are required');
  const storage = safeStorage(options.safeStorage);
  if (!storage || !storage.isEncryptionAvailable()) {
    const err = new Error('ENCRYPTION_UNAVAILABLE: refusing to persist operator session without safeStorage');
    err.code = 'ENCRYPTION_UNAVAILABLE';
    throw err;
  }
  const dir = options.baseDir || path.join(process.cwd(), '.credentials_vault');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${companyId}.operator.enc`);
  const tempPath = `${filePath}.${Date.now()}.tmp`;
  const record = JSON.stringify({ companyId, encryptedToken: storage.encryptString(String(token)).toString('hex'), version: 1 });
  fs.writeFileSync(tempPath, record, 'utf8');
  fs.renameSync(tempPath, filePath);
  return true;
}

function readOperatorSession(companyId, options = {}) {
  if (!companyId) return null;
  const filePath = path.join(options.baseDir || path.join(process.cwd(), '.credentials_vault'), `${companyId}.operator.enc`);
  if (!fs.existsSync(filePath)) return null;
  const storage = safeStorage(options.safeStorage);
  if (!storage || !storage.isEncryptionAvailable()) {
    const err = new Error('ENCRYPTION_UNAVAILABLE: cannot decrypt operator session');
    err.code = 'ENCRYPTION_UNAVAILABLE';
    throw err;
  }
  try {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (record.companyId !== companyId || !record.encryptedToken) return null;
    return storage.decryptString(Buffer.from(record.encryptedToken, 'hex'));
  } catch (err) {
    if (err.code === 'ENCRYPTION_UNAVAILABLE') throw err;
    return null;
  }
}

function deleteOperatorSession(companyId, options = {}) {
  if (!companyId) return false;
  const filePath = path.join(options.baseDir || path.join(process.cwd(), '.credentials_vault'), `${companyId}.operator.enc`);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); return true; } catch { return false; }
}

module.exports = { storeOperatorSession, readOperatorSession, deleteOperatorSession };
