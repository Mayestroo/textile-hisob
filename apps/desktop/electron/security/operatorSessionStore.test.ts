import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const store = require('./operatorSessionStore.cjs');

function safeStorage() {
  const key = crypto.createHash('sha256').update('operator-store-test').digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value.split('').reverse().join(''), 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').split('').reverse().join('')
  };
}

describe('operator session Main-process storage', () => {
  it('stores encrypted ciphertext only and round-trips in Main', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-operator-'));
    const token = 'a'.repeat(64);
    store.storeOperatorSession('co-1', token, { baseDir, safeStorage: safeStorage() });
    const raw = fs.readFileSync(path.join(baseDir, 'co-1.operator.enc'), 'utf8');
    expect(raw).not.toContain(token);
    expect(store.readOperatorSession('co-1', { baseDir, safeStorage: safeStorage() })).toBe(token);
    expect(store.deleteOperatorSession('co-1', { baseDir })).toBe(true);
  });
});
