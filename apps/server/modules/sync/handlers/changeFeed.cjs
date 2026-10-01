'use strict';

const { validateCompanyScope } = require('../../../auth/auth.cjs');

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

    const res = await pool.query(
      `SELECT change_id, company_id, entity_type, entity_id, entity_revision,
              operation_id, change_type, payload_json, committed_at
       FROM change_log
       WHERE company_id = $1 AND change_id > $2
       ORDER BY change_id ASC
       LIMIT $3`,
      [companyId, cursor, limit]
    );

    const items = res.rows.map((row) => ({
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

    let nextCursor = cursor;
    if (items.length > 0) {
      nextCursor = items[items.length - 1].changeId;
    }

    const hasMore = items.length === limit;

    return reply.send({
      success: true,
      items,
      nextCursor,
      hasMore
    });
  };
}

module.exports = {
  createChangeFeedHandler
};
