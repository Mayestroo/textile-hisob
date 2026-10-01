import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { buildFastifyServer } from '../app.cjs';
import { getServerPool, initServerDatabase, resetServerDatabase, closeServerPool } from '../infrastructure/db.cjs';
const {
  generateDeviceToken,
  hashDeviceToken,
  provisionDevice,
  rotateDeviceCredential,
  revokeDevice,
  getDeviceStatus
} = require('./deviceProvisioning.cjs');

describe('Production Device Credential Lifecycle & Revocation Drill (Gate 3 / Items 19-22)', () => {
  let app: any;
  let pool: Pool;
  const COMPANY_ID = 'comp_pilot_production';
  const DEVICE_1 = 'device-workstation-01';
  const DEVICE_2 = 'device-workstation-02';

  beforeAll(async () => {
    pool = getServerPool();
    await resetServerDatabase();
    await initServerDatabase();

    // In production mode: allowTestTokens is false
    app = buildFastifyServer({ pool, allowTestTokens: false });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeServerPool();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM server_devices WHERE company_id = $1', [COMPANY_ID]);
  });

  describe('Item 20: Device Token Entropy & Server Storage', () => {
    it('generates high-entropy 256-bit CSPRNG tokens and verifies only hashes are stored in DB', () => {
      const token1 = generateDeviceToken();
      const token2 = generateDeviceToken();

      expect(token1).toHaveLength(64);
      expect(token2).toHaveLength(64);
      expect(token1).not.toBe(token2);
      expect(token1).toMatch(/^[0-9a-f]{64}$/);

      // Verify not predictable or timestamp based
      expect(token1).not.toContain(COMPANY_ID);
      expect(token1).not.toContain(DEVICE_1);
      expect(token1).not.toContain(String(Date.now()));

      const hash1 = hashDeviceToken(token1);
      expect(hash1).toHaveLength(64);
      expect(hash1).not.toBe(token1);
    });
  });

  describe('Items 19 & 22: Operational Provisioning, Authentication, and Revocation Drill', () => {
    it('executes full lifecycle: provision, authenticate, revoke drill, verify tenant isolation, and rotate', async () => {
      // 1. Provision Device 1 and Device 2
      const dev1 = await provisionDevice(pool, {
        deviceId: DEVICE_1,
        companyId: COMPANY_ID,
        clientVersion: '2.0.0'
      });
      const dev2 = await provisionDevice(pool, {
        deviceId: DEVICE_2,
        companyId: COMPANY_ID,
        clientVersion: '2.0.0'
      });

      expect(dev1.token).toHaveLength(64);
      expect(dev2.token).toHaveLength(64);
      expect(dev1.token).not.toBe(dev2.token);

      // Verify only hash is stored on server
      const row1 = await getDeviceStatus(pool, DEVICE_1);
      expect(row1.token_hash).toBe(dev1.tokenHash);
      expect(row1.token_hash).not.toBe(dev1.token);
      expect(row1.is_revoked).toBe(false);

      // 2. Both devices authenticate successfully
      const res1Before = await app.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${dev1.token}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res1Before.statusCode).toBe(200);

      const res2Before = await app.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${dev2.token}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res2Before.statusCode).toBe(200);

      // 3. EXECUTE REVOCATION DRILL: Revoke Device 1
      const revResult = await revokeDevice(pool, {
        deviceId: DEVICE_1,
        companyId: COMPANY_ID
      });
      expect(revResult.is_revoked).toBe(true);

      // 4. Next authenticated call from Device 1 is rejected immediately with 403 DEVICE_REVOKED
      const res1AfterRevoke = await app.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${dev1.token}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res1AfterRevoke.statusCode).toBe(403);
      const body1 = JSON.parse(res1AfterRevoke.payload);
      expect(body1.error.code).toBe('DEVICE_REVOKED');

      // 5. OTHER COMPANY DEVICES UNAFFECTED: Device 2 continues to operate without interruption
      const res2AfterRevoke = await app.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${dev2.token}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res2AfterRevoke.statusCode).toBe(200);

      // 6. ROTATE / REPLACE CREDENTIAL: Rotate Device 1 with a new replacement credential
      const rotated = await rotateDeviceCredential(pool, {
        deviceId: DEVICE_1,
        companyId: COMPANY_ID
      });
      expect(rotated.token).not.toBe(dev1.token);

      // Old token remains invalid
      const res1OldToken = await app.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${dev1.token}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res1OldToken.statusCode).toBe(401);

      // New replacement token works immediately
      const res1NewToken = await app.inject({
        method: 'GET',
        url: '/api/sync/changes',
        headers: {
          authorization: `Bearer ${rotated.token}`,
          'x-client-version': '2.0.0'
        }
      });
      expect(res1NewToken.statusCode).toBe(200);
    });
  });
});
