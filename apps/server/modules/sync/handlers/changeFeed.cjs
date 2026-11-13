'use strict';

const { validateCompanyScope } = require('../../../auth/auth.cjs');
const { acquireCompanyBootstrapLock, releaseCompanyBootstrapLock } = require('../changeFeedWatermark.cjs');
const {
  formatPurgeEraMetadata,
  parseOptionalPurgeGeneration,
  assertChangeFeedAllowedUnderPurgeFence
} = require('../historicalPurgeFence.cjs');

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

    let clientPurgeGeneration = null;
    try {
      clientPurgeGeneration = parseOptionalPurgeGeneration(req.query?.purgeGeneration);
    } catch (error) {
      return reply.code(400).send({
        success: false,
        error: { code: error.code || 'INVALID_PURGE_GENERATION', message: error.message }
      });
    }

    const client = await pool.connect();
    let lockHeld = false;
    let transactionStarted = false;
    let discardClient = false;
    let activePurgeEra = null;
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
      const head = await client.query(`SELECT COALESCE(MAX(change_id), 0)::text AS cursor,
        (SELECT row_to_json(era) FROM (
          SELECT purge_id, company_id, purge_generation, cutoff_date::text AS cutoff_date,
                 cutoff_utc, timezone, min_valid_cursor::text AS min_valid_cursor,
                 manifest_sha256, baseline_purged, executed_at
          FROM historical_purge_eras
          WHERE company_id = $1 AND status = UPPER('committed')
          ORDER BY purge_generation DESC
          LIMIT 1
        ) era) AS purge_era
        FROM change_log WHERE company_id = $1`, [companyId]);
      activePurgeEra = formatPurgeEraMetadata(head.rows[0]?.purge_era || null);
      const fenceResult = assertChangeFeedAllowedUnderPurgeFence(activePurgeEra, cursor, clientPurgeGeneration);
      if (!fenceResult.allowed) {
        await client.query('COMMIT');
        transactionStarted = false;
        return reply.code(409).send({
          success: false,
          error: {
            code: fenceResult.code,
            message: fenceResult.message,
            purgeGeneration: activePurgeEra.purgeGeneration,
            cutoffDate: activePurgeEra.cutoffDate,
            cutoffUtc: activePurgeEra.cutoffUtc,
            minValidCursor: activePurgeEra.minValidCursor
          }
        });
      }
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
      ...(activePurgeEra ? {
        purgeGeneration: activePurgeEra.purgeGeneration,
        purgeCutoffDate: activePurgeEra.cutoffDate,
        purgeCutoffUtc: activePurgeEra.cutoffUtc,
        minValidCursor: activePurgeEra.minValidCursor
      } : {}),
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
