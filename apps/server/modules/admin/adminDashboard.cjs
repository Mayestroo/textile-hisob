'use strict';

const crypto = require('crypto');
const {
  activationError,
  upsertActivationCompany,
  listActivationCompanies,
  getAdminActivationRequest,
  approveActivationRequest,
  rejectActivationRequest,
  revokeActivationRequest
} = require('../activation/activationRequests.cjs');
const { verifySignedActivation } = require('../activation/licenseActivation.cjs');
const { assertCompanyAccess, resolveAdminAccess } = require('./adminAccess.cjs');

const COMPANY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVATION_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED']);

function parseCount(value) {
  const count = Number(value || 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function safeLimit(value, defaultValue = 100) {
  const parsed = Number.parseInt(String(value ?? defaultValue), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(100, parsed)) : defaultValue;
}

function safeOffset(value) {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isSafeInteger(parsed) ? Math.max(0, Math.min(10000, parsed)) : 0;
}

function validateCompanyId(companyId) {
  const value = String(companyId || '').trim();
  if (!COMPANY_ID_PATTERN.test(value)) throw activationError('INVALID_COMPANY_ID', 400);
  return value;
}

function validateRequestId(requestId) {
  const value = String(requestId || '').trim();
  if (!UUID_PATTERN.test(value)) throw activationError('ACTIVATION_REQUEST_NOT_FOUND', 404);
  return value;
}

function normalizeNumeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function createAdminDashboardService(options = {}) {
  const { pool } = options;
  const allowedAdminIds = options.allowedAdminIds || new Set();
  const signerClient = options.signerClient;
  const publicKey = options.publicKey;
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');

  function actorId(value) {
    const telegramId = String(value || '').trim();
    if (!/^\d{1,24}$/.test(telegramId) || !allowedAdminIds.has(telegramId)) {
      throw activationError('ADMIN_TELEGRAM_ID_NOT_AUTHORIZED', 403);
    }
    return telegramId;
  }

  async function actorForCompany(value, companyId) {
    const telegramId = String(value || '').trim();
    if (!/^\d{1,24}$/.test(telegramId)) throw activationError('ADMIN_TELEGRAM_ID_NOT_AUTHORIZED', 403);
    const access = await resolveAdminAccess(pool, telegramId, allowedAdminIds);
    assertCompanyAccess(access, companyId);
    return telegramId;
  }

  function actorAllowlist(telegramId) {
    return new Set([...allowedAdminIds, telegramId]);
  }

  async function overview() {
    const result = await pool.query(`
      WITH companies AS (
        SELECT company_id FROM activation_companies
        UNION SELECT company_id FROM workers
        UNION SELECT company_id FROM models
        UNION SELECT company_id FROM parties
        UNION SELECT company_id FROM periods
      )
      SELECT
        (SELECT COUNT(*) FROM companies)::TEXT AS company_count,
        (SELECT COUNT(*) FROM workers WHERE status = 'ACTIVE')::TEXT AS worker_count,
        (SELECT COUNT(*) FROM models WHERE status = 'ACTIVE')::TEXT AS model_count,
        (SELECT COUNT(*) FROM parties WHERE status != 'CLOSED')::TEXT AS party_count,
        (SELECT COUNT(*) FROM server_devices WHERE is_revoked = FALSE)::TEXT AS device_count,
        (SELECT COUNT(*) FROM activation_requests WHERE status = 'PENDING')::TEXT AS pending_activation_count,
        (SELECT COUNT(*) FROM activation_requests WHERE status = 'APPROVED')::TEXT AS active_activation_count,
        (SELECT COUNT(*) FROM worker_telegram_bindings)::TEXT AS worker_binding_count,
        (SELECT MAX(committed_at) FROM change_log) AS recent_sync_at
    `);
    const row = result.rows[0] || {};
    return {
      companies: parseCount(row.company_count),
      workers: parseCount(row.worker_count),
      models: parseCount(row.model_count),
      parties: parseCount(row.party_count),
      devices: parseCount(row.device_count),
      pendingActivations: parseCount(row.pending_activation_count),
      activeActivations: parseCount(row.active_activation_count),
      workerBindings: parseCount(row.worker_binding_count),
      recentSyncAt: row.recent_sync_at || null
    };
  }

  async function listCompanies() {
    const result = await pool.query(`
      WITH company_ids AS (
        SELECT company_id FROM activation_companies
        UNION SELECT company_id FROM workers
        UNION SELECT company_id FROM models
        UNION SELECT company_id FROM parties
        UNION SELECT company_id FROM periods
        UNION SELECT company_id FROM server_devices
      )
      SELECT ids.company_id, activation.company_name, activation.allowed_roles,
             activation.require_ticket_validation, activation.is_active, activation.policy_revision,
             EXISTS (
               SELECT 1 FROM company_batch_settings scope
               WHERE scope.company_id = ids.company_id
             ) AS business_scope_exists,
             (SELECT available_sizes_json FROM company_batch_settings scope WHERE scope.company_id = ids.company_id) AS available_sizes,
             (SELECT server_revision FROM company_batch_settings scope WHERE scope.company_id = ids.company_id) AS server_revision,
             (SELECT COUNT(*) FROM workers w WHERE w.company_id = ids.company_id AND w.status = 'ACTIVE')::TEXT AS worker_count,
             (SELECT COUNT(*) FROM models m WHERE m.company_id = ids.company_id AND m.status = 'ACTIVE')::TEXT AS model_count,
             (SELECT COUNT(*) FROM parties p WHERE p.company_id = ids.company_id AND p.status != 'CLOSED')::TEXT AS party_count
      FROM company_ids ids
      LEFT JOIN activation_companies activation ON activation.company_id = ids.company_id
      ORDER BY COALESCE(activation.company_name, ids.company_id), ids.company_id
    `);
    return result.rows.map((row) => ({
      companyId: row.company_id,
      companyName: row.company_name || row.company_id,
      activationConfigured: row.company_name !== null && row.company_name !== undefined,
      activationActive: Boolean(row.is_active),
      businessScopeExists: Boolean(row.business_scope_exists),
      allowedRoles: row.allowed_roles || [],
      requireTicketValidation: row.require_ticket_validation ?? null,
      strictMode: row.require_ticket_validation ?? null,
      policyRevision: row.policy_revision == null ? null : Number(row.policy_revision),
      availableSizes: Array.isArray(row.available_sizes) ? row.available_sizes : [],
      serverRevision: row.server_revision == null ? null : Number(row.server_revision),
      workerCount: parseCount(row.worker_count),
      modelCount: parseCount(row.model_count),
      partyCount: parseCount(row.party_count)
    }));
  }

  async function listDevices() {
    const [registeredResult, activationResult] = await Promise.all([
      pool.query(`
        SELECT device_id, company_id, client_version, is_revoked, registered_at
        FROM server_devices ORDER BY registered_at DESC, device_id LIMIT 500
      `),
      pool.query(`
        SELECT request_id, machine_id, status, company_id, company_name, role,
               requested_at, approved_at, rejected_at, revoked_at
        FROM activation_requests ORDER BY requested_at DESC LIMIT 500
      `)
    ]);
    return {
      registered: registeredResult.rows.map((row) => ({
        deviceId: row.device_id,
        companyId: row.company_id,
        clientVersion: row.client_version,
        revoked: Boolean(row.is_revoked),
        registeredAt: row.registered_at
      })),
      activationRequests: activationResult.rows.map((row) => ({
        requestId: row.request_id,
        machineId: row.machine_id,
        status: row.status,
        companyId: row.company_id,
        companyName: row.company_name,
        role: row.role,
        requestedAt: row.requested_at,
        approvedAt: row.approved_at,
        rejectedAt: row.rejected_at,
        revokedAt: row.revoked_at
      }))
    };
  }

  async function listWorkers(filters = {}) {
    const companyId = filters.companyId ? validateCompanyId(filters.companyId) : null;
    const search = String(filters.search || '').trim().slice(0, 100);
    const limit = safeLimit(filters.limit);
    const offset = safeOffset(filters.offset);
    const boundOnly = filters.boundOnly === true || filters.boundOnly === 'true';
    const result = await pool.query(`
      SELECT w.id AS worker_id, w.company_id, w.name AS worker_name, w.status, w.staj, w.role,
             COUNT(*) OVER()::TEXT AS total_count,
             binding.telegram_id, binding.username, binding.linked_at
      FROM workers w
      LEFT JOIN worker_telegram_bindings binding
        ON binding.company_id = w.company_id AND binding.worker_id = w.id
      WHERE ($1::VARCHAR IS NULL OR w.company_id = $1)
        AND (NOT $5::BOOLEAN OR binding.telegram_id IS NOT NULL)
        AND ($2::TEXT = '' OR w.name ILIKE $2 OR w.id::TEXT ILIKE $2 OR COALESCE(binding.telegram_id, '') ILIKE $2)
      ORDER BY w.company_id, w.id
      LIMIT $3 OFFSET $4
    `, [companyId, search ? `%${search}%` : '', limit, offset, boundOnly]);
    return {
      workers: result.rows.map((row) => ({
        workerId: Number(row.worker_id),
        companyId: row.company_id,
        name: row.worker_name,
        status: row.status,
        staj: normalizeNumeric(row.staj),
        role: row.role || null,
        binding: row.telegram_id ? {
          telegramId: row.telegram_id,
          username: row.username || '',
          linkedAt: row.linked_at
        } : null
      })),
      total: parseCount(result.rows[0]?.total_count),
      limit,
      offset
    };
  }

  async function getPayroll(filters = {}) {
    const companyId = validateCompanyId(filters.companyId);
    const requestedPeriodId = filters.periodId === undefined || filters.periodId === null || filters.periodId === ''
      ? null
      : String(filters.periodId).trim();
    if (requestedPeriodId && (requestedPeriodId.length > 128 || /[\u0000-\u001f\u007f]/.test(requestedPeriodId))) {
      throw activationError('INVALID_PERIOD_ID', 400);
    }
    const periodResult = await pool.query(`
      SELECT id, name, start_date, end_date, is_closed
      FROM periods
      WHERE company_id = $1 AND (($2::VARCHAR IS NOT NULL AND id = $2) OR ($2::VARCHAR IS NULL AND is_closed = 0))
      ORDER BY start_date DESC LIMIT 1
    `, [companyId, requestedPeriodId]);
    const period = periodResult.rows[0] || null;
    if (requestedPeriodId && !period) throw activationError('PERIOD_NOT_FOUND', 404);
    const periodId = period?.id || null;
    const startDate = period?.start_date || null;
    const endDate = period?.end_date || null;
    const payrollResult = await pool.query(`
      WITH earnings AS (
        SELECT entry.worker_id,
               COALESCE(SUM(entry.qty * COALESCE(entry.rate_snapshot, rates.rate, 0)), 0)::TEXT AS gross,
               COALESCE(SUM(entry.qty), 0)::TEXT AS pieces
        FROM ticket_entries entry
        JOIN tickets ticket ON ticket.company_id = entry.company_id AND ticket.id = entry.ticket_id
        JOIN models model ON model.company_id = ticket.company_id AND model.id = ticket.model_id
        LEFT JOIN LATERAL (
          SELECT CASE
            WHEN COALESCE(operation_row.value->>'rate', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (operation_row.value->>'rate')::NUMERIC
            ELSE 0::NUMERIC
          END AS rate
          FROM jsonb_array_elements(model.operations_json) AS operation_row(value)
          WHERE operation_row.value->>'name' = entry.op_name
          LIMIT 1
        ) rates ON TRUE
        WHERE entry.company_id = $1 AND ticket.status = 'CONFIRMED'
          AND (($2::VARCHAR IS NULL AND ticket.is_closed = 0)
            OR ($2::VARCHAR IS NOT NULL AND (
              ticket.period_id = $2 OR (ticket.period_id IS NULL
                AND ($3::DATE IS NULL OR ticket.submitted_at::DATE >= $3::DATE)
                AND ($4::DATE IS NULL OR ticket.submitted_at::DATE <= $4::DATE))
            )))
        GROUP BY entry.worker_id
      ), adjustments AS (
        SELECT worker_id,
               COALESCE(SUM(amount) FILTER (WHERE type = 'AVANS'), 0)::TEXT AS avans,
               COALESCE(SUM(amount) FILTER (WHERE type = 'JARIMA'), 0)::TEXT AS jarima
        FROM worker_adjustments
        WHERE company_id = $1
          AND ($2::VARCHAR IS NULL OR period_id = $2 OR (period_id IS NULL
            AND ($3::DATE IS NULL OR created_at::DATE >= $3::DATE)
            AND ($4::DATE IS NULL OR created_at::DATE <= $4::DATE)))
        GROUP BY worker_id
      )
      SELECT worker.id AS worker_id, worker.name AS worker_name, worker.staj,
             COALESCE(earnings.gross, '0') AS gross, COALESCE(earnings.pieces, '0') AS pieces,
             COALESCE(adjustments.avans, '0') AS avans, COALESCE(adjustments.jarima, '0') AS jarima
      FROM workers worker
      LEFT JOIN earnings ON earnings.worker_id = worker.id
      LEFT JOIN adjustments ON adjustments.worker_id = worker.id
      WHERE worker.company_id = $1 AND worker.status = 'ACTIVE'
      ORDER BY worker.id
    `, [companyId, periodId, startDate, endDate]);
    return {
      period: period ? {
        periodId: period.id,
        name: period.name,
        startDate,
        endDate,
        isClosed: Boolean(period.is_closed)
      } : null,
      workers: payrollResult.rows.map((row) => {
        const gross = normalizeNumeric(row.gross);
        const avans = Math.max(0, normalizeNumeric(row.avans));
        const jarima = Math.max(0, normalizeNumeric(row.jarima));
        const staj = Math.max(0, normalizeNumeric(row.staj));
        return {
          workerId: Number(row.worker_id),
          name: row.worker_name,
          gross,
          avans,
          jarima,
          staj,
          net: gross - avans - jarima - staj,
          pieces: normalizeNumeric(row.pieces)
        };
      })
    };
  }

  async function listActivations(filters = {}) {
    const status = filters.status === undefined || filters.status === null || filters.status === ''
      ? null
      : String(filters.status).trim().toUpperCase();
    if (status && !ACTIVATION_STATUSES.has(status)) throw activationError('INVALID_ACTIVATION_STATUS', 400);
    const limit = safeLimit(filters.limit);
    const result = await pool.query(`
      SELECT request_id, machine_id, client_context, status, company_id, company_name, role,
             signed_payload, signature, requested_at, updated_at, approved_at, approved_by_telegram_id,
             rejected_at, rejected_by_telegram_id, rejection_reason, revoked_at, revoked_by_telegram_id
      FROM activation_requests
      WHERE ($1::VARCHAR IS NULL OR status = $1)
      ORDER BY requested_at DESC LIMIT $2
    `, [status, limit]);
    return result.rows.map((row) => ({
      requestId: row.request_id,
      machineId: row.machine_id,
      clientContext: row.client_context || {},
      status: row.status,
      companyId: row.company_id,
      companyName: row.company_name,
      role: row.role,
      signedActivation: row.signed_payload ? { payload: row.signed_payload, signature: row.signature } : null,
      requestedAt: row.requested_at,
      updatedAt: row.updated_at,
      approvedAt: row.approved_at,
      approvedByTelegramId: row.approved_by_telegram_id,
      rejectedAt: row.rejected_at,
      rejectedByTelegramId: row.rejected_by_telegram_id,
      rejectionReason: row.rejection_reason,
      revokedAt: row.revoked_at,
      revokedByTelegramId: row.revoked_by_telegram_id
    }));
  }

  async function getActivationEvents(requestId) {
    const id = validateRequestId(requestId);
    const result = await pool.query(`
      SELECT event_id, event_type, actor_telegram_id, event_metadata, created_at
      FROM activation_events WHERE request_id = $1 ORDER BY event_id
    `, [id]);
    return result.rows.map((row) => ({
      eventId: Number(row.event_id),
      eventType: row.event_type,
      actorTelegramId: row.actor_telegram_id,
      metadata: row.event_metadata || {},
      createdAt: row.created_at
    }));
  }

  async function listModels(filters = {}) {
    const companyId = filters.companyId ? validateCompanyId(filters.companyId) : null;
    const search = String(filters.search || '').trim().slice(0, 100);
    const limit = safeLimit(filters.limit);
    const offset = safeOffset(filters.offset);
    const result = await pool.query(`
      SELECT m.company_id, m.id, m.name, m.operations_json, m.created_at,
             s.available_sizes_json, s.server_revision
      FROM models m
      LEFT JOIN company_batch_settings s ON s.company_id = m.company_id
      WHERE ($1::VARCHAR IS NULL OR m.company_id = $1)
        AND ($2::TEXT = '' OR m.name ILIKE $2 OR m.id ILIKE $2)
      ORDER BY m.company_id, m.name, m.id LIMIT $3 OFFSET $4
    `, [companyId, search ? `%${search}%` : '', limit, offset]);
    return { models: result.rows.map((row) => ({
      companyId: row.company_id, modelId: row.id, name: row.name,
      operations: Array.isArray(row.operations_json) ? row.operations_json : [],
      availableSizes: Array.isArray(row.available_sizes_json) ? row.available_sizes_json : [],
      serverRevision: row.server_revision == null ? null : Number(row.server_revision),
      createdAt: row.created_at
    })), limit, offset };
  }

  async function listParties(filters = {}) {
    const companyId = filters.companyId ? validateCompanyId(filters.companyId) : null;
    const status = String(filters.status || '').trim().toUpperCase();
    if (status && !['ACTIVE', 'CLOSE_PENDING', 'CLOSED'].includes(status)) throw activationError('INVALID_PARTY_STATUS', 400);
    const limit = safeLimit(filters.limit);
    const offset = safeOffset(filters.offset);
    const result = await pool.query(`
      SELECT p.id, p.company_id, p.party_number, p.model_id, COALESCE(p.model_name, m.name) AS model_name,
             p.status, p.patta_count, p.ish_soni, p.created_at, p.updated_at, p.closed_at, p.server_revision
      FROM parties p LEFT JOIN models m ON m.company_id = p.company_id AND m.id = p.model_id
      WHERE ($1::VARCHAR IS NULL OR p.company_id = $1) AND ($2::VARCHAR = '' OR p.status = $2)
      ORDER BY p.company_id, p.created_at DESC, p.id LIMIT $3 OFFSET $4
    `, [companyId, status, limit, offset]);
    return { parties: result.rows.map((row) => ({
      partyRecordId: row.id, partyNumber: row.party_number, companyId: row.company_id,
      modelId: row.model_id, modelName: row.model_name, status: row.status,
      pattaCount: parseCount(row.patta_count), ishSoni: normalizeNumeric(row.ish_soni),
      createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at,
      serverRevision: Number(row.server_revision || 0)
    })), limit, offset };
  }

  async function listTickets(filters = {}) {
    const companyId = filters.companyId ? validateCompanyId(filters.companyId) : null;
    const limit = safeLimit(filters.limit);
    const offset = safeOffset(filters.offset);
    const result = await pool.query(`
      SELECT t.id, t.company_id, t.model_id, m.name AS model_name, t.party_record_id,
             t.party_number, t.patta_number, t.qty, t.status, t.submitted_at,
             e.worker_id, COALESCE(e.worker_name_snapshot, w.name) AS worker_name,
             e.op_name, e.qty AS entry_qty
      FROM tickets t
      JOIN models m ON m.company_id = t.company_id AND m.id = t.model_id
      LEFT JOIN ticket_entries e ON e.company_id = t.company_id AND e.ticket_id = t.id
      LEFT JOIN workers w ON w.company_id = e.company_id AND w.id = e.worker_id
      WHERE ($1::VARCHAR IS NULL OR t.company_id = $1)
      ORDER BY t.submitted_at DESC, t.id, e.worker_id LIMIT $2 OFFSET $3
    `, [companyId, limit, offset]);
    return { tickets: result.rows.map((row) => ({
      ticketId: row.id, companyId: row.company_id, modelId: row.model_id, modelName: row.model_name,
      partyRecordId: row.party_record_id, partyNumber: row.party_number, pattaNumber: row.patta_number,
      quantity: normalizeNumeric(row.entry_qty ?? row.qty), status: row.status,
      effectiveAt: row.submitted_at, workerId: row.worker_id == null ? null : Number(row.worker_id),
      workerName: row.worker_name || null, operation: row.op_name || null
    })), limit, offset };
  }

  async function getBalances(filters = {}) {
    const companyId = validateCompanyId(filters.companyId);
    const result = await pool.query(`
      SELECT a.worker_id, w.name, a.type, SUM(a.amount)::TEXT AS total,
             COUNT(*)::TEXT AS fact_count,
             COUNT(*) FILTER (WHERE a.provenance LIKE 'LEGACY_OPENING_BALANCE%')::TEXT AS opening_fact_count
      FROM worker_adjustments a JOIN workers w ON w.company_id = a.company_id AND w.id = a.worker_id
      WHERE a.company_id = $1 GROUP BY a.worker_id, w.name, a.type ORDER BY a.worker_id, a.type
    `, [companyId]);
    return { companyId, facts: result.rows.map((row) => ({
      workerId: Number(row.worker_id), workerName: row.name, type: row.type,
      total: normalizeNumeric(row.total), factCount: parseCount(row.fact_count),
      openingFactCount: parseCount(row.opening_fact_count)
    })) };
  }

  async function getSystemHealth() {
    const result = await pool.query(`
      SELECT CURRENT_TIMESTAMP AS checked_at,
             (SELECT MAX(version) FROM schema_migrations)::TEXT AS migration_level,
             (SELECT MAX(server_revision) FROM company_batch_settings)::TEXT AS server_revision
    `);
    const row = result.rows[0] || {};
    return { api: 'available', database: 'available', checkedAt: row.checked_at,
      migrationLevel: row.migration_level == null ? null : Number(row.migration_level),
      serverRevision: row.server_revision == null ? null : Number(row.server_revision),
      botStatus: 'not_exposed_by_api', backupStatus: 'not_exposed_by_api' };
  }

  async function updateCompanyStrictMode(telegramId, input = {}) {
    const companyId = validateCompanyId(input.companyId);
    const actor = await actorForCompany(telegramId, companyId);
    if (typeof input.strictMode !== 'boolean') throw activationError('INVALID_STRICT_MODE', 400);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`novda:activation-policy:${companyId}`]);
      const currentResult = await client.query(`
        SELECT policy.company_id, policy.require_ticket_validation, policy.policy_revision
        FROM activation_companies policy
        JOIN company_batch_settings scope ON scope.company_id = policy.company_id
        WHERE policy.company_id = $1 FOR UPDATE OF policy
      `, [companyId]);
      const current = currentResult.rows[0];
      if (!current) throw activationError('ACTIVATION_POLICY_NOT_FOUND', 404);
      const previousStrictMode = Boolean(current.require_ticket_validation);
      let policyRevision = Number(current.policy_revision);
      const policyChanged = previousStrictMode !== input.strictMode;
      if (policyChanged) {
        const updated = await client.query(`
          UPDATE activation_companies
          SET require_ticket_validation = $2, policy_revision = policy_revision + 1,
              updated_by_telegram_id = $3, updated_by_source = 'TELEGRAM_ADMIN', updated_at = NOW()
          WHERE company_id = $1
          RETURNING policy_revision
        `, [companyId, input.strictMode, actor]);
        policyRevision = Number(updated.rows[0].policy_revision);
      }

      const approved = await client.query(`
        SELECT request_id, machine_id, company_id, company_name, role,
               require_ticket_validation, signed_payload, signature
        FROM activation_requests
        WHERE company_id = $1 AND status = 'APPROVED'
        ORDER BY request_id FOR UPDATE
      `, [companyId]);
      let synchronizedDevices = 0;
      for (const row of approved.rows) {
        if (Boolean(row.require_ticket_validation) === input.strictMode) continue;
        const oldPayload = row.signed_payload;
        const expectedOldPayload = {
          companyId: row.company_id,
          companyName: row.company_name,
          machineId: row.machine_id,
          role: row.role,
          requireTicketValidation: Boolean(row.require_ticket_validation),
          status: 'active'
        };
        if (!verifySignedActivation({ payload: oldPayload, signature: row.signature }, expectedOldPayload, publicKey)) {
          throw activationError('ACTIVATION_PAYLOAD_INVALID', 409);
        }
        const previousIssuedAt = Date.parse(oldPayload.issuedAt);
        const nextPayload = {
          ...oldPayload,
          issuedAt: new Date(Math.max(Date.now(), previousIssuedAt + 1)).toISOString(),
          requireTicketValidation: input.strictMode
        };
        const signedActivation = await signPayload(actor, input.sessionToken, nextPayload);
        if (!verifySignedActivation(signedActivation, nextPayload, publicKey)) {
          throw activationError('ACTIVATION_SIGNER_RESPONSE_INVALID', 503);
        }
        await client.query(`
          UPDATE activation_requests
          SET require_ticket_validation = $2, signed_payload = $3, signature = $4, updated_at = NOW()
          WHERE request_id = $1 AND company_id = $5 AND status = 'APPROVED'
        `, [row.request_id, input.strictMode, JSON.stringify(nextPayload), signedActivation.signature, companyId]);
        await client.query(`
          INSERT INTO activation_events (
            request_id, event_type, actor_telegram_id, signed_payload, signature, event_metadata
          ) VALUES ($1, 'POLICY_UPDATED', $2, $3, $4, $5)
        `, [row.request_id, actor, JSON.stringify(nextPayload), signedActivation.signature,
          JSON.stringify({ policyRevision, requireTicketValidation: input.strictMode })]);
        synchronizedDevices += 1;
      }
      if (policyChanged || synchronizedDevices > 0) {
        await client.query(`
          INSERT INTO activation_policy_events (
            company_id, actor_telegram_id, previous_require_ticket_validation,
            require_ticket_validation, policy_revision, synchronized_device_count
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [companyId, actor, previousStrictMode, input.strictMode, policyRevision, synchronizedDevices]);
      }
      await client.query('COMMIT');
      return { companyId, strictMode: input.strictMode, policyRevision, synchronizedDevices };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function upsertCompany(telegramId, input = {}) {
    const companyId = validateCompanyId(input.companyId);
    const actor = await actorForCompany(telegramId, companyId);
    return upsertActivationCompany(pool, {
      companyId,
      companyName: input.companyName,
      allowedRoles: input.allowedRoles,
      isActive: input.isActive
    }, actor, actorAllowlist(actor));
  }

  async function signPayload(telegramId, sessionToken, payload) {
    if (typeof signerClient !== 'function') throw activationError('ACTIVATION_SIGNER_UNAVAILABLE', 503);
    const result = await signerClient({ sessionToken, payload, companyId: payload?.companyId });
    const signedActivation = result?.signedActivation || result;
    if (result?.telegramId != null && String(result.telegramId) !== telegramId) {
      throw activationError('ACTIVATION_SIGNER_IDENTITY_MISMATCH', 503);
    }
    if (!signedActivation?.payload || !signedActivation?.signature) {
      throw activationError('ACTIVATION_SIGNER_RESPONSE_INVALID', 503);
    }
    return signedActivation;
  }

  async function approveActivation(telegramId, input = {}) {
    const requestId = validateRequestId(input.requestId);
    const companyId = validateCompanyId(input.companyId);
    const actor = await actorForCompany(telegramId, companyId);
    const role = String(input.role || '').trim().toLowerCase();
    const detail = await getAdminActivationRequest(pool, requestId);
    if (detail.status !== 'PENDING') throw activationError('ACTIVATION_REQUEST_NOT_PENDING', 409);
    const companies = await listActivationCompanies(pool);
    const company = companies.find((item) => item.company_id === companyId);
    if (!company || !company.allowed_roles.includes(role)) throw activationError('ACTIVATION_ROLE_NOT_ALLOWED', 403);
    const payload = {
      activationId: crypto.randomUUID(),
      companyId: company.company_id,
      companyName: company.company_name,
      expiresAt: null,
      issuedAt: new Date().toISOString(),
      machineId: detail.machine_id,
      requireTicketValidation: company.require_ticket_validation,
      role,
      schema: 'novda-license-v1',
      status: 'active'
    };
    const signedActivation = await signPayload(actor, input.sessionToken, payload);
    return approveActivationRequest(pool, requestId, {
      adminTelegramId: actor,
      companyId,
      role,
      signedActivation
    }, { allowedAdminIds: actorAllowlist(actor), publicKey });
  }

  async function rejectActivation(telegramId, input = {}) {
    const actor = actorId(telegramId);
    return rejectActivationRequest(pool, validateRequestId(input.requestId), {
      adminTelegramId: actor,
      reason: input.reason
    }, allowedAdminIds);
  }

  async function revokeActivation(telegramId, input = {}) {
    const requestId = validateRequestId(input.requestId);
    const detail = await getAdminActivationRequest(pool, requestId);
    if (detail.status !== 'APPROVED' || !detail.activation?.payload) throw activationError('ACTIVATION_NOT_REVOCABLE', 409);
    const actor = await actorForCompany(telegramId, detail.activation.payload.companyId);
    const payload = { ...detail.activation.payload };
    const currentIssuedAt = Date.parse(payload.issuedAt);
    if (!Number.isFinite(currentIssuedAt)) throw activationError('ACTIVATION_PAYLOAD_INVALID', 409);
    payload.issuedAt = new Date(Math.max(Date.now(), currentIssuedAt + 1)).toISOString();
    payload.status = 'revoked';
    const signedActivation = await signPayload(actor, input.sessionToken, payload);
    return revokeActivationRequest(pool, requestId, {
      adminTelegramId: actor,
      signedActivation
    }, { allowedAdminIds: actorAllowlist(actor), publicKey });
  }

  return {
    overview,
    listCompanies,
    listDevices,
    listWorkers,
    getPayroll,
    listActivations,
    getActivationEvents,
    listModels,
    listParties,
    listTickets,
    getBalances,
    getSystemHealth,
    updateCompanyStrictMode,
    upsertCompany,
    approveActivation,
    rejectActivation,
    revokeActivation
  };
}

module.exports = {
  createAdminDashboardService,
  parseCount,
  safeLimit,
  safeOffset,
  validateCompanyId,
  validateRequestId
};
