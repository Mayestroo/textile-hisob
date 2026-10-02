'use strict';

const crypto = require('crypto');
const { verifySignedActivation } = require('./licenseActivation.cjs');

const REQUEST_WINDOW_MS = 10 * 60 * 1000;
const REQUEST_LIMIT = 5;
const MACHINE_ID_PATTERN = /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/;
const COMPANY_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = new Set(['admin', 'type', 'print']);

function activationError(code, statusCode, message = code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw activationError('INVALID_ACTIVATION_REQUEST', 400);
  if (!UUID_PATTERN.test(String(body.requestId || ''))) throw activationError('INVALID_REQUEST_ID', 400);
  if (typeof body.requestToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.requestToken)) throw activationError('INVALID_REQUEST_TOKEN', 400);
  if (typeof body.machineId !== 'string' || !MACHINE_ID_PATTERN.test(body.machineId)) throw activationError('INVALID_MACHINE_ID', 400);
  const context = body.context === undefined ? {} : body.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw activationError('INVALID_REQUEST_CONTEXT', 400);
  const keys = Object.keys(context);
  if (keys.some((key) => !['appVersion', 'platform'].includes(key))) throw activationError('INVALID_REQUEST_CONTEXT', 400);
  if (keys.some((key) => typeof context[key] !== 'string' || context[key].length > 40)) throw activationError('INVALID_REQUEST_CONTEXT', 400);
  return { requestId: body.requestId, requestToken: body.requestToken, machineId: body.machineId, context };
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function createActivationRequest(pool, rawBody) {
  const body = validateRequestBody(rawBody);
  const tokenHash = hashSecret(body.requestToken);
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`novda:activation-request:${body.machineId}`]);
    const existing = await client.query(
      `SELECT request_id, machine_id, request_token_hash, status, requested_at
       FROM activation_requests WHERE request_id = $1 FOR UPDATE`,
      [body.requestId]
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.machine_id !== body.machineId || row.request_token_hash !== tokenHash) {
        throw activationError('ACTIVATION_REQUEST_ID_CONFLICT', 409);
      }
      return { requestId: row.request_id, status: row.status, requestedAt: row.requested_at, replay: true };
    }

    const active = await client.query(
      `SELECT request_id FROM activation_requests
       WHERE machine_id = $1 AND status = 'APPROVED' LIMIT 1`,
      [body.machineId]
    );
    if (active.rows.length) throw activationError('MACHINE_ALREADY_ACTIVATED', 409);

    const rateLimit = await client.query(
      `SELECT request_count, window_started_at FROM activation_request_limits
       WHERE machine_id = $1 FOR UPDATE`,
      [body.machineId]
    );
    const now = Date.now();
    if (!rateLimit.rows.length) {
      await client.query(
        `INSERT INTO activation_request_limits (machine_id, request_count, window_started_at)
         VALUES ($1, 1, NOW())`,
        [body.machineId]
      );
    } else {
      const windowStarted = Date.parse(rateLimit.rows[0].window_started_at);
      if (!Number.isFinite(windowStarted) || now - windowStarted >= REQUEST_WINDOW_MS) {
        await client.query(
          `UPDATE activation_request_limits SET request_count = 1, window_started_at = NOW(), updated_at = NOW()
           WHERE machine_id = $1`,
          [body.machineId]
        );
      } else if (Number(rateLimit.rows[0].request_count) >= REQUEST_LIMIT) {
        throw activationError('ACTIVATION_REQUEST_RATE_LIMITED', 429);
      } else {
        await client.query(
          `UPDATE activation_request_limits SET request_count = request_count + 1, updated_at = NOW()
           WHERE machine_id = $1`,
          [body.machineId]
        );
      }
    }

    const inserted = await client.query(
      `INSERT INTO activation_requests (request_id, machine_id, request_token_hash, client_context)
       VALUES ($1, $2, $3, $4)
       RETURNING request_id, status, requested_at`,
      [body.requestId, body.machineId, tokenHash, JSON.stringify(body.context)]
    );
    const row = inserted.rows[0];
    return { requestId: row.request_id, status: row.status, requestedAt: row.requested_at, replay: false };
  });
}

