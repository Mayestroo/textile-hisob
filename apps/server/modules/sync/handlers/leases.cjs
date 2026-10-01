'use strict';

const crypto = require('crypto');
const { validateCompanyScope } = require('../../../auth/auth.cjs');

/**
 * Creates party sequence lease handlers for Fastify.
 *
 * @param {import('pg').Pool} pool
 */
function createLeasesHandler(pool) {
  /**
   * POST /api/leases/party
   * Atomically acquires a non-overlapping party sequence lease.
   */
  async function acquirePartyLease(req, reply) {
    const companyId = req.auth.companyId;
    const deviceId = req.auth.deviceId || 'unknown-device';

    if (req.body && req.body.companyId) {
      validateCompanyScope(req, req.body.companyId);
    }

    const blockSizeRaw = req.body?.blockSize;
    let blockSize = 50;
    if (typeof blockSizeRaw === 'number' && Number.isSafeInteger(blockSizeRaw) && blockSizeRaw > 0) {
      blockSize = Math.min(blockSizeRaw, 1000);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Transaction-level company advisory lock to guarantee non-overlapping allocation across concurrent devices
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('party_lease_' || $1))`, [companyId]);

      // 2. Query highest assigned range_end for this company
      const maxRes = await client.query(
        `SELECT COALESCE(MAX(range_end), 0) AS max_end
         FROM party_sequence_leases
         WHERE company_id = $1`,
        [companyId]
      );
      const maxEnd = parseInt(maxRes.rows[0].max_end, 10) || 0;

      const rangeStart = maxEnd + 1;
      const rangeEnd = maxEnd + blockSize;
      const leaseId = `lease_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

      // 3. Insert new lease row using PostgreSQL server clock (NOW())
      const insertRes = await client.query(
        `INSERT INTO party_sequence_leases (
          lease_id, company_id, device_id, range_start, range_end, next_value,
          issued_at_server, expires_at_server, status
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          NOW(), NOW() + INTERVAL '7 days', 'ACTIVE'
        )
        RETURNING lease_id, company_id, device_id, range_start, range_end, next_value,
                  issued_at_server, expires_at_server, status`,
        [leaseId, companyId, deviceId, rangeStart, rangeEnd, rangeStart]
      );

      await client.query('COMMIT');

      const lease = insertRes.rows[0];
      return reply.send({
        success: true,
        lease: {
          leaseId: lease.lease_id,
          companyId: lease.company_id,
          deviceId: lease.device_id,
          rangeStart: lease.range_start,
          rangeEnd: lease.range_end,
          nextValue: lease.next_value,
          issuedAtServer: lease.issued_at_server,
          expiresAtServer: lease.expires_at_server,
          status: lease.status
        }
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        // ignore rollback err
      }
      return reply.code(500).send({
        success: false,
        error: { code: 'LEASE_ACQUISITION_FAILED', message: err.message }
      });
    } finally {
      client.release();
    }
  }

  /**
   * POST /api/leases/party/revoke
   * Revokes an active lease. Unused numbers are retired and NEVER recycled.
   */
  async function revokePartyLease(req, reply) {
    const companyId = req.auth.companyId;
    const leaseId = req.body?.leaseId;

    if (!leaseId) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'leaseId is required' }
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query(
        `SELECT lease_id, company_id, range_start, range_end, status
         FROM party_sequence_leases
         WHERE company_id = $1 AND lease_id = $2
         FOR UPDATE`,
        [companyId, leaseId]
      );

      if (res.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({
          success: false,
          error: { code: 'LEASE_NOT_FOUND', message: `Lease "${leaseId}" not found for company` }
        });
      }

      await client.query(
        `UPDATE party_sequence_leases
         SET status = 'REVOKED', revoked_at_server = NOW()
         WHERE company_id = $1 AND lease_id = $2`,
        [companyId, leaseId]
      );

      await client.query('COMMIT');

      return reply.send({
        success: true,
        leaseId,
        status: 'REVOKED'
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        // ignore
      }
      return reply.code(500).send({
        success: false,
        error: { code: 'LEASE_REVOCATION_FAILED', message: err.message }
      });
    } finally {
      client.release();
    }
  }

  return {
    acquirePartyLease,
    revokePartyLease
  };
}

module.exports = {
  createLeasesHandler
};
