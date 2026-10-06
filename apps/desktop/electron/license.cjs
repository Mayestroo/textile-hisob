const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');
const { DEFAULT__API_BASE_URL, resolveApiBaseUrl } = require('./apiConfig.cjs');
const { authorizationUnavailable } = require('./licenseBoundary.cjs');
const {
  NOVDA_LICENSE_ED25519_PUBLIC_KEY,
  NOVDA_LEGACY_LICENSE_ED25519_PUBLIC_KEY
} = require('../../../packages/contracts/keys/licensePublicKey.cjs');
const DEFAULT_LICENSE_VERIFICATION_KEYS = Object.freeze([
  NOVDA_LICENSE_ED25519_PUBLIC_KEY,
  NOVDA_LEGACY_LICENSE_ED25519_PUBLIC_KEY
]);
const {
  storeDeviceCredential,
  readDeviceCredential,
  deleteDeviceCredential
} = require('./security/deviceCredentialStore.cjs');

const LICENSE_SCHEMA = 'novda-license-v1';
const VALID_ROLES = new Set(['admin', 'type', 'print']);
const DEFAULT_ACTIVATION_API_URL = DEFAULT__API_BASE_URL;

let APP_VERSION = '1.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf-8'));
  APP_VERSION = pkg.version || APP_VERSION;
} catch {}

function getHardwareId() {
  let raw = '';
  if (process.platform === 'win32') {
    try {
      const output = execSync('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      const match = output.match(/MachineGuid\s+REG_SZ\s+([a-fA-F0-9\-]+)/);
      if (match?.[1]) raw += match[1].trim();
    } catch {}
    try {
      const output = execSync('wmic bios get serialnumber', { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      const serial = output.split('\n').map((line) => line.trim()).find((line) => line && !line.toLowerCase().includes('serialnumber'));
      if (serial) raw += `_${serial}`;
    } catch {}
  }
  const cpu = os.cpus()?.[0]?.model || 'CPU';
  raw += `_${cpu}_${os.hostname()}_${os.userInfo?.().username || 'user'}_hardware_id_seed`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  return `${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}`;
}

function isValidCompanyId(companyId) {
  return typeof companyId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(companyId) && companyId !== 'unassigned';
}

function canonicalActivationPayload(payload) {
  return JSON.stringify({
    activationId: payload.activationId,
    companyId: payload.companyId,
    companyName: payload.companyName,
    expiresAt: payload.expiresAt,
    issuedAt: payload.issuedAt,
    machineId: payload.machineId,
    requireTicketValidation: payload.requireTicketValidation,
    role: payload.role,
    schema: payload.schema,
    status: payload.status
  });
}

function isIsoDate(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function validateActivationPayload(payload, machineId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.schema !== LICENSE_SCHEMA) return 'Litsenziya sxemasi noto\'g\'ri';
  const expectedFields = ['activationId', 'companyId', 'companyName', 'expiresAt', 'issuedAt', 'machineId', 'requireTicketValidation', 'role', 'schema', 'status'].sort();
  const actualFields = Object.keys(payload).sort();
  if (actualFields.length !== expectedFields.length || actualFields.some((field, index) => field !== expectedFields[index])) return 'Litsenziya maydonlari noto\'g\'ri';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.activationId || '')) return 'Litsenziya identifikatori noto\'g\'ri';
  if (payload.machineId !== machineId) return 'Litsenziya boshqa qurilma uchun berilgan';
  if (typeof payload.machineId !== 'string' || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(payload.machineId)) return 'Qurilma identifikatori noto\'g\'ri';
  if (!isValidCompanyId(payload.companyId)) return 'Tasdiqlangan litsenziyada korxona biriktirilmagan';
  if (typeof payload.companyName !== 'string' || !payload.companyName.trim() || payload.companyName.length > 160) return 'Tasdiqlangan litsenziyada korxona nomi yo\'q';
  if (!VALID_ROLES.has(payload.role)) return 'Tasdiqlangan litsenziyada rol noto\'g\'ri';
  if (!isIsoDate(payload.issuedAt)) return 'Litsenziya berilgan vaqti noto\'g\'ri';
  if (payload.expiresAt !== null && (!isIsoDate(payload.expiresAt) || Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt))) return 'Litsenziya muddati noto\'g\'ri';
  if (payload.expiresAt && Date.parse(payload.expiresAt) < Date.now()) return 'Litsenziya muddati tugagan';
  if (typeof payload.requireTicketValidation !== 'boolean') return 'Litsenziya siyosati noto\'g\'ri';
  if (payload.status !== 'active' && payload.status !== 'revoked') return 'Litsenziya holati noto\'g\'ri';
  return null;
}

