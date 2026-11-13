'use strict';

const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');
const { acquireCompanyChangeLock } = require('./changeFeedWatermark.cjs');

function failure(code, message, statusCode = 409) {
  const error = new Error(message); error.code = code; error.statusCode = statusCode; return error;
}

function assertReviewer(req, companyId) {
  const operator = req.auth?.operator;
  if (!operator || !operator.isActive || operator.companyId !== companyId ||
      !['admin', 'accountant'].includes(String(operator.role).toLowerCase())) {
    throw failure('ALLOCATION_REVIEW_UNAUTHORIZED', 'Active company accountant/admin operator session required', 403);
  }
}

async function cancelAllocation(pool, req, input, options = {}) {
  const companyId = req.auth?.companyId;
  if (!companyId || input?.companyId !== companyId) throw failure('COMPANY_SCOPE_MISMATCH', 'Authenticated company scope mismatch', 403);
  assertReviewer(req, companyId);
  const { originalOperationId, originalPayloadHash, originalPayload, resolutionOperationId, reason } = input || {};
  if (![originalOperationId, originalPayloadHash, resolutionOperationId, reason].every((v) => typeof v === 'string' && v.trim()) ||
      !originalPayload || typeof originalPayload !== 'object' || Array.isArray(originalPayload)) {
    throw failure('INVALID_ALLOCATION_RESOLUTION', 'Original operation, canonical payload/hash, resolution id and reason are required', 400);
  }
  const canonical = canonicalStringify(originalPayload);
  if (computePayloadHash(canonical) !== originalPayloadHash) throw failure('ORIGINAL_PAYLOAD_HASH_MISMATCH', 'Original payload does not match its immutable hash', 409);
  const commandType = input.commandType;
  if (!['SubmitTicket', 'UpdateTicket'].includes(commandType)) throw failure('INVALID_ALLOCATION_COMMAND', 'Only unaccepted ticket allocation commands may be cancelled', 400);
  if (originalPayload.operationId !== originalOperationId || originalPayload.companyId !== companyId ||
      typeof originalPayload.ticketId !== 'string' || !originalPayload.ticketId ||
      !Number.isFinite(Number(originalPayload.qty)) || Number(originalPayload.qty) <= 0) {
    throw failure('ORIGINAL_ALLOCATION_IDENTITY_INVALID', 'Original payload must bind operation, company, ticket and positive quantity', 409);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireCompanyChangeLock(client, companyId);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))", [companyId, originalOperationId]);
    const prior = await client.query(`SELECT * FROM allocation_resolution_fences WHERE company_id=$1 AND original_operation_id=$2 FOR UPDATE`, [companyId, originalOperationId]);
    if (prior.rows.length) {
      const row = prior.rows[0];
      if (row.original_payload_hash !== originalPayloadHash || row.resolution_operation_id !== resolutionOperationId ||
          row.action !== 'CANCEL' || row.reason !== reason.trim()) {
        throw failure('ALLOCATION_RESOLUTION_CONFLICT', 'This original operation already has a different final resolution');
      }
      await client.query('COMMIT');
      return { success: true, status: 'CANCELLED', resolutionOperationId, replay: true, audit: await readAudit(pool, companyId, originalOperationId) };
    }
    const reusedResolution = await client.query(`SELECT original_operation_id, original_payload_hash, action
      FROM allocation_resolution_fences WHERE company_id=$1 AND resolution_operation_id=$2 FOR UPDATE`, [companyId, resolutionOperationId]);
    if (reusedResolution.rows.length) throw failure('ALLOCATION_RESOLUTION_CONFLICT', 'Resolution operation id is already bound to different content');
    const accepted = await client.query('SELECT payload_hash FROM operations_dedup WHERE company_id=$1 AND operation_id=$2 FOR UPDATE', [companyId, originalOperationId]);
    if (accepted.rows.length) throw failure('ALLOCATION_ALREADY_ACCEPTED', 'Accepted allocation facts cannot be cancelled as pending work; use the business correction process');
    const reviewEvidence = await client.query(`SELECT command_type, entity_type, entity_id, original_payload_hash, original_payload_json
      FROM allocation_review_candidates WHERE company_id=$1 AND original_operation_id=$2 FOR UPDATE`, [companyId, originalOperationId]);
    const evidence = reviewEvidence.rows[0];
    if (!evidence || evidence.command_type !== commandType || evidence.entity_type !== 'ticket' ||
        evidence.entity_id !== originalPayload.ticketId || evidence.original_payload_hash !== originalPayloadHash ||
        canonicalStringify(evidence.original_payload_json) !== canonical) {
      throw failure('ALLOCATION_REVIEW_EVIDENCE_NOT_FOUND', 'Server has no exact immutable allocation-review evidence for this operation');
    }
    if (typeof originalPayload.periodId !== 'string' || !originalPayload.periodId) throw failure('ALLOCATION_PERIOD_UNKNOWN', 'Original allocation period is not verifiable');
    const period = await client.query('SELECT is_closed FROM periods WHERE company_id=$1 AND id=$2 FOR UPDATE', [companyId, originalPayload.periodId]);
    if (!period.rows.length) throw failure('ALLOCATION_PERIOD_UNKNOWN', 'Original allocation period is not verifiable');
    if (period.rows[0].is_closed === 1 || period.rows[0].is_closed === true) throw failure('PERIOD_CLOSED', 'Allocation in a closed accounting period cannot be reconciled here');
    const previousStatus = input.previousStatus === 'PENDING' ? 'PENDING' : 'CONFLICT';
    const actor = req.auth.operator.operatorId;
    await client.query(`INSERT INTO allocation_resolution_fences
      (company_id,original_operation_id,original_payload_hash,resolution_operation_id,action,actor_id,original_payload_json,reason)
      VALUES($1,$2,$3,$4,'CANCEL',$5,$6::jsonb,$7)`,
    [companyId, originalOperationId, originalPayloadHash, resolutionOperationId, actor, canonical, reason.trim()]);
    await client.query(`INSERT INTO allocation_resolution_audit
      (company_id,original_operation_id,original_payload_hash,resolution_operation_id,reviewer_id,action,previous_status,resulting_status,reason,details_json)
      VALUES($1,$2,$3,$4,$5,'CANCEL',$6,'CANCELLED',$7,$8::jsonb)`,
    [companyId, originalOperationId, originalPayloadHash, resolutionOperationId, actor, previousStatus, reason.trim(), JSON.stringify({ commandType })]);
    if (options.testHookBeforeCommit) await options.testHookBeforeCommit(client);
    await client.query('COMMIT');
    return { success: true, status: 'CANCELLED', resolutionOperationId, replay: false, audit: await readAudit(pool, companyId, originalOperationId) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    if (error?.code === '23505' && String(error?.constraint || '').includes('resolution_operation_id')) {
      throw failure('ALLOCATION_RESOLUTION_CONFLICT', 'Resolution operation id is already bound to different content');
    }
    throw error;
  } finally { client.release(); }
}

async function readAudit(pool, companyId, originalOperationId) {
  const result = await pool.query(`SELECT original_operation_id AS "originalOperationId", original_payload_hash AS "originalPayloadHash",
    resolution_operation_id AS "resolutionOperationId", reviewer_id AS "reviewerId", action, issuance_reference AS "issuanceReference",
    previous_status AS "previousStatus", resulting_status AS "resultingStatus", reason, details_json AS details, created_at AS "createdAt"
    FROM allocation_resolution_audit WHERE company_id=$1 AND original_operation_id=$2 ORDER BY audit_id`, [companyId, originalOperationId]);
  return result.rows;
}

function createAllocationResolutionHandler(pool, options = {}) {
  return async (req, reply) => {
    try {
      const result = await cancelAllocation(pool, req, req.body, options);
      return reply.send(result);
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ success: false, error: { code: error.code || 'ALLOCATION_RESOLUTION_FAILED', message: error.statusCode ? error.message : 'Allocation resolution unavailable' } });
    }
  };
}

module.exports = { cancelAllocation, createAllocationResolutionHandler, readAudit };