async function getActivationRequest(pool, requestId, requestToken, machineId) {
  if (!UUID_PATTERN.test(String(requestId || '')) || typeof requestToken !== 'string' || !/^[a-f0-9]{64}$/.test(requestToken)) {
    throw activationError('ACTIVATION_REQUEST_NOT_FOUND', 404);
  }
  const result = await pool.query(
    `SELECT request_id, machine_id, status, client_context, requested_at, updated_at,
            rejection_reason, signed_payload, signature
     FROM activation_requests
     WHERE request_id = $1 AND request_token_hash = $2`,
    [requestId, hashSecret(requestToken)]
  );
  const row = result.rows[0];
  if (!row || (machineId && row.machine_id !== machineId)) throw activationError('ACTIVATION_REQUEST_NOT_FOUND', 404);
  return {
    requestId: row.request_id,
    status: row.status,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    rejectionReason: row.status === 'REJECTED' ? row.rejection_reason : null,
    activation: row.signed_payload ? { payload: row.signed_payload, signature: row.signature } : null
  };
}

function validateAdminTelegramId(adminTelegramId, allowedAdminIds) {
  const normalized = String(adminTelegramId || '').trim();
  if (!/^\d{1,24}$/.test(normalized) || !allowedAdminIds.has(normalized)) {
    throw activationError('ADMIN_TELEGRAM_ID_NOT_AUTHORIZED', 403);
  }
  return normalized;
}

async function upsertActivationCompany(pool, input, adminTelegramId, allowedAdminIds) {
  const actor = validateAdminTelegramId(adminTelegramId, allowedAdminIds);
  const companyId = String(input?.companyId || '').trim();
  const companyName = String(input?.companyName || '').trim();
  if (!COMPANY_ID_PATTERN.test(companyId) || !companyName || companyName.length > 160) {
    throw activationError('INVALID_ACTIVATION_COMPANY', 400);
  }
  const roles = input.allowedRoles === undefined ? ['admin', 'type', 'print'] : input.allowedRoles;
  if (!Array.isArray(roles) || !roles.length || roles.length > ALLOWED_ROLES.size || roles.some((role) => !ALLOWED_ROLES.has(role))) {
    throw activationError('INVALID_ACTIVATION_ROLES', 400);
  }
  if (typeof (input.isActive ?? true) !== 'boolean') throw activationError('INVALID_COMPANY_POLICY', 400);
  const result = await pool.query(
    `INSERT INTO activation_companies (
       company_id, company_name, allowed_roles, require_ticket_validation, is_active, updated_by_telegram_id, updated_by_source
     )
     SELECT $1::VARCHAR, $2, $3, TRUE, $4, $5, 'TELEGRAM_ADMIN'
     FROM company_batch_settings scope
     WHERE scope.company_id = $1::VARCHAR
     ON CONFLICT (company_id) DO UPDATE SET
       company_name = EXCLUDED.company_name,
       allowed_roles = EXCLUDED.allowed_roles,
       require_ticket_validation = activation_companies.require_ticket_validation,
       is_active = EXCLUDED.is_active,
       updated_by_telegram_id = EXCLUDED.updated_by_telegram_id,
       updated_by_source = EXCLUDED.updated_by_source,
       updated_at = NOW()
     RETURNING company_id, company_name, allowed_roles, require_ticket_validation, is_active,
       updated_by_telegram_id, updated_by_source`,
    [companyId, companyName, roles, input.isActive ?? true, actor]
  );
  if (!result.rows.length) throw activationError('CANONICAL_COMPANY_NOT_FOUND', 404);
  return result.rows[0];
}

async function listActivationCompanies(pool) {
  const result = await pool.query(
    `SELECT company_id, company_name, allowed_roles, require_ticket_validation
     FROM activation_companies WHERE is_active = TRUE ORDER BY company_name, company_id`
  );
  return result.rows;
}

async function listPendingActivationRequests(pool) {
  const result = await pool.query(
    `SELECT request_id, machine_id, client_context, requested_at
     FROM activation_requests WHERE status = 'PENDING'
     ORDER BY requested_at ASC LIMIT 100`
  );
  return result.rows;
}

async function getAdminActivationRequest(pool, requestId) {
  if (!UUID_PATTERN.test(String(requestId || ''))) throw activationError('ACTIVATION_REQUEST_NOT_FOUND', 404);
  const result = await pool.query(
    `SELECT request_id, machine_id, client_context, status, company_id, company_name, role,
            require_ticket_validation, signed_payload, signature, requested_at, approved_at,
            approved_by_telegram_id, rejected_at, rejected_by_telegram_id, rejection_reason,
            revoked_at, revoked_by_telegram_id
     FROM activation_requests WHERE request_id = $1`,
    [requestId]
  );
  if (!result.rows.length) throw activationError('ACTIVATION_REQUEST_NOT_FOUND', 404);
  const row = result.rows[0];
  return {
    ...row,
    activation: row.signed_payload ? { payload: row.signed_payload, signature: row.signature } : null
  };
}