function verifyActivationRecord(machineId, record, publicKey) {
  const activation = record?.activation || record;
  const payload = activation?.payload;
  const signature = activation?.signature;
  const validationError = validateActivationPayload(payload, machineId);
  if (validationError) return { valid: false, reason: validationError };
  if (typeof signature !== 'string' || !signature) return { valid: false, reason: 'Litsenziya imzosi yo\'q' };
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return { valid: false, reason: 'Litsenziya imzosi noto\'g\'ri' };
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature) throw new Error('invalid');
  } catch {
    return { valid: false, reason: 'Litsenziya imzosi noto\'g\'ri' };
  }
  const verificationKeys = publicKey === undefined ? DEFAULT_LICENSE_VERIFICATION_KEYS : [publicKey];
  for (const candidateKey of verificationKeys) {
    try {
      if (crypto.verify(null, Buffer.from(canonicalActivationPayload(payload), 'utf8'), candidateKey, signatureBytes)) {
        return { valid: true, payload, signature };
      }
    } catch {}
  }
  return { valid: false, reason: 'Litsenziya imzosi tasdiqlanmadi' };
}

function getLicenseFilePath(userDataDir) {
  return path.join(userDataDir, 'license.lic');
}

function persistVerifiedActivation(userDataDir, machineId, record, publicKey) {
  const verified = verifyActivationRecord(machineId, record, publicKey);
  if (!verified.valid) return { success: false, error: verified.reason };
  if (verified.payload.status !== 'active') return { success: false, error: 'Litsenziya faol emas yoki bekor qilingan' };
  const data = { payload: verified.payload, signature: verified.signature, persistedAt: new Date().toISOString() };
  const target = getLicenseFilePath(userDataDir);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    return { success: true, licenseInfo: verified.payload };
  } catch (err) {
    try { fs.unlinkSync(temp); } catch {}
    return { success: false, error: `Litsenziyani saqlashda xatolik: ${err.message}` };
  }
}

function pendingStatus(machineId, message = 'Administrator tasdig\'i kutilmoqda') {
  return { isActivated: false, isTrial: false, isTrialExpired: false, isBlocked: false, machineId, role: null, companyId: null, companyName: null, isCompanyAssigned: false, requireTicketValidation: true, message };
}

function statusFromVerified(verified, machineId) {
  const payload = verified.payload;
  return { isActivated: true, isTrial: false, isBlocked: false, machineId, role: payload.role, companyId: payload.companyId, companyName: payload.companyName, isCompanyAssigned: true, requireTicketValidation: payload.requireTicketValidation, expiry: payload.expiresAt || 'LIFETIME', isLifetime: payload.expiresAt === null, activatedAt: payload.issuedAt, activationId: payload.activationId, message: 'Imzolangan litsenziya faol' };
}

function checkLicenseStatus(userDataDir, publicKey) {
  const machineId = getHardwareId();
  try {
    const data = JSON.parse(fs.readFileSync(getLicenseFilePath(userDataDir), 'utf8'));
    const verified = verifyActivationRecord(machineId, data, publicKey);
    if (verified.valid && verified.payload.status === 'active') return statusFromVerified(verified, machineId);
    if (verified.valid && verified.payload.status === 'revoked') return pendingStatus(machineId, 'Litsenziya administrator tomonidan bekor qilingan');
  } catch {}
  return pendingStatus(machineId);
}

