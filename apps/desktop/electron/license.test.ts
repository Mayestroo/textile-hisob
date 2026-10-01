import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const license = require('./license.cjs');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const requestTokenStorage = {
  encryptActivationRequestToken: (token: string) => Buffer.from(`test:${token}`).toString('hex'),
  decryptActivationRequestToken: (ciphertext: string) => Buffer.from(ciphertext, 'hex').toString('utf8').slice(5)
};

function record(overrides: Record<string, unknown> = {}, key = privateKey) {
  const payload = {
    activationId: '11111111-1111-4111-8111-111111111111', companyId: 'company-a', companyName: 'Company A', expiresAt: null,
    issuedAt: '2026-09-21T12:00:00.000Z', machineId: 'A588-F0E4-DE9A-59A2', requireTicketValidation: true,
    role: 'admin', schema: 'novda-license-v1', status: 'active', ...overrides
  };
  const signature = crypto.sign(null, Buffer.from(license.canonicalActivationPayload(payload)), key).toString('base64');
  return { payload, signature };
}

describe('Ed25519 license verification', () => {
  let userData: string;
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-license-'));
  });
  afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

  it('uses the pinned public-key fingerprint', () => {
    const publicKey = require('../../../packages/contracts/keys/licensePublicKey.cjs').NOVDA_LICENSE_ED25519_PUBLIC_KEY;
    const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    expect(`sha256:${crypto.createHash('sha256').update(der).digest('hex')}`).toBe(
      'sha256:8b563c50537fc5b44852626f8da69bb69c1ce4a72d3dec3ae0af20a557bf314c'
    );
    const apiSigner = require('../../../apps/server/modules/activation/licenseActivation.cjs');
    expect(apiSigner.publicKeyFingerprint()).toBe('8b563c50537fc5b44852626f8da69bb69c1ce4a72d3dec3ae0af20a557bf314c');
    expect(apiSigner.getPinnedPublicKey()).toBe(publicKey);
  });

  it('accepts a signed company and role without an HMAC environment variable', () => {
    const result = license.verifyActivationRecord('A588-F0E4-DE9A-59A2', record(), publicPem);
    expect(result).toMatchObject({ valid: true, payload: { companyId: 'company-a', role: 'admin' } });
  });

  it.each(['machineId', 'companyId', 'role', 'issuedAt', 'expiresAt', 'requireTicketValidation'])('rejects a modified signed %s', (field) => {
    const signed = record();
    const changed = { ...signed, payload: { ...signed.payload, [field]: field === 'requireTicketValidation' ? false : 'changed' } };
    expect(license.verifyActivationRecord('A588-F0E4-DE9A-59A2', changed, publicPem).valid).toBe(false);
  });

  it('rejects malformed, missing, and wrong-key signatures', () => {
    expect(license.verifyActivationRecord('A588-F0E4-DE9A-59A2', { payload: record().payload, signature: 'not-a-signature' }, publicPem).valid).toBe(false);
    expect(license.verifyActivationRecord('A588-F0E4-DE9A-59A2', { payload: record().payload }, publicPem).valid).toBe(false);
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(license.verifyActivationRecord('A588-F0E4-DE9A-59A2', record(), other).valid).toBe(false);
  });

  it('rejects non-canonical signatures and payloads with unsigned extra fields', () => {
    const signed = record();
    expect(license.verifyActivationRecord('A588-F0E4-DE9A-59A2', {
      ...signed,
      signature: `${signed.signature}\n`
    }, publicPem).valid).toBe(false);
    expect(license.verifyActivationRecord('A588-F0E4-DE9A-59A2', {
      ...signed,
      payload: { ...signed.payload, isLifetime: true }
    }, publicPem).valid).toBe(false);
  });

  it('rejects licenses whose expiry is not after issuance', () => {
    const issuedAt = '2026-09-21T12:00:00.000Z';
    expect(license.verifyActivationRecord('A588-F0E4-DE9A-59A2', record({
      issuedAt,
      expiresAt: issuedAt
    }), publicPem).valid).toBe(false);
  });

  it('fails closed when company or role is missing', () => {
    expect(license.verifyActivationRecord('A588-F0E4-DE9A-59A2', record({ companyId: '' }), publicPem).valid).toBe(false);
    expect(license.verifyActivationRecord('A588-F0E4-DE9A-59A2', record({ role: '' }), publicPem).valid).toBe(false);
  });

  it('persists only the verified signed identity and survives restart', () => {
    fs.writeFileSync(path.join(userData, 'license.lic'), JSON.stringify({ payload: { companyId: 'company-b', role: 'print' } }));
    expect(license.persistVerifiedActivation(userData, 'A588-F0E4-DE9A-59A2', record(), publicPem)).toMatchObject({ success: true });
    const persisted = JSON.parse(fs.readFileSync(path.join(userData, 'license.lic'), 'utf8'));
    expect(persisted.payload).toMatchObject({ companyId: 'company-a', role: 'admin' });
    expect(license.verifyActivationRecord('A588-F0E4-DE9A-59A2', persisted, publicPem).valid).toBe(true);
  });

  it('does not accept legacy manually-entered HMAC keys', () => {
    const result = license.saveLicense(userData, 'ACT-ADMIN-A588-1234-5678');
    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/HMAC/i);
  });

  it('rejects a signed revocation from local activation persistence', () => {
    expect(license.persistVerifiedActivation(userData, 'A588-F0E4-DE9A-59A2', record({ status: 'revoked' }), publicPem)).toMatchObject({ success: false });
  });

  it('creates a persistent  activation request and polls using only its request credential', async () => {
    const machineId = license.getHardwareId();
    const calls: Array<{ url: URL; options: any }> = [];
    const requestJson = async (url: URL, options: any = {}) => {
      calls.push({ url, options });
      if (options.method === 'POST') {
        return { success: true, request: { requestId: options.body.requestId, status: 'PENDING' } };
      }
      return { success: true, request: { requestId: url.pathname.split('/').pop(), status: 'PENDING', activation: null } };
    };

    const first = await license.checkRemoteActivation(userData, {
      baseUrl: 'https://sync.novdatextile.uz',
      requestJson,
      ...requestTokenStorage
    });
    expect(first).toMatchObject({ isActivated: false, machineId });
    expect(calls.map((call) => call.options.method || 'GET')).toEqual(['POST', 'GET']);
    expect(calls[0].url.pathname).toBe('/api/activation/requests');
    expect(calls[1].url.pathname).toMatch(/^\/api\/activation\/requests\/[0-9a-f-]{36}$/i);
    expect(calls[0].options.body).toMatchObject({ machineId, context: { platform: process.platform } });

    const requestFile = license.activationRequestFilePath(userData, machineId);
    const persistedRequest = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    expect(persistedRequest.requestToken).toBeUndefined();
    expect(persistedRequest.requestTokenCiphertext).toMatch(/^[a-f0-9]+$/);
    expect(Buffer.from(persistedRequest.requestTokenCiphertext, 'hex').toString('utf8'))
      .toBe(`test:${calls[0].options.body.requestToken}`);
    expect(persistedRequest.requestId).toBe(calls[0].options.body.requestId);
    const requestToken = calls[0].options.body.requestToken;

    calls.length = 0;
    await license.checkRemoteActivation(userData, {
      baseUrl: 'https://sync.novdatextile.uz', requestJson, ...requestTokenStorage
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.headers).toMatchObject({
      'x-activation-request-token': requestToken,
      'x-machine-id': machineId
    });
  });

  it('hands the approved activation request credential to OS-protected  device storage', async () => {
    const machineId = license.getHardwareId();
    const captured: any[] = [];
    const requestToken = 'a'.repeat(64);
    const signedActivation = record({ machineId });
    const requestJson = async (url: URL, options: any = {}) => {
      captured.push({ url, options });
      if (options.method === 'POST') {
        return { success: true, request: { requestId: options.body.requestId, status: 'PENDING' } };
      }
      return {
        success: true,
        request: {
          requestId: url.pathname.split('/').pop(),
          status: 'APPROVED',
          activation: signedActivation
        }
      };
    };
    const storeCalls: any[] = [];
    const storedCredentials = new Map<string, string>();

    const status = await license.checkRemoteActivation(userData, {
      baseUrl: 'https://sync.novdatextile.uz',
      requestJson,
      publicKey: publicPem,
      ...requestTokenStorage,
      storeDeviceCredential: (companyId: string, token: string, options: any) => {
        storeCalls.push({ companyId, token, options });
        storedCredentials.set(companyId, token);
        return true;
      },
      readDeviceCredential: (companyId: string) => storedCredentials.get(companyId) || null
    });

    expect(status).toMatchObject({ isActivated: true, companyId: 'company-a', deviceCredentialReady: true });
    expect(storeCalls).toEqual([{
      companyId: 'company-a',
      token: captured[0].options.body.requestToken,
      options: { deviceId: machineId }
    }]);
    expect(storeCalls[0].token).toMatch(/^[a-f0-9]{64}$/);

    const requestFile = license.activationRequestFilePath(userData, machineId);
    const persistedRequest = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    expect(persistedRequest.requestToken).toBeUndefined();
    expect(persistedRequest.credentialCompanyId).toBe('company-a');
    expect(fs.readFileSync(path.join(userData, 'license.lic'), 'utf8')).not.toContain(storeCalls[0].token);

    captured.length = 0;
    await license.checkRemoteActivation(userData, {
      baseUrl: 'https://sync.novdatextile.uz',
      requestJson,
      publicKey: publicPem,
      storeDeviceCredential: (companyId: string, token: string) => storedCredentials.set(companyId, token),
      readDeviceCredential: (companyId: string) => storedCredentials.get(companyId) || null
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].options.headers['x-activation-request-token']).toBe(storeCalls[0].token);
  });

  it('refreshes an existing device activation from the server after its company validation policy changes', async () => {
    const machineId = license.getHardwareId();
    const requestToken = 'c'.repeat(64);
    const storedCredentials = new Map<string, string>();
    let currentActivation = record({ machineId, requireTicketValidation: true });
    const requestJson = async (url: URL, options: any = {}) => {
      if (options.method === 'POST') {
        return { success: true, request: { requestId: options.body.requestId, status: 'PENDING' } };
      }
      return {
        success: true,
        request: {
          requestId: url.pathname.split('/').pop(),
          status: 'APPROVED',
          activation: currentActivation
        }
      };
    };
    const credentialOptions = {
      baseUrl: 'https://sync.novdatextile.uz', requestJson, publicKey: publicPem,
      ...requestTokenStorage,
      storeDeviceCredential: (companyId: string, token: string) => { storedCredentials.set(companyId, token); },
      readDeviceCredential: (companyId: string) => storedCredentials.get(companyId) || requestToken
    };

    const first = await license.checkRemoteActivation(userData, credentialOptions);
    expect(first.requireTicketValidation).toBe(true);
    currentActivation = record({
      machineId,
      requireTicketValidation: false,
      issuedAt: new Date(Date.now() + 1000).toISOString()
    });
    const refreshed = await license.checkRemoteActivation(userData, credentialOptions);

    expect(refreshed).toMatchObject({ isActivated: true, requireTicketValidation: false });
    expect(license.checkLicenseStatus(userData, publicPem).requireTicketValidation).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'license.lic'), 'utf8')).payload.requireTicketValidation).toBe(false);
  });

  it('keeps  readiness blocked and retains the request secret if OS credential encryption fails', async () => {
    const machineId = license.getHardwareId();
    const signedActivation = record({ machineId });
    const requestJson = async (url: URL, options: any = {}) => options.method === 'POST'
      ? { success: true, request: { requestId: options.body.requestId, status: 'PENDING' } }
      : { success: true, request: { requestId: url.pathname.split('/').pop(), status: 'APPROVED', activation: signedActivation } };

    const status = await license.checkRemoteActivation(userData, {
      baseUrl: 'https://sync.novdatextile.uz',
      requestJson,
      publicKey: publicPem,
      ...requestTokenStorage,
      storeDeviceCredential: () => { throw Object.assign(new Error('blocked'), { code: 'ENCRYPTION_UNAVAILABLE' }); }
    });

    expect(status).toMatchObject({ isActivated: true, deviceCredentialReady: false, deviceCredentialError: 'ENCRYPTION_UNAVAILABLE' });
    const persistedRequest = JSON.parse(fs.readFileSync(license.activationRequestFilePath(userData, machineId), 'utf8'));
    expect(persistedRequest.requestToken).toBeUndefined();
    expect(Buffer.from(persistedRequest.requestTokenCiphertext, 'hex').toString('utf8')).toMatch(/^test:[a-f0-9]{64}$/);
  });

  it('requires HTTPS for the configured activation API', async () => {
    const requestJson = vi.fn();
    const result = await license.checkRemoteActivation(userData, {
      baseUrl: 'http://sync.novdatextile.uz',
      requestJson,
      ...requestTokenStorage
    });
    expect(requestJson).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isActivated: false, machineId: license.getHardwareId() });
    expect(result.message).toContain('TLS');
  });
});
