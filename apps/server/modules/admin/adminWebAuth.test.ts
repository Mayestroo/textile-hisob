import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';

const { verifyAdminWebSession } = require('./adminWebAuth.cjs');

const SECRET = 'test-session-secret-with-enough-entropy';
const TELEGRAM_ID = '1526974123';
const NOW = 1_800_000_000;
const PYTHON_SESSION_FIXTURE = 'eyJleHAiOjE4MDAwMDA5MDAsImlhdCI6MTgwMDAwMDAwMCwibm9uY2UiOiIwMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW4iLCJzdWIiOiIxNTI2OTc0MTIzIn0.Flm2YbufUhxd9saAtRVYQQfeS0yLMgHoHOA78xD0kfY';

function createSession({ sub = TELEGRAM_ID, iat = NOW, exp = NOW + 900, nonce = '0123456789abcdefghijklmn' } = {}) {
  const claims = { exp, iat, nonce, sub };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', SECRET).update(encoded, 'ascii').digest('base64url');
  return `${encoded}.${signature}`;
}

describe('verifyAdminWebSession', () => {
  it('accepts a valid signed session for a currently allowlisted admin', () => {
    expect(verifyAdminWebSession(createSession(), SECRET, new Set([TELEGRAM_ID]), NOW)).toEqual({
      telegramId: TELEGRAM_ID,
      expiresAt: NOW + 900
    });
  });

  it('accepts the session encoding emitted by the Python  admin bot', () => {
    expect(verifyAdminWebSession(PYTHON_SESSION_FIXTURE, SECRET, [TELEGRAM_ID], NOW)).toEqual({
      telegramId: TELEGRAM_ID,
      expiresAt: NOW + 900
    });
  });

  it('rejects an expired session', () => {
    expect(() => verifyAdminWebSession(createSession(), SECRET, [TELEGRAM_ID], NOW + 900))
      .toThrowError(expect.objectContaining({ code: 'ADMIN_SESSION_EXPIRED' }));
  });

  it('rejects tampering and malformed claims', () => {
    const token = createSession();
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(() => verifyAdminWebSession(tampered, SECRET, [TELEGRAM_ID], NOW))
      .toThrowError(expect.objectContaining({ code: 'ADMIN_SESSION_INVALID' }));

    const encoded = Buffer.from(JSON.stringify({ exp: NOW + 900, iat: NOW, nonce: 'too-short', sub: TELEGRAM_ID }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(encoded, 'ascii').digest('base64url');
    expect(() => verifyAdminWebSession(`${encoded}.${signature}`, SECRET, [TELEGRAM_ID], NOW))
      .toThrowError(expect.objectContaining({ code: 'ADMIN_SESSION_INVALID' }));
  });

  it('rejects future issue times and an admin removed from the allowlist', () => {
    expect(() => verifyAdminWebSession(createSession({ iat: NOW + 61, exp: NOW + 961 }), SECRET, [TELEGRAM_ID], NOW))
      .toThrowError(expect.objectContaining({ code: 'ADMIN_SESSION_INVALID' }));
    expect(() => verifyAdminWebSession(createSession(), SECRET, [], NOW))
      .toThrowError(expect.objectContaining({ code: 'ADMIN_SESSION_NOT_AUTHORIZED' }));
  });

  it('rejects missing, short, and oversized credentials', () => {
    expect(() => verifyAdminWebSession('', SECRET, [TELEGRAM_ID], NOW)).toThrow();
    expect(() => verifyAdminWebSession(createSession(), 'short', [TELEGRAM_ID], NOW)).toThrow();
    expect(() => verifyAdminWebSession(`${createSession()}${'x'.repeat(4096)}`, SECRET, [TELEGRAM_ID], NOW)).toThrow();
  });
});