function activationRequestFilePath(userDataDir, machineId) {
  const safeMachineId = String(machineId).replace(/[^A-F0-9-]/g, '_');
  return path.join(userDataDir, `activation-request-${safeMachineId}.json`);
}

function encryptActivationRequestToken(value, options = {}) {
  if (typeof options.encryptActivationRequestToken === 'function') {
    return options.encryptActivationRequestToken(value);
  }
  let safeStorage;
  try { safeStorage = require('electron').safeStorage; } catch {}
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    const error = new Error('OS-backed activation credential encryption is unavailable');
    error.code = 'ENCRYPTION_UNAVAILABLE';
    throw error;
  }
  return safeStorage.encryptString(value).toString('hex');
}

function decryptActivationRequestToken(value, options = {}) {
  if (typeof options.decryptActivationRequestToken === 'function') {
    return options.decryptActivationRequestToken(value);
  }
  let safeStorage;
  try { safeStorage = require('electron').safeStorage; } catch {}
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    const error = new Error('OS-backed activation credential encryption is unavailable');
    error.code = 'ENCRYPTION_UNAVAILABLE';
    throw error;
  }
  return safeStorage.decryptString(Buffer.from(value, 'hex'));
}

function loadOrCreateActivationRequest(userDataDir, machineId, options = {}) {
  const filePath = activationRequestFilePath(userDataDir, machineId);
  try {
    const storedState = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const encryptedToken = storedState.requestTokenCiphertext;
    let requestToken = storedState.requestToken || '';
    if (!requestToken && typeof encryptedToken === 'string' && /^[a-f0-9]+$/i.test(encryptedToken)) {
      requestToken = decryptActivationRequestToken(encryptedToken, options);
    }
    const state = { ...storedState, requestToken: requestToken || null };
    if (state.machineId !== machineId
      || typeof state.requestId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(state.requestId)
      || (state.requestToken !== null && state.requestToken !== undefined
        && (typeof state.requestToken !== 'string' || !/^[a-f0-9]{64}$/.test(state.requestToken)))
      || (state.requestTokenCiphertext !== undefined
        && (typeof state.requestTokenCiphertext !== 'string' || !/^[a-f0-9]+$/i.test(state.requestTokenCiphertext)))
      || (state.credentialCompanyId !== undefined && !isValidCompanyId(state.credentialCompanyId))) {
      throw new Error('Activation request state is invalid');
    }
    if (state.requestToken && !state.requestTokenCiphertext) saveActivationRequestState(filePath, state, options);
    return { filePath, state };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const state = {
    requestId: crypto.randomUUID(),
    requestToken: crypto.randomBytes(32).toString('hex'),
    machineId,
    createdAt: new Date().toISOString(),
    lastSubmittedAt: null
  };
  try {
    saveActivationRequestState(filePath, state, options);
    return { filePath, state };
  } catch (error) {
    throw error;
  }
}

function saveActivationRequestState(filePath, state, options = {}) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const safeState = { ...state };
    const requestToken = safeState.requestToken;
    delete safeState.requestToken;
    delete safeState.requestTokenCiphertext;
    if (typeof requestToken === 'string' && requestToken) {
      safeState.requestTokenCiphertext = encryptActivationRequestToken(requestToken, options);
    }
    fs.writeFileSync(tempPath, JSON.stringify(safeState), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function activationApiUrl(baseUrl, pathname, allowHttp = false) {
  let base;
  try { base = new URL(baseUrl); } catch {
    const error = new Error('ACTIVATION_API_URL_INVALID');
    error.code = 'ACTIVATION_API_URL_INVALID';
    throw error;
  }
  if (base.protocol !== 'https:' && !(allowHttp && base.protocol === 'http:')) {
    const error = new Error('ACTIVATION_TLS_REQUIRED');
    error.code = 'ACTIVATION_TLS_REQUIRED';
    throw error;
  }
  return new URL(pathname, base);
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const request = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers,
      timeout: options.timeoutMs || 5000
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 64 * 1024) {
          request.destroy(new Error('ACTIVATION_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reject(new Error('ACTIVATION_RESPONSE_INVALID')); }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(parsed?.error?.message || 'Activation API request failed');
          error.code = parsed?.error?.code || `ACTIVATION_API_HTTP_${response.statusCode}`;
          error.statusCode = response.statusCode;
          return reject(error);
        }
        resolve(parsed);
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('ACTIVATION_API_TIMEOUT')));
    if (body !== null) request.write(body);
    request.end();
  });
}