async function approveActivationRequest(pool, requestId, input, options = {}) {
  const actor = validateAdminTelegramId(input?.adminTelegramId, options.allowedAdminIds || new Set());
  const companyId = String(input?.companyId || '').trim();
  const role = String(input?.role || '').trim().toLowerCase();
  if (!COMPANY_ID_PATTERN.test(companyId) || !ALLOWED_ROLES.has(role)) throw activationError('INVALID_ACTIVATION_BINDING', 400);
  if (!UUID_PATTERN.test(String(requestId || ''))) throw activationError('ACTIVATION_REQUEST_NOT_FOUND', 404);

  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`novda:activation-policy:${companyId}`]);
    const result = await client.query(
      `SELECT r.*, c.company_name AS authoritative_company_name,
              c.allowed_roles, c.require_ticket_validation AS authoritative_ticket_validation,
              c.is_active AS company_is_active
       FROM activation_requests r
       JOIN activation_companies c ON c.company_id = $2
       WHERE r.request_id = $1 FOR UPDATE OF r`,
      [requestId, companyId]
    );
    if (!result.rows.length) throw activationError('ACTIVATION_REQUEST_OR_COMPANY_NOT_FOUND', 404);
    const row = result.rows[0];
    if (row.status !== 'PENDING') throw activationError('ACTIVATION_REQUEST_NOT_PENDING', 409);
    if (!row.company_is_active || !row.allowed_roles.includes(role)) throw activationError('ACTIVATION_ROLE_NOT_ALLOWED', 403);

    const expected = {
      companyId,
      companyName: row.authoritative_company_name,
      machineId: row.machine_id,
      role,
      requireTicketValidation: row.authoritative_ticket_validation,
      status: 'active'
    };
    if (!verifySignedActivation(input.signedActivation, expected, options.publicKey)) {
      throw activationError('ACTIVATION_SIGNATURE_OR_BINDING_INVALID', 400);
    }
    const payload = input.signedActivation.payload;
    const updated = await client.query(
      `UPDATE activation_requests SET status = 'APPROVED', company_id = $2, company_name = $3,
         role = $4, require_ticket_validation = $5, activation_id = $6,
         signed_payload = $7, signature = $8, approved_by_telegram_id = $9,
         approved_at = NOW(), updated_at = NOW()
       WHERE request_id = $1 AND status = 'PENDING'
       RETURNING request_id, status, machine_id, company_id, company_name, role,
         signed_payload, signature, approved_at, approved_by_telegram_id`,
      [requestId, companyId, row.authoritative_company_name, role, row.authoritative_ticket_validation,
         payload.activationId, JSON.stringify(payload), input.signedActivation.signature, actor]
    );
    const provisionedDevice = await client.query(
      `INSERT INTO server_devices (device_id, company_id, token_hash, client_version, is_revoked, registered_at)
        VALUES ($1, $2, $3, '1.0.0', false, NOW())
       ON CONFLICT (device_id) DO UPDATE SET
         company_id = EXCLUDED.company_id,
         token_hash = EXCLUDED.token_hash,
         client_version = EXCLUDED.client_version,
         is_revoked = false,
         registered_at = NOW()
       WHERE server_devices.is_revoked = true
       RETURNING device_id`,
      [row.machine_id, companyId, row.request_token_hash]
    );
    if (!provisionedDevice.rows.length) throw activationError('DEVICE_ALREADY_REGISTERED', 409);
    await client.query(
      `INSERT INTO activation_events (request_id, event_type, actor_telegram_id, signed_payload, signature)
       VALUES ($1, 'APPROVED', $2, $3, $4)`,
      [requestId, actor, JSON.stringify(payload), input.signedActivation.signature]
    );
    const approved = updated.rows[0];
    return { ...approved, activation: { payload: approved.signed_payload, signature: approved.signature } };
  });
}

