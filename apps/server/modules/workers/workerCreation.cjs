'use strict';

const { canonicalStringify, computePayloadHash } = require('../sync/canonicalPayload.cjs');
const { acquireCompanyChangeLock } = require('../sync/changeFeedWatermark.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_WORKER_ID = 2147483647;

function workerCreateError(code, statusCode, message = code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeCreateWorkerRequest(auth, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw workerCreateError('INVALID_WORKER_CREATE_REQUEST', 400);
  }
  const forbidden = ['workerId', 'id', 'canonicalWorkerId', 'deletedWorkerIds', 'companyId'];
  if (forbidden.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    throw workerCreateError('CLIENT_WORKER_ID_FORBIDDEN', 400, 'Worker ID and company authority are assigned by the server');
  }
  const allowed = new Set(['operationId', 'name', 'staj', 'role', 'balanceAdjustments']);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw workerCreateError('INVALID_WORKER_CREATE_REQUEST', 400, 'Worker create request contains unsupported fields');
  }

  const companyId = String(auth?.companyId || '').trim();
  const deviceId = String(auth?.deviceId || '').trim();
  const operationId = String(body.operationId || '').trim();
  const name = String(body.name || '').trim();
  const staj = Number(body.staj ?? 0);
  const role = body.role === undefined || body.role === null || body.role === '' ? null : String(body.role).trim();
  if (!COMPANY_ID.test(companyId)) throw workerCreateError('INVALID_COMPANY_ID', 400);
  if (!deviceId || deviceId.length > 128) throw workerCreateError('INVALID_DEVICE_ID', 400);
  if (!UUID.test(operationId)) throw workerCreateError('INVALID_OPERATION_ID', 400);
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) throw workerCreateError('INVALID_WORKER_NAME', 400);
  if (!Number.isFinite(staj) || staj < 0) throw workerCreateError('INVALID_WORKER_STAJ', 400);
  if (role !== null && (role.length > 128 || /[\u0000-\u001f\u007f]/.test(role))) throw workerCreateError('INVALID_WORKER_ROLE', 400);

  const rawAdjustments = body.balanceAdjustments === undefined ? [] : body.balanceAdjustments;
  if (!Array.isArray(rawAdjustments) || rawAdjustments.length > 2) throw workerCreateError('INVALID_WORKER_ADJUSTMENTS', 400);
  const adjustmentIds = new Set();
  const balanceAdjustments = rawAdjustments.map((adjustment) => {
    if (!adjustment || typeof adjustment !== 'object' || Array.isArray(adjustment)) throw workerCreateError('INVALID_WORKER_ADJUSTMENT', 400);
    const keys = new Set(['adjustmentId', 'type', 'amountDelta', 'periodId', 'description']);
    if (Object.keys(adjustment).some((key) => !keys.has(key))) throw workerCreateError('INVALID_WORKER_ADJUSTMENT', 400);
    const adjustmentId = String(adjustment.adjustmentId || '').trim();
    const type = String(adjustment.type || '').trim();
    const amountDelta = Number(adjustment.amountDelta);
    const periodId = adjustment.periodId === undefined || adjustment.periodId === null ? null : String(adjustment.periodId).trim();
    const description = adjustment.description === undefined || adjustment.description === null
      ? null : String(adjustment.description).trim();
    if (!UUID.test(adjustmentId) || adjustmentIds.has(adjustmentId)) throw workerCreateError('INVALID_WORKER_ADJUSTMENT_ID', 400);
    if (!['AVANS', 'JARIMA'].includes(type)) throw workerCreateError('INVALID_WORKER_ADJUSTMENT_TYPE', 400);
    if (!Number.isFinite(amountDelta) || amountDelta === 0) throw workerCreateError('INVALID_WORKER_ADJUSTMENT_AMOUNT', 400);
    if (periodId !== null && (!periodId || periodId.length > 128 || /[\u0000-\u001f\u007f]/.test(periodId))) throw workerCreateError('INVALID_WORKER_ADJUSTMENT_PERIOD', 400);
    if (description !== null && (description.length > 500 || /[\u0000-\u001f\u007f]/.test(description))) throw workerCreateError('INVALID_WORKER_ADJUSTMENT_DESCRIPTION', 400);
    adjustmentIds.add(adjustmentId);
    return { adjustmentId, type, amountDelta, periodId, description };
  });

  return {
    companyId,
    deviceId,
    operationId,
    name,
    staj,
    role,
    balanceAdjustments
  };
}

