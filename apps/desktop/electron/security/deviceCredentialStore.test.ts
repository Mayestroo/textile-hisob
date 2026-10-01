import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Import CJS module under test
const {
  storeDeviceCredential,
  readDeviceCredential,
  deleteDeviceCredential,
  hasDeviceCredential,
  getCredentialFilePath
} = require('./deviceCredentialStore.cjs');

// Mock safeStorage implementation for Vitest/Node environment
function createMockSafeStorage(available = true) {
  const secretKey = crypto.createHash('sha256').update('mock-dpapi-key').digest();
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', secretKey, iv);
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, encrypted]);
    },
    decryptString: (encryptedBuffer: Buffer) => {
      const iv = encryptedBuffer.subarray(0, 16);
      const ciphertext = encryptedBuffer.subarray(16);
      const decipher = crypto.createDecipheriv('aes-256-cbc', secretKey, iv);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    }
  };
}

describe('DeviceCredentialStore Unit & Security Tests', () => {
  let testBaseDir: string;
  let mockSafeStorage: any;

  beforeEach(() => {
    testBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-cred-test-'));
    mockSafeStorage = createMockSafeStorage(true);
  });

  afterEach(() => {
    try {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  it('1. secure store round-trip persists and retrieves identical credential', () => {
    const companyId = 'comp_novda';
    const testSecret = 'novda_token_super_secret_998901234567_abc123';

    const stored = storeDeviceCredential(companyId, testSecret, {
      safeStorage: mockSafeStorage,
      baseDir: testBaseDir
    });
    expect(stored).toBe(true);

    const exists = hasDeviceCredential(companyId, { baseDir: testBaseDir });
    expect(exists).toBe(true);

    const retrieved = readDeviceCredential(companyId, {
      safeStorage: mockSafeStorage,
      baseDir: testBaseDir
    });
    expect(retrieved).toBe(testSecret);
  });

  it('2. plaintext token is strictly absent from backing file', () => {
    const companyId = 'comp_novda';
    const rawSecret = 'CSPRNG_SUPER_SECRET_TOKEN_DO_NOT_LEAK_INTO_FILE';

    storeDeviceCredential(companyId, rawSecret, {
      safeStorage: mockSafeStorage,
      baseDir: testBaseDir
    });

    const filePath = getCredentialFilePath(companyId, testBaseDir);
    expect(fs.existsSync(filePath)).toBe(true);

    const rawFileContent = fs.readFileSync(filePath, 'utf8');
    // Ensure raw token substring does NOT exist in plaintext inside file
    expect(rawFileContent).not.toContain(rawSecret);

    const parsed = JSON.parse(rawFileContent);
    expect(parsed.companyId).toBe(companyId);
    expect(parsed.credentialVersion).toBe(1);
    expect(parsed.encryptedCredential).toBeDefined();
    // Ciphertext must be valid hex and not plaintext
    expect(/^[0-9a-f]+$/i.test(parsed.encryptedCredential)).toBe(true);
    expect(parsed.encryptedCredential).not.toBe(rawSecret);
  });

  it('3. wrong company cannot read another company\'s token (company isolation)', () => {
    const compA = 'comp_novda';
    const compB = 'comp_other';
    const secretA = 'token_for_company_novda';

    storeDeviceCredential(compA, secretA, {
      safeStorage: mockSafeStorage,
      baseDir: testBaseDir
    });

    // compB must not be able to read compA's token
    const resultB = readDeviceCredential(compB, {
      safeStorage: mockSafeStorage,
      baseDir: testBaseDir
    });
    expect(resultB).toBeNull();
    expect(hasDeviceCredential(compB, { baseDir: testBaseDir })).toBe(false);
  });

  it('4. deletion/revocation cleanup removes stored token', () => {
    const companyId = 'comp_novda';
    const secret = 'token_to_be_revoked';

    storeDeviceCredential(companyId, secret, {
      safeStorage: mockSafeStorage,
      baseDir: testBaseDir
    });
    expect(hasDeviceCredential(companyId, { baseDir: testBaseDir })).toBe(true);

    const deleted = deleteDeviceCredential(companyId, { baseDir: testBaseDir });
    expect(deleted).toBe(true);
    expect(hasDeviceCredential(companyId, { baseDir: testBaseDir })).toBe(false);

    const afterDelete = readDeviceCredential(companyId, {
      safeStorage: mockSafeStorage,
      baseDir: testBaseDir
    });
    expect(afterDelete).toBeNull();
  });

  it('5. missing credential fails closed (returns null / false)', () => {
    const nonExistent = 'comp_nonexistent';
    expect(hasDeviceCredential(nonExistent, { baseDir: testBaseDir })).toBe(false);
    expect(readDeviceCredential(nonExistent, {
      safeStorage: mockSafeStorage,
      baseDir: testBaseDir
    })).toBeNull();
  });

  it('6. encryption unavailable fails closed (throws ENCRYPTION_UNAVAILABLE, no plaintext fallback)', () => {
    const unavailableStorage = createMockSafeStorage(false);
    const companyId = 'comp_novda';
    const secret = 'token_fails_closed';

    expect(() => {
      storeDeviceCredential(companyId, secret, {
        safeStorage: unavailableStorage,
        baseDir: testBaseDir
      });
    }).toThrowError(/ENCRYPTION_UNAVAILABLE/);

    // Verify backing file was NEVER created
    const filePath = getCredentialFilePath(companyId, testBaseDir);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('7. renderer API (preload.cjs) cannot retrieve arbitrary secrets', () => {
    // Read electron/preload.cjs source code
    const preloadPath = path.resolve(__dirname, '../preload.cjs');
    const preloadContent = fs.readFileSync(preloadPath, 'utf8');

    // Ensure renderer has no credential getter
    expect(preloadContent).not.toContain('readDeviceCredential');
    expect(preloadContent).not.toContain('getDeviceToken');
    expect(preloadContent).not.toContain('device-token');
    expect(preloadContent).not.toContain('safeStorage');
  });

  it('8. error messages and logging contain no bearer token', () => {
    const secretToken = 'ultra_secret_bearer_token_xyz987';
    const invalidCompany = '../malicious/traversal';

    try {
      storeDeviceCredential(invalidCompany, secretToken, {
        safeStorage: mockSafeStorage,
        baseDir: testBaseDir
      });
      expect.unreachable('Should have thrown security error');
    } catch (err: any) {
      expect(err.message).not.toContain(secretToken);
      expect(err.message).toContain('SECURITY_ERROR');
    }
  });
});
