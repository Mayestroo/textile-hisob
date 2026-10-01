'use strict';

const crypto = require('crypto');

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
      `SELECT telegram_id, company_id, worker_id FROM worker_telegram_bindings WHERE telegram_id = $1 FOR UPDATE`,
      [params.telegramId]
    );
    if (existingTelegram.rows.length) {
      const binding = existingTelegram.rows[0];
      if (binding.company_id !== params.companyId || Number(binding.worker_id) !== params.workerId) {
        return { error: workerError('TELEGRAM_ACCOUNT_ALREADY_BOUND', 409) };
      }
      return { binding };
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
    const periodResult = await client.query(
      `SELECT start_date, end_date, is_closed FROM periods
       WHERE company_id = $1 AND is_closed = 0 ORDER BY start_date DESC LIMIT 1`,
      [params.companyId]
    );
    const period = periodResult.rows[0] || null;
    const breakdownResult = await client.query(
      `SELECT m.id AS model_id, m.name AS model_name, e.op_name AS operation_name,
              COALESCE(e.rate_snapshot, rates.rate, 0)::TEXT AS rate,
              SUM(e.qty)::TEXT AS qty,
              SUM(e.qty * COALESCE(e.rate_snapshot, rates.rate, 0))::TEXT AS amount
       FROM ticket_entries e
       JOIN tickets t ON t.company_id = e.company_id AND t.id = e.ticket_id
       JOIN models m ON m.company_id = t.company_id AND m.id = t.model_id
       LEFT JOIN LATERAL (
         SELECT CASE
           WHEN COALESCE(operation_row.value->>'rate', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
           THEN (operation_row.value->>'rate')::NUMERIC
           ELSE 0::NUMERIC
         END AS rate
         FROM jsonb_array_elements(m.operations_json) AS operation_row(value)
         WHERE operation_row.value->>'name' = e.op_name
         LIMIT 1
       ) rates ON TRUE
       WHERE e.company_id = $1 AND e.worker_id = $2 AND t.status = 'CONFIRMED' AND t.is_closed = 0
         AND ($3::DATE IS NULL OR t.submitted_at >= $3::DATE)
         AND ($4::DATE IS NULL OR t.submitted_at < ($4::DATE + INTERVAL '1 day'))
       GROUP BY m.id, m.name, e.op_name, e.rate_snapshot, rates.rate
       ORDER BY m.name, e.op_name`,
      [params.companyId, params.workerId, period?.start_date || null, period?.end_date || null]
    );
    const adjustmentResult = await client.query(
      `SELECT type, COALESCE(SUM(amount), 0)::TEXT AS total
       FROM worker_adjustments
       WHERE company_id = $1 AND worker_id = $2
         AND ($3::DATE IS NULL OR created_at >= $3::DATE)
         AND ($4::DATE IS NULL OR created_at < ($4::DATE + INTERVAL '1 day'))
       GROUP BY type`,
      [params.companyId, params.workerId, period?.start_date || null, period?.end_date || null]
    );

    const models = {};
    let gross = 0;
    let pieces = 0;
    for (const row of breakdownResult.rows) {
      const modelId = String(row.model_id);
      if (!models[modelId]) models[modelId] = { id: modelId, name: row.model_name, earnings: 0, pieces: 0, operations: [] };
      const operation = {
        name: row.operation_name,
        rate: Number(row.rate || 0),
        qty: Number(row.qty || 0),
        amount: Number(row.amount || 0)
      };
      models[modelId].operations.push(operation);
      models[modelId].earnings += operation.amount;
      models[modelId].pieces += operation.qty;
      gross += operation.amount;
      pieces += operation.qty;
    }
    const adjustments = Object.fromEntries(adjustmentResult.rows.map((row) => [row.type, Number(row.total || 0)]));
    const avans = Math.max(0, adjustments.AVANS || 0);
    const jarima = Math.max(0, adjustments.JARIMA || 0);
    const staj = Math.max(0, Number(worker.staj || 0));
    const periodStart = period?.start_date ? String(period.start_date).slice(0, 10) : null;
    return {
      worker_id: worker.worker_id,
      worker_name: worker.worker_name,
      company_id: worker.company_id,
      period_name: periodStart ? `Davr ${periodStart.slice(0, 7)}` : 'Joriy davr',
      period: period ? { startDate: periodStart, endDate: period.end_date, isClosed: Boolean(period.is_closed) } : null,
      gross,
      avans,
      jarima,
      staj,
      net: gross - avans - jarima - staj,
      pieces,
      models_breakdown: models
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
  verifyWorkerPin,
  hashWorkerPin,
  getWorkerProfile,
  getWorkerTickets
};