async function createWorker(pool, auth, body) {
  const request = normalizeCreateWorkerRequest(auth, body);
  const canonicalPayload = {
    companyId: request.companyId,
    name: request.name,
    staj: request.staj,
    role: request.role,
    balanceAdjustments: request.balanceAdjustments
  };
  const payloadHash = computePayloadHash(canonicalStringify(canonicalPayload));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':worker-create:' || $2))", [request.companyId, request.operationId]);
    await acquireCompanyChangeLock(client, request.companyId);

    const prior = await client.query(
      `SELECT command_type, entity_id, payload_hash, result_json, server_revision, accepted_at
       FROM operations_dedup WHERE company_id = $1 AND operation_id = $2 FOR UPDATE`,
      [request.companyId, request.operationId]
    );
    if (prior.rows.length) {
      const row = prior.rows[0];
      if (row.command_type !== 'CreateWorker' || row.payload_hash !== payloadHash) {
        throw workerCreateError('IDEMPOTENCY_CONFLICT', 409, 'operationId was already used for a different worker create request');
      }
      await client.query('COMMIT');
      const workerId = String(row.entity_id);
      return {
        operationId: request.operationId,
        worker: row.result_json?.worker || { id: Number(workerId), companyId: request.companyId },
        status: 'APPLIED',
        serverRevision: Number(row.server_revision),
        cursor: row.result_json?.cursor || null,
        committedAt: row.accepted_at,
        replay: true
      };
    }

    const baseline = await client.query(
      `SELECT 1 FROM baseline_import_runs WHERE company_id = $1 AND status = 'APPLIED' LIMIT 1`,
      [request.companyId]
    );
    if (!baseline.rows.length) throw workerCreateError('CLEAN_BASELINE_REQUIRED', 409, 'A clean baseline must be imported before creating workers');

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':worker-id-sequence'))", [request.companyId]);
    const duplicate = await client.query(
      `SELECT id FROM workers WHERE company_id = $1 AND status = 'ACTIVE' AND lower(name) = lower($2) LIMIT 1 FOR UPDATE`,
      [request.companyId, request.name]
    );
    if (duplicate.rows.length) throw workerCreateError('WORKER_NAME_EXISTS', 409, 'An active worker with this name already exists');

    const maxResult = await client.query(
      `SELECT COALESCE(MAX(id), 0)::BIGINT + 1 AS next_worker_id FROM workers WHERE company_id = $1`,
      [request.companyId]
    );
    const workerId = Number(maxResult.rows[0]?.next_worker_id);
    if (!Number.isSafeInteger(workerId) || workerId <= 0 || workerId > MAX_WORKER_ID) {
      throw workerCreateError('WORKER_ID_SPACE_EXHAUSTED', 409);
    }

    for (const adjustment of request.balanceAdjustments) {
      if (adjustment.periodId) {
        const period = await client.query(
          `SELECT id FROM periods WHERE company_id = $1 AND id = $2 AND is_closed = 0 FOR UPDATE`,
          [request.companyId, adjustment.periodId]
        );
        if (!period.rows.length) throw workerCreateError('PERIOD_CLOSED', 409);
      }
    }

    const now = new Date().toISOString();
    await client.query(`
      INSERT INTO workers (id, company_id, name, status, staj, role, server_revision, created_at, updated_at)
      VALUES ($1, $2, $3, 'ACTIVE', $4, $5, 1, $6, $6)
    `, [workerId, request.companyId, request.name, request.staj, request.role, now]);
    for (const adjustment of request.balanceAdjustments) {
      await client.query(`
        INSERT INTO worker_adjustments (id, company_id, worker_id, type, amount, source_id, provenance, created_at, period_id)
        VALUES ($1, $2, $3, $4, $5, $6, 'WORKBOOK_COMMAND', $7, $8)
      `, [adjustment.adjustmentId, request.companyId, workerId, adjustment.type, adjustment.amountDelta,
        adjustment.adjustmentId, now, adjustment.periodId]);
    }

    const workerChange = {
      id: workerId,
      companyId: request.companyId,
      name: request.name,
      staj: request.staj,
      role: request.role,
      status: 'ACTIVE',
      balanceAdjustments: request.balanceAdjustments,
      updatedAt: now
    };
    const change = await client.query(`
      INSERT INTO change_log (
        company_id, entity_type, entity_id, entity_revision, operation_id, change_type, payload_json, committed_at
      ) VALUES ($1, 'worker', $2, 1, $3, 'INSERT', $4::jsonb, $5)
      RETURNING change_id, committed_at
    `, [request.companyId, String(workerId), request.operationId, canonicalStringify(workerChange), now]);
    const resultJson = {
      status: 'APPLIED',
      worker: workerChange,
      serverRevision: 1,
      cursor: String(change.rows[0].change_id),
      committedAt: change.rows[0].committed_at
    };
    await client.query(`
      INSERT INTO operations_dedup (
        company_id, operation_id, command_type, entity_type, entity_id,
        payload_hash, result_json, server_revision, accepted_at
      ) VALUES ($1, $2, 'CreateWorker', 'worker', $3, $4, $5, 1, $6)
    `, [request.companyId, request.operationId, String(workerId), payloadHash, resultJson, now]);
    await client.query('COMMIT');
    return { operationId: request.operationId, ...resultJson, replay: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createWorker, normalizeCreateWorkerRequest };
