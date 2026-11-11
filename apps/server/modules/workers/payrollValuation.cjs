'use strict';
const { reducePayroll } = require('../../../../packages/domain/payrollReducer.cjs');
const { canonicalStringify, computePayloadHash } = require('../sync/canonicalPayload.cjs');

function periodError(code, statusCode) {
  return Object.assign(new Error(code), { code, statusCode });
}

function validatePeriodId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw periodError('INVALID_PERIOD_ID', 400);
  }
  return value.trim();
}

const dateOnly = (value) => value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

async function loadPayroll(client, companyId, requestedPeriodId, boundWorker = null) {
  const periodId = validatePeriodId(requestedPeriodId);
  const periods = await client.query(`SELECT id, name, start_date::text AS start_date, end_date::text AS end_date, is_closed FROM periods
    WHERE company_id = $1 AND (($2::VARCHAR IS NOT NULL AND id = $2) OR ($2::VARCHAR IS NULL AND is_closed = 0))
    ORDER BY start_date DESC NULLS LAST, id DESC LIMIT 1`, [companyId, periodId]);
  const period = periods.rows[0] || null;
  if (periodId && !period) throw periodError('PERIOD_NOT_FOUND', 404);
  const workers = boundWorker ? [boundWorker] : (await client.query(`SELECT id AS worker_id, name AS worker_name, staj
    FROM workers WHERE company_id = $1 AND status = 'ACTIVE' ORDER BY id`, [companyId])).rows;
  const workerId = boundWorker ? Number(boundWorker.worker_id) : null;
  const facts = period ? await client.query(`SELECT e.worker_id, t.model_id, m.name AS model_name, e.op_name,
      e.qty::TEXT AS qty, e.rate_snapshot::TEXT AS rate, t.period_id
    FROM ticket_entries e JOIN tickets t ON t.company_id = e.company_id AND t.id = e.ticket_id
    LEFT JOIN models m ON m.company_id = t.company_id AND m.id = t.model_id
    WHERE e.company_id = $1 AND ($3::INTEGER IS NULL OR e.worker_id = $3) AND t.status = 'CONFIRMED'
      AND (t.period_id = $2 OR t.period_id IS NULL)`, [companyId, period.id, workerId]) : { rows: [] };
  const adjustments = period ? await client.query(`SELECT a.adjustment_id, a.original_adjustment_id, a.provenance,
      a.worker_id, a.model_id, m.name AS model_name, a.op_name, a.delta_qty::TEXT AS qty,
      a.status, a.attribution_status, a.original_period_id, a.original_rate_snapshot::TEXT AS rate,
      original.status AS original_status, original.worker_id AS original_worker_id,
      original.model_id AS original_model_id, original.op_name AS original_op_name,
      original.original_period_id AS original_period, original.original_rate_snapshot::TEXT AS original_rate,
      original.delta_qty::TEXT AS original_qty, original.attribution_status AS original_attribution
    FROM production_adjustments a
    LEFT JOIN production_adjustments original ON original.company_id = a.company_id AND original.adjustment_id = a.original_adjustment_id
    LEFT JOIN models m ON m.company_id = a.company_id AND m.id = a.model_id
    WHERE a.company_id = $1 AND ($3::INTEGER IS NULL OR a.worker_id = $3)
      AND (a.original_period_id = $2 OR a.original_period_id IS NULL OR
        (a.original_adjustment_id IS NOT NULL AND original.original_period_id = $2))`, [companyId, period.id, workerId]) : { rows: [] };
  const deductions = period ? await client.query(`SELECT worker_id, type,
      CASE WHEN type IN ('AVANS', 'JARIMA') THEN COALESCE(SUM(amount), 0)
        ELSE COALESCE(SUM(amount) FILTER (WHERE period_id = $2 AND status = 'POSTED'), 0) END::TEXT AS total
    FROM worker_adjustments WHERE company_id = $1 AND status = 'POSTED' AND ($4::INTEGER IS NULL OR worker_id = $4)
      AND (period_id = $2 OR (type IN ('AVANS', 'JARIMA') AND period_id IS NULL AND ($3::DATE IS NOT NULL OR $5::DATE IS NOT NULL)
        AND ($3::DATE IS NULL OR created_at::DATE >= $3::DATE)
        AND ($5::DATE IS NULL OR created_at::DATE <= $5::DATE)))
    GROUP BY worker_id, type`, [companyId, period.id, dateOnly(period.start_date), workerId, dateOnly(period.end_date)]) : { rows: [] };
  const models = period && !period.is_closed ? await client.query(`SELECT id, operations_json AS operations
    FROM models WHERE company_id = $1`, [companyId]) : { rows: [] };
  let closingArchive = null;
  if (period && period.is_closed) {
    const archive = await client.query(`SELECT archive_json, sha256 FROM period_archives WHERE company_id = $1 AND period_id = $2`, [companyId, period.id]);
    const row = archive.rows[0];
    if (row) {
      try {
        const parsed = typeof row.archive_json === 'string' ? JSON.parse(row.archive_json) : row.archive_json;
        const identity = parsed?.period;
        if (computePayloadHash(canonicalStringify(parsed)) === row.sha256
          && (!identity || (identity.id === period.id && (identity.companyId == null || identity.companyId === companyId)))
          && Array.isArray(parsed?.models)) closingArchive = parsed;
      } catch { /* invalid archive cannot establish a closing tariff */ }
    }
  }
  return reducePayroll(period, workers, facts.rows, adjustments.rows, deductions.rows,
    { currentModels: models.rows, closingArchive });
}

module.exports = { validatePeriodId, loadPayroll, reducePayroll };
