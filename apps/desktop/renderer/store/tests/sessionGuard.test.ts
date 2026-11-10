import { beforeEach, describe, expect, it } from 'vitest';
import { captureSessionIdentity, invalidateSessionIdentity, isSessionCurrent, resetSessionGuardForTests } from '../sessionGuard';

describe('session identity invalidation', () => {
  beforeEach(resetSessionGuardForTests);

  it('invalidates in-flight work across company switch and same-company license reactivation', () => {
    const companyA = captureSessionIdentity('fixture-company-a');
    expect(isSessionCurrent(companyA, 'fixture-company-a')).toBe(true);

    captureSessionIdentity('fixture-company-b');
    expect(isSessionCurrent(companyA, 'fixture-company-b')).toBe(false);

    const relogged = captureSessionIdentity('fixture-company-b');
    invalidateSessionIdentity('fixture-company-b'); // license revocation, changed activation, or operator logout/login
    expect(isSessionCurrent(relogged, 'fixture-company-b')).toBe(false);
    expect(isSessionCurrent(captureSessionIdentity('fixture-company-b'), 'fixture-company-b')).toBe(true);
  });

  it('rejects a delayed response after logout and activation for a different company', () => {
    const request = captureSessionIdentity('fixture-company-a');
    invalidateSessionIdentity(null);
    captureSessionIdentity('fixture-company-b');
    expect(isSessionCurrent(request, 'fixture-company-b')).toBe(false);
  });
});