async function checkRemoteActivation(userDataDir, options = {}) {
  const machineId = getHardwareId();
  const localStatus = checkLicenseStatus(userDataDir, options.publicKey);
  try {
    const baseUrl = resolveApiBaseUrl({
      baseUrl: options.baseUrl || process.env.NOVDA_SYNC_SERVER_URL || DEFAULT_ACTIVATION_API_URL,
      allowHttp: options.allowHttp === true
    });
    if (!baseUrl) {
      const error = new Error('PUBLIC_ACTIVATION_API_URL_NOT_CONFIGURED');
      error.code = 'PUBLIC_ACTIVATION_API_URL_NOT_CONFIGURED';
      throw error;
    }
    const allowHttp = options.allowHttp === true;
    const send = options.requestJson || requestJson;
    const { filePath, state } = loadOrCreateActivationRequest(userDataDir, machineId, options);
    const readCredential = options.readDeviceCredential || readDeviceCredential;
    let requestToken = state.requestToken || '';
    if (!requestToken) {
      const credentialCompanyId = localStatus.companyId || state.credentialCompanyId;
      if (isValidCompanyId(credentialCompanyId)) {
        requestToken = readCredential(credentialCompanyId) || '';
      }
    }
    if (!requestToken) {
      return localStatus.isActivated
        ? { ...localStatus, deviceCredentialReady: false, deviceCredentialError: 'DEVICE_CREDENTIAL_UNAVAILABLE' }
        : pendingStatus(machineId, 'Aktivatsiya so‘rovi qurilmada saqlangan; xavfsiz  hisob maʼlumotlari mavjud emas');
    }
    const now = Date.now();
    const lastSubmitted = state.lastSubmittedAt ? Date.parse(state.lastSubmittedAt) : 0;
    if (!Number.isFinite(lastSubmitted) || now - lastSubmitted > 5 * 60 * 1000) {
      const postUrl = activationApiUrl(baseUrl, '/api/activation/requests', allowHttp);
      await send(postUrl, {
        method: 'POST',
        body: {
          requestId: state.requestId,
          requestToken,
          machineId,
          context: { appVersion: APP_VERSION, platform: process.platform }
        }
      });
      state.lastSubmittedAt = new Date().toISOString();
      saveActivationRequestState(filePath, state, options);
    }

    const statusUrl = activationApiUrl(baseUrl, `/api/activation/requests/${encodeURIComponent(state.requestId)}`, allowHttp);
    const response = await send(statusUrl, {
      headers: {
        'x-activation-request-token': requestToken,
        'x-machine-id': machineId
      }
    });
    const request = response?.request;
    if (!request || request.requestId !== state.requestId) return localStatus.isActivated ? localStatus : pendingStatus(machineId, 'Aktivatsiya holatini aniqlab bo‘lmadi');

    if (request.status === 'APPROVED') {
      const persisted = persistVerifiedActivation(userDataDir, machineId, request.activation, options.publicKey);
      if (!persisted.success) return localStatus.isActivated ? localStatus : pendingStatus(machineId, persisted.error);
      const activationStatus = checkLicenseStatus(userDataDir, options.publicKey);
      try {
        const saveCredential = options.storeDeviceCredential || storeDeviceCredential;
        saveCredential(activationStatus.companyId, requestToken, { deviceId: machineId });
        saveActivationRequestState(filePath, {
          ...state,
          requestToken: null,
          credentialCompanyId: activationStatus.companyId
        }, options);
        return { ...activationStatus, deviceCredentialReady: true };
      } catch (error) {
        return {
          ...activationStatus,
          deviceCredentialReady: false,
          deviceCredentialError: error?.code || 'DEVICE_CREDENTIAL_STORAGE_FAILED'
        };
      }
    }
    if (request.status === 'REVOKED') {
      const revoked = verifyActivationRecord(machineId, request.activation);
      if (revoked.valid && revoked.payload.status === 'revoked') {
        if (localStatus.companyId) {
          try { (options.deleteDeviceCredential || deleteDeviceCredential)(localStatus.companyId); } catch {}
        }
        try { fs.unlinkSync(getLicenseFilePath(userDataDir)); } catch {}
        try { fs.unlinkSync(filePath); } catch {}
        return pendingStatus(machineId, 'Litsenziya administrator tomonidan bekor qilingan');
      }
      return localStatus.isActivated ? localStatus : pendingStatus(machineId, 'Bekor qilish yozuvi imzo tekshiruvidan o‘tmadi');
    }
    if (request.status === 'REJECTED') {
      return localStatus.isActivated ? localStatus : {
        ...pendingStatus(machineId, request.rejectionReason || 'Aktivatsiya so‘rovi rad etildi'),
        activationRequestStatus: 'REJECTED',
        activationRequestId: request.requestId
      };
    }
    return localStatus.isActivated ? localStatus : {
      ...pendingStatus(machineId, 'Administrator tasdig‘i kutilmoqda'),
      activationRequestStatus: 'PENDING',
      activationRequestId: request.requestId
    };
  } catch (error) {
    return localStatus.isActivated ? localStatus : pendingStatus(machineId, error?.code === 'MACHINE_ALREADY_ACTIVATED'
      ? 'Bu PC uchun VPS tasdig‘i boshqa so‘rovda mavjud. Telegram administratoridan ushbu qurilma so‘rovini tekshirishni so‘rang.'
      : error?.code === 'ACTIVATION_TLS_REQUIRED' || error?.code === 'SYNC_SERVER_TLS_REQUIRED'
      ? 'Aktivatsiya uchun xavfsiz TLS ulanishi talab qilinadi'
      : error?.code === 'PUBLIC_ACTIVATION_API_URL_NOT_CONFIGURED'
      ? 'Ommaviy HTTPS server manzili sozlanmagan'
      : 'Aktivatsiya serveriga ulanib bo‘lmadi; so‘rov qurilmada xavfsiz saqlanib qayta urinadi');
  }
}

