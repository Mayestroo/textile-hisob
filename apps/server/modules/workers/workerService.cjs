'use strict';

const crypto = require('crypto');
const { assertCompanyAccess, resolveAdminAccess } = require('../admin/adminAccess.cjs');
const { loadPayroll } = require('./payrollValuation.cjs');

const PIN_WINDOW_MS = 10 * 60 * 1000;
const PIN_ATTEMPT_LIMIT = 5;

function workerError(code, statusCode, message = code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeWorkerParams(input) {
  const companyId = String(input?.companyId || '').trim();
  const workerId = Number(input?.workerId);
  const telegramId = String(input?.telegramId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(companyId)) throw workerError('INVALID_COMPANY_ID', 400);
  if (!Number.isSafeInteger(workerId) || workerId < 0) throw workerError('INVALID_WORKER_ID', 400);
  if (!/^\d{1,24}$/.test(telegramId)) throw workerError('INVALID_TELEGRAM_ID', 400);
  return { companyId, workerId, telegramId };
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

async function getWorkerBindingByTelegram(pool, telegramId) {
  if (!/^\d{1,24}$/.test(String(telegramId || ''))) throw workerError('INVALID_TELEGRAM_ID', 400);
  const result = await pool.query(
    `SELECT b.telegram_id, b.company_id, b.worker_id, b.username, b.linked_at, w.name AS worker_name
     FROM worker_telegram_bindings b
     JOIN workers w ON w.company_id = b.company_id AND w.id = b.worker_id
     WHERE b.telegram_id = $1 AND w.status = 'ACTIVE'`,
    [String(telegramId)]
  );
  return result.rows[0] || null;
}

async function getWorkerBindingByWorker(pool, companyId, workerId) {
  const normalized = normalizeWorkerParams({ companyId, workerId, telegramId: '0' });
  const result = await pool.query(
    `SELECT b.telegram_id, b.company_id, b.worker_id, b.username, b.linked_at, w.name AS worker_name
     FROM worker_telegram_bindings b
     JOIN workers w ON w.company_id = b.company_id AND w.id = b.worker_id
     WHERE b.company_id = $1 AND b.worker_id = $2 AND w.status = 'ACTIVE'`,
    [normalized.companyId, normalized.workerId]
  );
  return result.rows[0] || null;
}

async function getWorkerForEnrollment(pool, companyId, workerId, options = {}) {
  const pinRequired = options.pinRequired !== false;
  const normalized = normalizeWorkerParams({ companyId, workerId, telegramId: '0' });
  const result = await pool.query(
    `SELECT w.id AS worker_id, w.company_id, w.name AS worker_name, w.status, w.staj,
            EXISTS (SELECT 1 FROM worker_credentials c WHERE c.company_id = w.company_id AND c.worker_id = w.id) AS pin_configured
     FROM workers w
     JOIN activation_companies company ON company.company_id = w.company_id AND company.is_active = TRUE
     WHERE w.company_id = $1 AND w.id = $2`,
    [normalized.companyId, normalized.workerId]
  );
  const worker = result.rows[0];
  if (!worker || worker.status !== 'ACTIVE') throw workerError('WORKER_NOT_FOUND', 404);
  return {
    ...worker,
    pin_required: pinRequired,
    pin_configured: worker.pin_configured === true
  };
}

function hashWorkerPin(pin, salt = crypto.randomBytes(16)) {
  if (typeof pin !== 'string' || !pin.trim()) return null;
  const hash = crypto.scryptSync(pin.trim(), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt, hash };
}

function verifyWorkerPin(pin, salt, expectedHash) {
  if (typeof pin !== 'string' || !pin.trim()) return false;
  try {
    const actual = crypto.scryptSync(pin.trim(), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return actual.length === expectedHash.length && crypto.timingSafeEqual(actual, expectedHash);
  } catch {
    return false;
  }
}

async function claimWorkerBinding(pool, input, options = {}) {
  const pinRequired = options.pinRequired !== false;
  const params = normalizeWorkerParams(input);
  const username = String(input?.username || '').slice(0, 64);
  const result = await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`novda:worker-binding:${params.companyId}:${params.workerId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`novda:worker-telegram:${params.telegramId}`]);

    const existingTelegram = await client.query(
      `SELECT telegram_id, company_id, worker_id, username FROM worker_telegram_bindings WHERE telegram_id = $1 FOR UPDATE`,
      [params.telegramId]
    );
    if (existingTelegram.rows.length) {
      const binding = existingTelegram.rows[0];
      if (binding.company_id !== params.companyId || Number(binding.worker_id) !== params.workerId) {
        return { error: workerError('TELEGRAM_ACCOUNT_ALREADY_BOUND', 409) };
      }
    }

    const workerResult = await client.query(
      `SELECT w.id, w.company_id, w.name, w.status, credential.pin_salt, credential.pin_hash
       FROM workers w
       JOIN activation_companies company ON company.company_id = w.company_id AND company.is_active = TRUE
       LEFT JOIN worker_credentials credential ON credential.company_id = w.company_id AND credential.worker_id = w.id
       WHERE w.company_id = $1 AND w.id = $2 FOR UPDATE OF w`,
      [params.companyId, params.workerId]
    );
    const worker = workerResult.rows[0];
    if (!worker || worker.status !== 'ACTIVE') return { error: workerError('WORKER_NOT_FOUND', 404) };
    if (existingTelegram.rows.length) {
      // A lost-response retry has the same public DTO as a fresh claim. Read the
      // current active worker name, retain the stored username, and require no PIN
      // or additional write for the already verified, identical binding.
      return { binding: { ...existingTelegram.rows[0], worker_name: worker.name } };
    }
    if (pinRequired && (!worker.pin_salt || !worker.pin_hash)) {
      return { error: workerError('WORKER_ENROLLMENT_NOT_CONFIGURED', 409) };
    }
    if (pinRequired && !verifyWorkerPin(input?.pin, worker.pin_salt, worker.pin_hash)) {
      const attempts = await client.query(
        `SELECT failed_count, window_started_at FROM worker_binding_limits
         WHERE telegram_id = $1 AND company_id = $2 FOR UPDATE`,
        [params.telegramId, params.companyId]
      );
      const previous = attempts.rows[0];
      const now = Date.now();
      const inWindow = previous && Number.isFinite(Date.parse(previous.window_started_at))
        && now - Date.parse(previous.window_started_at) < PIN_WINDOW_MS;
      if (inWindow && Number(previous.failed_count) >= PIN_ATTEMPT_LIMIT) {
        return { error: workerError('WORKER_PIN_RATE_LIMITED', 429) };
      }
      if (!previous) {
        await client.query(
          `INSERT INTO worker_binding_limits (telegram_id, company_id, failed_count, window_started_at)
           VALUES ($1, $2, 1, NOW())`,
          [params.telegramId, params.companyId]
        );
      } else if (inWindow) {
        await client.query(
          `UPDATE worker_binding_limits SET failed_count = failed_count + 1, updated_at = NOW()
           WHERE telegram_id = $1 AND company_id = $2`,
          [params.telegramId, params.companyId]
        );
      } else {
        await client.query(
          `UPDATE worker_binding_limits SET failed_count = 1, window_started_at = NOW(), updated_at = NOW()
           WHERE telegram_id = $1 AND company_id = $2`,
          [params.telegramId, params.companyId]
        );
      }
      return { error: workerError('WORKER_PIN_INVALID', 401) };
    }

    const claimed = await client.query(
      `SELECT telegram_id FROM worker_telegram_bindings WHERE company_id = $1 AND worker_id = $2 FOR UPDATE`,
      [params.companyId, params.workerId]
    );
    if (claimed.rows.length) return { error: workerError('WORKER_ALREADY_BOUND', 409) };

    await client.query(
      `INSERT INTO worker_telegram_bindings (telegram_id, company_id, worker_id, username)
       VALUES ($1, $2, $3, $4)`,
      [params.telegramId, params.companyId, params.workerId, username]
    );
    await client.query(
      `DELETE FROM worker_binding_limits WHERE telegram_id = $1 AND company_id = $2`,
      [params.telegramId, params.companyId]
    );
    return {
      binding: {
        telegram_id: params.telegramId,
        company_id: params.companyId,
        worker_id: params.workerId,
        worker_name: worker.name,
        username
      }
    };
  });
  if (result.error) throw result.error;
  return result.binding;
}

async function unbindWorkerTelegramBinding(pool, input) {
  const companyId = String(input?.companyId || '').trim();
  const workerId = Number(input?.workerId);
  const telegramId = String(input?.telegramId || '').trim();
  const adminTelegramId = String(input?.adminTelegramId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(companyId)) throw workerError('INVALID_COMPANY_ID', 400);
  if (!Number.isSafeInteger(workerId) || workerId <= 0) throw workerError('INVALID_WORKER_ID', 400);
  if (!/^\d{1,24}$/.test(telegramId) || !/^\d{1,24}$/.test(adminTelegramId)) {
    throw workerError('INVALID_TELEGRAM_ID', 400);
  }

  const access = await resolveAdminAccess(pool, adminTelegramId);
  try {
    assertCompanyAccess(access, companyId);
  } catch (error) {
    throw workerError(error.code || 'ADMIN_COMPANY_SCOPE_REQUIRED', 403);
  }

  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`novda:worker-binding:${companyId}:${workerId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`novda:worker-telegram:${telegramId}`]);
    const existingResult = await client.query(`
      SELECT binding.telegram_id, binding.company_id, binding.worker_id, worker.name AS worker_name
      FROM worker_telegram_bindings binding
      JOIN workers worker ON worker.company_id = binding.company_id AND worker.id = binding.worker_id
      WHERE binding.company_id = $1 AND binding.worker_id = $2
      FOR UPDATE OF binding
    `, [companyId, workerId]);
    const existing = existingResult.rows[0];
    if (!existing) throw workerError('WORKER_BINDING_NOT_FOUND', 404);
    if (String(existing.telegram_id) !== telegramId) throw workerError('WORKER_BINDING_MISMATCH', 409);

    await client.query(`DELETE FROM worker_telegram_bindings
      WHERE company_id = $1 AND worker_id = $2 AND telegram_id = $3`, [companyId, workerId, telegramId]);
    await client.query(`INSERT INTO worker_telegram_binding_events (
      company_id, worker_id, telegram_id, actor_telegram_id, event_type
    ) VALUES ($1, $2, $3, $4, 'UNBOUND')`, [companyId, workerId, telegramId, adminTelegramId]);
    return { companyId, workerId, telegramId, workerName: existing.worker_name, unboundBy: adminTelegramId };
  });
}

