import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';

const { verifyAdminWebSession } = require('../adminWebAuth.cjs');

const SECRET = 'test-session-secret-with-enough-entropy';
const TELEGRAM_ID = '274466315';
const NOW = 1_800_000_000;
const PYTHON_SESSION_FIXTURE = 'eyJleHAiOjE4MDAwMDA5MDAsImlhdCI6MTgwMDAwMDAwMCwibm9uY2UiOiIwMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW4iLCJzdWIiOiIyNzQ0NjYzMTUifQ.v9ncP3Iu4sCAb-1Uay5RJIcXNqpHs0vhYYMPdmHQZGQ';

function createSession({ sub = TELEGRAM_ID, iat = NOW, exp = NOW + 900, nonce = '0123456789abcdefghijklmn' } = {}) {
  const claims = { exp, iat, nonce, sub };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', SECRET).update(encoded, 'ascii').digest('base64url');
  return `${encoded}.${signature}`;
}

describe('verifyAdminWebSession', () => {
  it('accepts a valid signed session; company authorization is checked separately', () => {
    expect(verifyAdminWebSession(createSession(), SECRET, NOW)).toEqual({
      telegramId: TELEGRAM_ID,
      expiresAt: NOW + 900
    });
  });

  it('accepts the session encoding emitted by the Python  admin bot', () => {
    expect(verifyAdminWebSession(PYTHON_SESSION_FIXTURE, SECRET, NOW)).toEqual({
      telegramId: TELEGRAM_ID,
      expiresAt: NOW + 900
    });
  });

  it('rejects an expired session', () => {
    expect(() => verifyAdminWebSession(createSession(), SECRET, NOW + 900))
      .toThrowError(expect.objectContaining({ code: 'ADMIN_SESSION_EXPIRED' }));
  });

  it('rejects tampering and malformed claims', () => {
    const token = createSession();
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(() => verifyAdminWebSession(tampered, SECRET, NOW))
      .toThrowError(expect.objectContaining({ code: 'ADMIN_SESSION_INVALID' }));

    const encoded = Buffer.from(JSON.stringify({ exp: NOW + 900, iat: NOW, nonce: 'too-short', sub: TELEGRAM_ID }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(encoded, 'ascii').digest('base64url');
    expect(() => verifyAdminWebSession(`${encoded}.${signature}`, SECRET, NOW))
      .toThrowError(expect.objectContaining({ code: 'ADMIN_SESSION_INVALID' }));
  });

  it('rejects future issue times', () => {
    expect(() => verifyAdminWebSession(createSession({ iat: NOW + 61, exp: NOW + 961 }), SECRET, NOW))
      .toThrowError(expect.objectContaining({ code: 'ADMIN_SESSION_INVALID' }));
  });

  it('rejects missing, short, and oversized credentials', () => {
    expect(() => verifyAdminWebSession('', SECRET, NOW)).toThrow();
    expect(() => verifyAdminWebSession(createSession(), 'short', NOW)).toThrow();
    expect(() => verifyAdminWebSession(`${createSession()}${'x'.repeat(4096)}`, SECRET, NOW)).toThrow();
  });
});