async function rejectActivationRequest(pool, requestId, input, allowedAdminIds) {
  const actor = validateAdminTelegramId(input?.adminTelegramId, allowedAdminIds);
  const reason = String(input?.reason || '').trim();
  if (!reason || reason.length > 500) throw activationError('REJECTION_REASON_REQUIRED', 400);
  return withTransaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE activation_requests SET status = 'REJECTED', rejection_reason = $2,
         rejected_by_telegram_id = $3, rejected_at = NOW(), updated_at = NOW()
       WHERE request_id = $1 AND status = 'PENDING'
       RETURNING request_id, status, machine_id, rejection_reason, rejected_by_telegram_id, rejected_at`,
      [requestId, reason, actor]
    );
    if (!updated.rows.length) {
      const found = await client.query('SELECT request_id FROM activation_requests WHERE request_id = $1', [requestId]);
      throw activationError(found.rows.length ? 'ACTIVATION_REQUEST_NOT_PENDING' : 'ACTIVATION_REQUEST_NOT_FOUND', found.rows.length ? 409 : 404);
    }
    await client.query(
      `INSERT INTO activation_events (request_id, event_type, actor_telegram_id, event_metadata)
       VALUES ($1, 'REJECTED', $2, $3)`,
      [requestId, actor, JSON.stringify({ reason })]
    );
    return updated.rows[0];
  });
}

async function revokeActivationRequest(pool, requestId, input, options = {}) {
  const actor = validateAdminTelegramId(input?.adminTelegramId, options.allowedAdminIds || new Set());
  if (!UUID_PATTERN.test(String(requestId || ''))) throw activationError('ACTIVATION_REQUEST_NOT_FOUND', 404);
  return withTransaction(pool, async (client) => {
    const result = await client.query('SELECT * FROM activation_requests WHERE request_id = $1 FOR UPDATE', [requestId]);
    if (!result.rows.length) throw activationError('ACTIVATION_REQUEST_NOT_FOUND', 404);
    const row = result.rows[0];
    if (row.status !== 'APPROVED' || !row.signed_payload) throw activationError('ACTIVATION_NOT_REVOCABLE', 409);
    const currentPayload = row.signed_payload;
    const expected = {
      activationId: currentPayload.activationId,
      companyId: row.company_id,
      companyName: row.company_name,
      expiresAt: currentPayload.expiresAt,
      machineId: row.machine_id,
      requireTicketValidation: row.require_ticket_validation,
      role: row.role,
      status: 'revoked'
    };
    if (!verifySignedActivation(input.signedActivation, expected, options.publicKey)
      || Date.parse(input.signedActivation.payload.issuedAt) <= Date.parse(currentPayload.issuedAt)) {
      throw activationError('ACTIVATION_REVOCATION_SIGNATURE_INVALID', 400);
    }
    const payload = input.signedActivation.payload;
    const updated = await client.query(
      `UPDATE activation_requests SET status = 'REVOKED', signed_payload = $2, signature = $3,
         revoked_by_telegram_id = $4, revoked_at = NOW(), updated_at = NOW()
       WHERE request_id = $1 AND status = 'APPROVED'
       RETURNING request_id, status, machine_id, company_id, role, signed_payload, signature,
         revoked_at, revoked_by_telegram_id`,
      [requestId, JSON.stringify(payload), input.signedActivation.signature, actor]
    );
    await client.query(
      `INSERT INTO activation_events (request_id, event_type, actor_telegram_id, signed_payload, signature)
       VALUES ($1, 'REVOKED', $2, $3, $4)`,
      [requestId, actor, JSON.stringify(payload), input.signedActivation.signature]
    );
    await client.query(
      `UPDATE server_devices SET is_revoked = true
       WHERE device_id = $1 AND company_id = $2 AND token_hash = $3`,
      [row.machine_id, row.company_id, row.request_token_hash]
    );
    const revoked = updated.rows[0];
    return { ...revoked, activation: { payload: revoked.signed_payload, signature: revoked.signature } };
  });
}

function parseAdminTelegramIds(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  return new Set(values.map((value) => String(value).trim()).filter((value) => /^\d{1,24}$/.test(value)));
}

module.exports = {
  REQUEST_LIMIT,
  REQUEST_WINDOW_MS,
  activationError,
  hashSecret,
  validateRequestBody,
  createActivationRequest,
  getActivationRequest,
  parseAdminTelegramIds,
  upsertActivationCompany,
  listActivationCompanies,
  listPendingActivationRequests,
  getAdminActivationRequest,
  approveActivationRequest,
  rejectActivationRequest,
  revokeActivationRequest
};