async function resolveBoundWorker(client, params) {
  const result = await client.query(
    `SELECT w.id AS worker_id, w.company_id, w.name AS worker_name, w.status, w.staj
     FROM worker_telegram_bindings b
     JOIN workers w ON w.company_id = b.company_id AND w.id = b.worker_id
     WHERE b.telegram_id = $1 AND b.company_id = $2 AND b.worker_id = $3`,
    [params.telegramId, params.companyId, params.workerId]
  );
  if (!result.rows.length || result.rows[0].status !== 'ACTIVE') throw workerError('WORKER_BINDING_REQUIRED', 403);
  return result.rows[0];
}

async function getWorkerProfile(pool, input) {
  const params = normalizeWorkerParams(input);
  const client = await pool.connect();
  try {
    const worker = await resolveBoundWorker(client, params);
    const payroll = await loadPayroll(client, params.companyId, input?.periodId, worker);
    const row = payroll.workers[0];
    return {
      worker_id: worker.worker_id,
      worker_name: worker.worker_name,
      company_id: worker.company_id,
      period_name: payroll.period ? `${payroll.period.name}${payroll.period.isClosed ? ' · qayta hisoblangan (arxiv o‘zgarmagan)' : ''}` : 'Davr mavjud emas',
      period: payroll.period,
      periodId: payroll.period?.periodId || null,
      pieceworkGross: row.pieceworkGross, oklad: row.oklad, gross: row.gross,
      magazin: row.magazin, avans: row.avans, jarima: row.jarima, staj: row.staj, net: row.net,
      accountingStatus: row.accountingStatus, accountingReasons: row.accountingReasons,
      syncStatus: row.syncStatus, earningsLabel: row.earningsLabel,
      unknownEntryCount: row.unknownEntryCount, unknownQuantity: row.unknownQuantity,
      unresolvedAdjustmentCount: row.unresolvedAdjustmentCount,
      pieces: row.pieces, rawQuantity: row.rawQuantity, models_breakdown: row.models_breakdown
    };
  } finally {
    client.release();
  }
}

