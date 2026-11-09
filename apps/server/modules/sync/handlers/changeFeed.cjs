'use strict';

const { validateCompanyScope } = require('../../../auth/auth.cjs');
const { acquireCompanyBootstrapLock, releaseCompanyBootstrapLock } = require('../changeFeedWatermark.cjs');

/**
 * Creates change feed GET handler for Fastify.
 *
 * Query params:
 * - cursor: opaque/high-watermark cursor (decimal integer string). Default 0.
 * - limit: max records per page (default 100, max 500).
 *
 * Guaranteed invariants:
 * - Company-scoped isolation: client can only see changes for its authenticated company.
 * - Gap-tolerant cursor: uses `change_id > cursor` so interleaved global BIGSERIAL IDs do not drop tenant changes.
 * - nextCursor safe derivation: derived from the maximum change_id in the returned page, or unchanged cursor if 0 rows.
 *
 * @param {import('pg').Pool} pool
 */
function createChangeFeedHandler(pool) {
  return async function handleGetChanges(req, reply) {
    const companyId = req.auth.companyId;
    if (!companyId) {
      return reply.code(401).send({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required' }
      });
    }

    // Optional query companyId check (fail-closed if provided and mismatched)
    if (req.query && req.query.companyId) {
      validateCompanyScope(req, req.query.companyId);
    }

    const rawCursor = req.query?.cursor;
    let cursor = '0';
    if (rawCursor !== undefined && rawCursor !== null && String(rawCursor).trim() !== '') {
      const candidate = String(rawCursor).trim();
      if (!/^\d{1,19}$/.test(candidate) || BigInt(candidate) > 9223372036854775807n) {
        return reply.code(400).send({
          success: false,
          error: { code: 'INVALID_SYNC_CURSOR', message: 'cursor must be a non-negative decimal integer' }
        });
      }
      cursor = BigInt(candidate).toString();
    }

    const rawLimit = req.query?.limit;
    let limit = 100;
    if (rawLimit !== undefined && rawLimit !== null) {
      const parsed = parseInt(String(rawLimit), 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 500);
      }
    }

    const client = await pool.connect();
    let lockHeld = false;
    let transactionStarted = false;
    let discardClient = false;
    let res;
    let headCursor;
    let sequenceResult;
    try {
      // The same company lock used by bootstrap and all sync writers fences
      // uncommitted lower sequence IDs before the as-of head is sampled.
      await acquireCompanyBootstrapLock(client, companyId);
      lockHeld = true;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transactionStarted = true;
      const head = await client.query(`SELECT COALESCE(MAX(change_id), 0)::text AS cursor
        FROM change_log WHERE company_id = $1`, [companyId]);
      headCursor = String(head.rows[0]?.cursor ?? '0');
      if (!/^\d{1,19}$/.test(headCursor) || BigInt(headCursor) > 9223372036854775807n)
        throw new Error('FEED_HEAD_INVALID');
      res = await client.query(
      `SELECT change_id, company_id, entity_type, entity_id, entity_revision,
               operation_id, change_type, payload_json, committed_at
       FROM change_log
        WHERE company_id = $1 AND change_id > $2 AND change_id <= $3
        ORDER BY change_id ASC
        LIMIT $4`,
      [companyId, cursor, headCursor, limit + 1]
      );
      sequenceResult = await client.query(`SELECT next_patta_number FROM company_patta_sequences
        WHERE company_id = $1`, [companyId]);
      await client.query('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try { await client.query('ROLLBACK'); } catch { discardClient = true; }
      }
      throw error;
    } finally {
      if (lockHeld) {
        try { await releaseCompanyBootstrapLock(client, companyId); } catch { discardClient = true; }
      }
      client.release(discardClient ? new Error('FEED_CONNECTION_DISCARDED') : undefined);
    }

    const hasMore = res.rows.length > limit;
    const items = res.rows.slice(0, limit).map((row) => ({
      changeId: String(row.change_id),
      companyId: row.company_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityRevision: row.entity_revision,
      operationId: row.operation_id,
      changeType: row.change_type,
      payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json,
      committedAt: row.committed_at
    }));

    // When the page is exhausted, the company's as-of head can be ahead of
    // the last visible event due to global IDs belonging to other tenants.
    const nextCursor = hasMore ? items[items.length - 1].changeId : headCursor;
    const nextPattaNumber = Number(sequenceResult.rows[0]?.next_patta_number || 1);
    if (!Number.isSafeInteger(nextPattaNumber) || nextPattaNumber < 1) {
      return reply.code(500).send({
        success: false,
        error: { code: 'PATTA_SEQUENCE_INVALID', message: 'Company patta sequence is invalid' }
      });
    }

    return reply.send({
      success: true,
      items,
      nextCursor,
      fromCursor: cursor,
      headCursor,
      companyId,
      feedProtocolVersion: 1,
      hasMore,
      nextPattaNumber,
      // This capability is served only by releases whose ordered migration
      // set includes the VOIDED-ticket patta-key release.
       capabilities: { voidedPattaReuse: true, pattaLifecycleV1: true }
    });
  };
}

module.exports = {
  createChangeFeedHandler
};
