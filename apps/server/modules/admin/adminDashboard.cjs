'use strict';
const { loadPayroll } = require('../workers/payrollValuation.cjs');

const { activationError } = require('../activation/activationRequests.cjs');
const { assertCompanyAccess, resolveAdminAccess } = require('./adminAccess.cjs');
const { unbindWorkerTelegramBinding } = require('../workers/workerService.cjs');
const { processSingleOperation } = require('../sync/handlers/operations.cjs');
const { canonicalStringify, computePayloadHash } = require('../sync/canonicalPayload.cjs');

const COMPANY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  return String(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0] || null;
}

function getTashkentDateString(date = new Date()) {
  const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date(date);
  const valid = Number.isFinite(d.getTime()) ? d : new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(valid);
}

function createAdminDashboardService(options = {}) {
  const { pool } = options;
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');

  async function actorForCompany(value, companyId) {
    const telegramId = String(value || '').trim();
    if (!/^\d{1,24}$/.test(telegramId)) throw activationError('ADMIN_TELEGRAM_ID_NOT_AUTHORIZED', 403);
    const access = await resolveAdminAccess(pool, telegramId);
    assertCompanyAccess(access, companyId);
    return telegramId;
  }

  async function overview(filters = {}) {
    const companyId = filters.companyId ? validateCompanyId(filters.companyId) : null;
    const result = await pool.query(`
      WITH companies AS (
        SELECT company_id FROM activation_companies WHERE ($1::VARCHAR IS NULL OR company_id = $1)
        UNION SELECT company_id FROM workers WHERE ($1::VARCHAR IS NULL OR company_id = $1)
        UNION SELECT company_id FROM models WHERE ($1::VARCHAR IS NULL OR company_id = $1)
        UNION SELECT company_id FROM parties WHERE ($1::VARCHAR IS NULL OR company_id = $1)
        UNION SELECT company_id FROM periods WHERE ($1::VARCHAR IS NULL OR company_id = $1)
      )
      SELECT
        (SELECT COUNT(*) FROM companies)::TEXT AS company_count,
        (SELECT COUNT(*) FROM workers WHERE status = 'ACTIVE' AND ($1::VARCHAR IS NULL OR company_id = $1))::TEXT AS worker_count,
        (SELECT COUNT(*) FROM models WHERE status = 'ACTIVE' AND ($1::VARCHAR IS NULL OR company_id = $1))::TEXT AS model_count,
        (SELECT COUNT(*) FROM parties WHERE status != 'CLOSED' AND ($1::VARCHAR IS NULL OR company_id = $1))::TEXT AS party_count,
        (SELECT COUNT(*) FROM server_devices WHERE is_revoked = FALSE AND ($1::VARCHAR IS NULL OR company_id = $1))::TEXT AS device_count,
        (SELECT COUNT(*) FROM activation_requests WHERE status = 'PENDING'
          AND ($1::VARCHAR IS NULL OR company_id = $1 OR company_id IS NULL))::TEXT AS pending_activation_count,
        (SELECT COUNT(*) FROM activation_requests WHERE status = 'APPROVED' AND ($1::VARCHAR IS NULL OR company_id = $1))::TEXT AS active_activation_count,
        (SELECT COUNT(*) FROM worker_telegram_bindings WHERE ($1::VARCHAR IS NULL OR company_id = $1))::TEXT AS worker_binding_count,
        (SELECT MAX(committed_at) FROM change_log WHERE ($1::VARCHAR IS NULL OR company_id = $1)) AS recent_sync_at
    `, [companyId]);
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

  async function listDevices(filters = {}) {
    const companyId = filters.companyId ? validateCompanyId(filters.companyId) : null;
    const [registeredResult, activationResult] = await Promise.all([
      pool.query(`
        SELECT device_id, company_id, client_version, is_revoked, registered_at
        FROM server_devices WHERE ($1::VARCHAR IS NULL OR company_id = $1)
        ORDER BY registered_at DESC, device_id LIMIT 500
      `, [companyId]),
      pool.query(`
        SELECT request_id, machine_id, status, company_id, company_name, role,
               requested_at, approved_at, rejected_at, revoked_at
        FROM activation_requests WHERE ($1::VARCHAR IS NULL OR company_id = $1)
        ORDER BY requested_at DESC LIMIT 500
      `, [companyId])
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
             w.server_revision, w.updated_at,
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
        serverRevision: Number(row.server_revision || 0),
        updatedAt: row.updated_at,
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
    return loadPayroll(pool, companyId, filters.periodId);
  }

  async function listPeriods(telegramId, companyId) {
    const scopedCompanyId = validateCompanyId(companyId);
    await actorForCompany(telegramId, scopedCompanyId);
    const result = await pool.query(`SELECT id, name, start_date::text AS start_date, end_date::text AS end_date, is_closed, server_revision
      FROM periods WHERE company_id = $1 ORDER BY start_date DESC, id DESC LIMIT 100`, [scopedCompanyId]);
    return result.rows.map((row) => ({
      periodId: row.id,
      name: row.name,
      startDate: String(row.start_date).slice(0, 10),
      endDate: row.end_date ? String(row.end_date).slice(0, 10) : null,
      isClosed: Boolean(row.is_closed),
      serverRevision: Number(row.server_revision || 0)
    }));
  }

  async function listModels(filters = {}) {
    const companyId = filters.companyId ? validateCompanyId(filters.companyId) : null;
    const search = String(filters.search || '').trim().slice(0, 100);
    const limit = safeLimit(filters.limit);
    const offset = safeOffset(filters.offset);
    const result = await pool.query(`
      SELECT m.company_id, m.id, m.name, m.operations_json, m.created_at,
             m.server_revision AS model_server_revision,
             s.available_sizes_json, s.server_revision AS settings_server_revision
      FROM models m
      LEFT JOIN company_batch_settings s ON s.company_id = m.company_id
      WHERE ($1::VARCHAR IS NULL OR m.company_id = $1)
        AND ($2::TEXT = '' OR m.name ILIKE $2 OR m.id ILIKE $2)
      ORDER BY m.company_id, m.name, m.id LIMIT $3 OFFSET $4
    `, [companyId, search ? `%${search}%` : '', limit, offset]);
    return { models: result.rows.map((row) => ({
      companyId: row.company_id, modelId: row.id, name: row.name,
      operations: Array.isArray(row.operations_json) ? row.operations_json : [],
      modelRevision: Number(row.model_server_revision || 0),
      availableSizes: Array.isArray(row.available_sizes_json) ? row.available_sizes_json : [],
      serverRevision: row.settings_server_revision == null ? null : Number(row.settings_server_revision),
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
             t.period_id,
             e.worker_id, COALESCE(e.worker_name_snapshot, w.name) AS worker_name,
             e.op_name, e.qty AS entry_qty, e.rate_snapshot
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
      quantity: normalizeNumeric(row.entry_qty ?? row.qty), ticketQty: normalizeNumeric(row.qty),
      status: row.status, periodId: row.period_id || null,
      rate: row.rate_snapshot != null ? normalizeNumeric(row.rate_snapshot) : null,
      effectiveAt: row.submitted_at, workerId: row.worker_id == null ? null : Number(row.worker_id),
      workerName: row.worker_name || null, operation: row.op_name || null
    })), limit, offset };
  }

  async function dailyProductionReport(filters = {}) {
    const companyId = filters.companyId ? validateCompanyId(filters.companyId) : null;
    const targetDate = typeof filters.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(filters.date.trim())
      ? filters.date.trim()
      : getTashkentDateString();

    const [cutResult, entryResult, adminsResult, companiesResult] = await Promise.all([
      // Printing creates party issuance records, not submitted work tickets.
      // Keep the ticket_count alias for the existing bot/WebApp response contract.
      pool.query(`
        SELECT 
          p.company_id,
          COALESCE(c.company_name, p.company_id) AS company_name,
          p.model_id,
          COALESCE(m.name, p.model_name, p.model_id, 'Noma''lum') AS model_name,
          COALESCE(SUM(p.patta_count), 0)::int AS ticket_count,
          COALESCE(SUM(COALESCE(p.total_ish_soni, p.ish_soni)), 0)::numeric AS qty
        FROM parties p
        LEFT JOIN activation_companies c ON c.company_id = p.company_id
        LEFT JOIN models m ON m.company_id = p.company_id AND m.id = p.model_id
        WHERE ($1::VARCHAR IS NULL OR p.company_id = $1)
          AND (COALESCE(p.printed_at, p.created_at) AT TIME ZONE 'Asia/Tashkent')::date = $2::date
        GROUP BY p.company_id, c.company_name, p.model_id,
          COALESCE(m.name, p.model_name, p.model_id, 'Noma''lum')
        ORDER BY p.company_id, qty DESC, model_name ASC
      `, [companyId, targetDate]),
      pool.query(`
        SELECT 
          e.company_id,
          COALESCE(c.company_name, e.company_id) AS company_name,
          t.model_id,
          COALESCE(m.name, t.model_id, 'Noma''lum') AS model_name,
          COUNT(e.id)::int AS entry_count,
          COALESCE(SUM(e.qty), 0)::numeric AS qty
        FROM ticket_entries e
        LEFT JOIN tickets t ON t.company_id = e.company_id AND t.id = e.ticket_id
        LEFT JOIN activation_companies c ON c.company_id = e.company_id
        LEFT JOIN models m ON m.company_id = t.company_id AND m.id = t.model_id
        WHERE ($1::VARCHAR IS NULL OR e.company_id = $1)
          AND (COALESCE(e.created_at, NOW()) AT TIME ZONE 'Asia/Tashkent')::date = $2::date
        GROUP BY e.company_id, c.company_name, t.model_id, m.name
        ORDER BY e.company_id, qty DESC, model_name ASC
      `, [companyId, targetDate]),
      pool.query(`
        SELECT company_id, telegram_id
        FROM activation_company_admins
        WHERE ($1::VARCHAR IS NULL OR company_id = $1)
          AND is_active = TRUE
        ORDER BY company_id, telegram_id
      `, [companyId]),
      pool.query(`
        SELECT company_id, company_name
        FROM activation_companies
        WHERE ($1::VARCHAR IS NULL OR company_id = $1)
          AND is_active = TRUE
        ORDER BY company_id
      `, [companyId])
    ]);

    const companyMap = new Map();

    function getOrCreateCompany(cId, cName) {
      if (!companyMap.has(cId)) {
        companyMap.set(cId, {
          companyId: cId,
          companyName: cName || cId,
          adminTelegramIds: [],
          cutProduction: {
            totalQty: 0,
            totalTickets: 0,
            byModel: []
          },
          enteredProduction: {
            totalQty: 0,
            totalEntries: 0,
            byModel: []
          }
        });
      }
      const existing = companyMap.get(cId);
      if (cName && (!existing.companyName || existing.companyName === cId)) {
        existing.companyName = cName;
      }
      return existing;
    }

    if (companyId) {
      getOrCreateCompany(companyId, companiesResult.rows[0]?.company_name || companyId);
    }
    for (const row of companiesResult.rows) {
      getOrCreateCompany(row.company_id, row.company_name);
    }
    for (const row of adminsResult.rows) {
      const comp = getOrCreateCompany(row.company_id, null);
      if (!comp.adminTelegramIds.includes(row.telegram_id)) {
        comp.adminTelegramIds.push(row.telegram_id);
      }
    }
    for (const row of cutResult.rows) {
      const comp = getOrCreateCompany(row.company_id, row.company_name);
      const qty = normalizeNumeric(row.qty);
      const ticketCount = parseCount(row.ticket_count);
      comp.cutProduction.totalQty += qty;
      comp.cutProduction.totalTickets += ticketCount;
      comp.cutProduction.byModel.push({
        modelId: row.model_id,
        modelName: row.model_name,
        qty,
        ticketCount
      });
    }
    for (const row of entryResult.rows) {
      const comp = getOrCreateCompany(row.company_id, row.company_name);
      const qty = normalizeNumeric(row.qty);
      const entryCount = parseCount(row.entry_count);
      comp.enteredProduction.totalQty += qty;
      comp.enteredProduction.totalEntries += entryCount;
      comp.enteredProduction.byModel.push({
        modelId: row.model_id,
        modelName: row.model_name,
        qty,
        entryCount
      });
    }

    const reports = Array.from(companyMap.values());
    return {
      date: targetDate,
      companyId: companyId || null,
      report: companyId ? (reports[0] || null) : null,
      reports
    };
  }

  async function getBalances(filters = {}) {
    const companyId = validateCompanyId(filters.companyId);
    const requestedPeriodId = filters.periodId === undefined || filters.periodId === null || filters.periodId === ''
      ? null
      : String(filters.periodId).trim();
    if (requestedPeriodId && (requestedPeriodId.length > 128 || /[\u0000-\u001f\u007f]/.test(requestedPeriodId))) {
      throw activationError('INVALID_PERIOD_ID', 400);
    }
    const periodResult = await pool.query(`
      SELECT id, name, start_date::text AS start_date, end_date::text AS end_date, is_closed
      FROM periods
      WHERE company_id = $1
        AND (($2::VARCHAR IS NOT NULL AND id = $2) OR ($2::VARCHAR IS NULL AND is_closed = 0))
      ORDER BY start_date DESC, id DESC LIMIT 1
    `, [companyId, requestedPeriodId]);
    const period = periodResult.rows[0] || null;
    if (requestedPeriodId && !period) throw activationError('PERIOD_NOT_FOUND', 404);
    if (!period) return { companyId, period: null, facts: [] };

    const startDate = period.start_date ? String(period.start_date).slice(0, 10) : null;
    const endDate = period.end_date ? String(period.end_date).slice(0, 10) : null;
    const result = await pool.query(`
      SELECT a.worker_id, w.name, a.type, SUM(a.amount)::TEXT AS total,
             COUNT(*)::TEXT AS fact_count,
             COUNT(*) FILTER (WHERE a.provenance LIKE 'LEGACY_OPENING_BALANCE%')::TEXT AS opening_fact_count
      FROM worker_adjustments a JOIN workers w ON w.company_id = a.company_id AND w.id = a.worker_id
      WHERE a.company_id = $1
        AND (a.period_id = $2 OR (a.period_id IS NULL
          AND ($3::DATE IS NULL OR a.created_at::DATE >= $3::DATE)
          AND ($4::DATE IS NULL OR a.created_at::DATE <= $4::DATE)))
      GROUP BY a.worker_id, w.name, a.type ORDER BY a.worker_id, a.type
    `, [companyId, period.id, startDate, endDate]);
    return { companyId, period: {
      periodId: period.id,
      name: period.name,
      startDate,
      endDate,
      isClosed: Boolean(period.is_closed)
    }, facts: result.rows.map((row) => ({
      workerId: Number(row.worker_id), workerName: row.name, type: row.type,
      total: normalizeNumeric(row.total), factCount: parseCount(row.fact_count),
      openingFactCount: parseCount(row.opening_fact_count)
    })) };
  }

  async function runWorkerCommand(telegramId, { companyId, workerId, baseRevision, commandType, payload }) {
    const actor = await actorForCompany(telegramId, companyId);
    const operationId = String(payload.operationId || '').trim();
    const commandId = String(payload.commandId || '').trim();
    if (!UUID_PATTERN.test(operationId) || !UUID_PATTERN.test(commandId)) throw activationError('INVALID_OPERATION_ID', 400);
    const completePayload = { ...payload, companyId, workerId: Number(workerId), operationId, commandId, baseRevision };
    const canonicalPayload = canonicalStringify(completePayload);
    const operation = {
      operationId,
      companyId,
      commandType,
      entityType: 'worker',
      entityId: String(workerId),
      baseRevision,
      payloadHash: computePayloadHash(canonicalPayload),
      payload: completePayload
    };
    const result = await processSingleOperation(pool, {
      auth: { companyId, deviceId: `admin-webapp:${actor}`, adminTelegramId: actor }
    }, operation);
    if (result.status !== 'APPLIED') {
      const code = result.error?.code || 'WORKER_ADMIN_MUTATION_FAILED';
      const statusCode = ['WORKER_NOT_FOUND', 'ACTIVATION_COMPANY_NOT_FOUND'].includes(code)
        ? 404
        : ['REVISION_CONFLICT', 'WORKER_INACTIVE', 'WORKER_ALREADY_ACTIVE', 'PERIOD_CLOSED', 'OPEN_PERIOD_REQUIRED'].includes(code) ? 409 : 400;
      throw activationError(code, statusCode, result.error?.message || code);
    }
    return result;
  }

  async function runAdminWorkbookCommand(telegramId, companyId, commandType, entityType, entityId, baseRevision, payload) {
    const actor = await actorForCompany(telegramId, companyId);
    const operationId = String(payload.operationId || '').trim();
    const commandId = String(payload.commandId || '').trim();
    if (!UUID_PATTERN.test(operationId) || !UUID_PATTERN.test(commandId)) throw activationError('INVALID_OPERATION_ID', 400);
    const completePayload = { ...payload, companyId, operationId, commandId, baseRevision };
    const canonicalPayload = canonicalStringify(completePayload);
    const operation = {
      operationId, companyId, commandType, entityType, entityId: String(entityId), baseRevision,
      payloadHash: computePayloadHash(canonicalPayload), payload: completePayload
    };
    const result = await processSingleOperation(pool, {
      auth: { companyId, deviceId: `admin-webapp:${actor}`, adminTelegramId: actor }
    }, operation);
    if (result.status !== 'APPLIED') {
      const code = result.error?.code || 'ADMIN_WORKBOOK_MUTATION_FAILED';
      const statusCode = ['MODEL_NOT_FOUND', 'PERIOD_NOT_FOUND'].includes(code) ? 404
        : ['REVISION_CONFLICT', 'MODEL_INACTIVE', 'PERIOD_ALREADY_CLOSED', 'OPEN_PERIOD_EXISTS', 'PERIOD_EXISTS'].includes(code) ? 409 : 400;
      throw activationError(code, statusCode, result.error?.message || code);
    }
    return result;
  }

  async function updateModelRates(telegramId, input = {}) {
    const companyId = validateCompanyId(input.companyId);
    await actorForCompany(telegramId, companyId);
    const modelId = String(input.modelId || '').trim();
    if (!modelId || modelId.length > 128) throw activationError('INVALID_MODEL_ID', 400);
    const baseRevision = Number(input.baseRevision);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw activationError('INVALID_BASE_REVISION', 400);
    if (!Array.isArray(input.operations) || input.operations.length > 128) throw activationError('INVALID_MODEL_OPERATIONS', 400);

    const result = await pool.query(`SELECT id, name, operations_json, patta_ops_order_json, server_revision,
      hisob_sheet_name, title, party, color, size, status FROM models WHERE company_id = $1 AND id = $2`, [companyId, modelId]);
    const model = result.rows[0];
    if (!model) throw activationError('MODEL_NOT_FOUND', 404);
    if (model.status !== 'ACTIVE') throw activationError('MODEL_INACTIVE', 409);
    const stored = Array.isArray(model.operations_json) ? model.operations_json : [];
    const updates = new Map();
    for (const operation of input.operations) {
      const name = String(operation?.name || '').trim();
      const rate = Number(operation?.rate);
      if (!['number', 'string'].includes(typeof operation?.rate) || (typeof operation.rate === 'string' && !operation.rate.trim())
        || !name || name.length > 256
        || !Number.isSafeInteger(rate) || rate < 0 || updates.has(name.toLocaleLowerCase())) {
        throw activationError('INVALID_MODEL_OPERATIONS', 400);
      }
      updates.set(name.toLocaleLowerCase(), rate);
    }
    if (updates.size !== stored.length || stored.some((operation) => !updates.has(String(operation.name || '').toLocaleLowerCase()))) {
      throw activationError('MODEL_OPERATIONS_MISMATCH', 409);
    }
    const operations = stored.map((operation) => ({ ...operation, rate: updates.get(String(operation.name).toLocaleLowerCase()) }));
    const operationId = String(input.operationId || '');
    const commandId = String(input.commandId || '');
    return runAdminWorkbookCommand(telegramId, companyId, 'UpsertModel', 'model', modelId, baseRevision, {
      operationId, commandId, modelId, name: model.name, operations,
      pattaOpsOrder: Array.isArray(model.patta_ops_order_json) ? model.patta_ops_order_json : stored.map((operation) => operation.name),
      hisobSheetName: model.hisob_sheet_name || `${model.name}-hisob`,
      title: model.title || `Model- ${model.name}`, party: model.party || '', color: model.color || null, size: model.size || null
    });
  }

  async function closePeriod(telegramId, input = {}) {
    const companyId = validateCompanyId(input.companyId);
    await actorForCompany(telegramId, companyId);
    const periodId = String(input.periodId || '').trim();
    if (!periodId || periodId.length > 128) throw activationError('INVALID_PERIOD_ID', 400);
    const baseRevision = Number(input.baseRevision);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw activationError('INVALID_BASE_REVISION', 400);
    const endDate = String(input.endDate || '').trim();
    const nextPeriod = input.nextPeriod;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !nextPeriod || typeof nextPeriod !== 'object') {
      throw activationError('INVALID_PERIOD_RANGE', 400);
    }
    return runAdminWorkbookCommand(telegramId, companyId, 'ClosePeriod', 'period', periodId, baseRevision, {
      operationId: String(input.operationId || ''), commandId: String(input.commandId || ''), periodId, endDate,
      nextPeriod: { id: String(nextPeriod.id || ''), name: String(nextPeriod.name || ''), startDate: String(nextPeriod.startDate || '') },
      ...(input.archiveFilename ? { archiveFilename: String(input.archiveFilename) } : {})
    });
  }

  async function updateWorker(telegramId, input = {}) {
    const companyId = validateCompanyId(input.companyId);
    await actorForCompany(telegramId, companyId);
    const workerId = Number(input.workerId);
    if (!Number.isSafeInteger(workerId) || workerId <= 0) throw activationError('INVALID_WORKER_ID', 400);
    const baseRevision = Number(input.baseRevision);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw activationError('INVALID_BASE_REVISION', 400);
    const currentResult = await pool.query(`SELECT id, name, staj, role, status FROM workers
      WHERE company_id = $1 AND id = $2`, [companyId, workerId]);
    const current = currentResult.rows[0];
    if (!current) throw activationError('WORKER_NOT_FOUND', 404);
    if (current.status !== 'ACTIVE') throw activationError('WORKER_INACTIVE', 409);

    const name = String(input.name ?? current.name).trim();
    const staj = Number(input.staj ?? current.staj ?? 0);
    const role = input.role === undefined ? current.role : String(input.role || '').trim() || null;
    if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) throw activationError('INVALID_WORKER_NAME', 400);
    if (!Number.isFinite(staj) || staj < 0) throw activationError('INVALID_WORKER_STAJ', 400);
    if (role !== null && role.length > 128) throw activationError('INVALID_WORKER_ROLE', 400);

    const balanceAdjustments = [];
    if (input.adjustment !== undefined && input.adjustment !== null) {
      const adjustment = input.adjustment;
      const type = String(adjustment.type || '').trim().toUpperCase();
      const amountDelta = Number(adjustment.amountDelta);
      const description = String(adjustment.description || '').trim();
      if (!['AVANS', 'JARIMA'].includes(type)) throw activationError('INVALID_WORKER_ADJUSTMENT_TYPE', 400);
      if (!Number.isFinite(amountDelta) || amountDelta <= 0) throw activationError('INVALID_WORKER_ADJUSTMENT_AMOUNT', 400);
      if (!description || description.length > 500) throw activationError('INVALID_WORKER_ADJUSTMENT_DESCRIPTION', 400);
      const periodId = String(adjustment.periodId || '').trim();
      if (!periodId || periodId.length > 128 || /[\u0000-\u001f\u007f]/.test(periodId)) throw activationError('INVALID_PERIOD_ID', 400);
      const periodResult = await pool.query(`SELECT id FROM periods
        WHERE company_id = $1 AND id = $2 AND is_closed = 0`, [companyId, periodId]);
      if (!periodResult.rows.length) throw activationError('PERIOD_CLOSED', 409);
      const adjustmentId = String(adjustment.adjustmentId || '').trim();
      if (!UUID_PATTERN.test(adjustmentId)) throw activationError('INVALID_WORKER_ADJUSTMENT_ID', 400);
      balanceAdjustments.push({ adjustmentId, type, amountDelta, periodId: periodResult.rows[0].id, description });
    }

    return runWorkerCommand(telegramId, {
      companyId, workerId, baseRevision, commandType: 'UpsertWorker',
      payload: {
        operationId: input.operationId,
        commandId: input.commandId,
        name, staj, role,
        balanceAdjustments
      }
    });
  }

  async function setWorkerStatus(telegramId, input = {}) {
    const companyId = validateCompanyId(input.companyId);
    const workerId = Number(input.workerId);
    if (!Number.isSafeInteger(workerId) || workerId <= 0) throw activationError('INVALID_WORKER_ID', 400);
    const baseRevision = Number(input.baseRevision);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw activationError('INVALID_BASE_REVISION', 400);
    const status = String(input.status || '').trim().toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(status)) throw activationError('INVALID_WORKER_STATUS', 400);
    return runWorkerCommand(telegramId, {
      companyId, workerId, baseRevision,
      commandType: status === 'ACTIVE' ? 'ActivateWorker' : 'DeactivateWorker',
      payload: { operationId: input.operationId, commandId: input.commandId }
    });
  }

  async function unbindWorkerTelegram(telegramId, input = {}) {
    const companyId = validateCompanyId(input.companyId);
    const actor = await actorForCompany(telegramId, companyId);
    return unbindWorkerTelegramBinding(pool, {
      companyId,
      workerId: input.workerId,
      telegramId: input.telegramId,
      adminTelegramId: actor
    });
  }

  return {
    overview,
    listCompanies,
    listDevices,
    listWorkers,
    getPayroll,
    listPeriods,
    closePeriod,
    updateModelRates,
    updateWorker,
    setWorkerStatus,
    listModels,
    listParties,
    listTickets,
    dailyProductionReport,
    getBalances,
    unbindWorkerTelegram
  };
}

module.exports = {
  createAdminDashboardService,
  getTashkentDateString,
  parseCount,
  safeLimit,
  safeOffset,
  validateCompanyId,
  validateRequestId
};