async function getWorkerTickets(pool, input, limit = 8) {
  const params = normalizeWorkerParams(input);
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 8));
  const client = await pool.connect();
  try {
    const worker = await resolveBoundWorker(client, params);
    const periodResult = await client.query(
      `SELECT start_date, end_date FROM periods
       WHERE company_id = $1 AND is_closed = 0 ORDER BY start_date DESC LIMIT 1`,
      [params.companyId]
    );
    const period = periodResult.rows[0] || null;
    const result = await client.query(
      `SELECT t.id AS ticket_id, t.model_id, t.party_number, t.patta_number, t.size, t.color,
              t.qty::TEXT AS qty, t.submitted_at,
              STRING_AGG(e.op_name, ', ' ORDER BY e.op_name) AS my_operations
       FROM tickets t JOIN ticket_entries e ON e.company_id = t.company_id AND e.ticket_id = t.id
       WHERE t.company_id = $1 AND e.worker_id = $2 AND t.status = 'CONFIRMED' AND t.is_closed = 0
         AND ($3::DATE IS NULL OR t.submitted_at >= $3::DATE)
         AND ($4::DATE IS NULL OR t.submitted_at < ($4::DATE + INTERVAL '1 day'))
       GROUP BY t.id, t.model_id, t.party_number, t.patta_number, t.size, t.color, t.qty, t.submitted_at
       ORDER BY t.submitted_at DESC LIMIT $5`,
      [params.companyId, params.workerId, period?.start_date || null, period?.end_date || null, safeLimit]
    );
    return { workerId: worker.worker_id, tickets: result.rows };
  } finally {
    client.release();
  }
}

module.exports = {
  PIN_ATTEMPT_LIMIT,
  PIN_WINDOW_MS,
  workerError,
  normalizeWorkerParams,
  getWorkerBindingByTelegram,
  getWorkerBindingByWorker,
  getWorkerForEnrollment,
  claimWorkerBinding,
  unbindWorkerTelegramBinding,
  unbindWorkerTelegramBinding,
  verifyWorkerPin,
  hashWorkerPin,
  getWorkerProfile,
  getWorkerTickets
};