async function requestNewActivation(userDataDir, options = {}) {
  const current = await checkRemoteActivation(userDataDir, options);
  if (current.isActivated) return { success: false, error: 'ACTIVATION_ALREADY_ACTIVE', status: current };
  if (current.activationRequestStatus !== 'REJECTED') {
    return { success: false, error: 'ACTIVATION_RESUBMIT_REQUIRES_REJECTION', status: current };
  }
  try {
    fs.unlinkSync(activationRequestFilePath(userDataDir, current.machineId));
  } catch (error) {
    if (error?.code !== 'ENOENT') return { success: false, error: 'ACTIVATION_REQUEST_RESET_FAILED', status: current };
  }
  const status = await checkRemoteActivation(userDataDir, options);
  return {
    success: status.activationRequestStatus === 'PENDING',
    error: status.activationRequestStatus === 'PENDING' ? undefined : 'ACTIVATION_REQUEST_CREATE_FAILED',
    status
  };
}

function saveLicense() {
  return { success: false, error: 'Qo\'lda kiritilgan eski litsenziya kalitlari qabul qilinmaydi. Telegram admin tasdig\'ini kuting.' };
}

function setLicenseCompany() { return authorizationUnavailable('company assignment'); }
function setLicenseValidation() { return authorizationUnavailable('license settings'); }

module.exports = {
  getHardwareId,
  canonicalActivationPayload,
  verifyActivationRecord,
  persistVerifiedActivation,
  checkLicenseStatus,
  checkRemoteActivation,
  requestNewActivation,
  activationRequestFilePath,
  loadOrCreateActivationRequest,
  activationApiUrl,
  requestJson,
  saveLicense,
  setLicenseCompany,
  setLicenseValidation,
  LICENSE_SCHEMA,
  DEFAULT_ACTIVATION_API_URL
};
