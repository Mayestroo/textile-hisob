'use strict';
const assert = require('node:assert/strict');

// Independent acceptance oracle: SQL aggregates and direct arithmetic, no domain
// reducer, payroll reader or production rate-resolution helper is imported.
// Legacy unresolved adjustments are reported as uncertainty, never assigned money.
async function verifyBackupPayroll(pool, companyId, period, actual) {
  const archived = period.isClosed ? (await pool.query('SELECT archive_json FROM period_archives WHERE company_id=$1 AND period_id=$2',
    [companyId, period.id])).rows[0]?.archive_json : null;
  const models = period.isClosed ? archived?.models : (await pool.query('SELECT id, operations_json AS operations FROM models WHERE company_id=$1', [companyId])).rows;
  assert(Array.isArray(models), 'Oracle requires a known tariff basis; absent archives are not zero-priced');
  const prices = new Map();
  for (const model of models) for (const op of model.operations || []) {
    prices.set(JSON.stringify([model.id, op.name]), op.rate == null ? null : Number(op.rate));
  }
  const work = (await pool.query(`SELECT e.worker_id,t.model_id,e.op_name,SUM(e.qty)::text AS quantity,COUNT(*)::integer AS entries
    FROM ticket_entries e JOIN tickets t ON t.company_id=e.company_id AND t.id=e.ticket_id
    WHERE t.company_id=$1 AND t.period_id=$2 AND t.status='CONFIRMED'
    GROUP BY e.worker_id,t.model_id,e.op_name`, [companyId, period.id])).rows;
  const resolved = (await pool.query(`SELECT count(*)::integer AS count FROM production_adjustments
    WHERE company_id=$1 AND original_period_id=$2 AND attribution_status='RESOLVED'`, [companyId, period.id])).rows[0].count;
  assert.equal(resolved, 0, 'Backup oracle does not yet cover resolved/reversal corrections; do not silently omit them');
  const deductions = (await pool.query(`SELECT worker_id,type,SUM(amount)::text AS amount FROM worker_adjustments
    WHERE company_id=$1 AND period_id=$2 AND status='POSTED' GROUP BY worker_id,type`, [companyId, period.id])).rows;
  const workers = (await pool.query('SELECT id,staj FROM workers WHERE company_id=$1 AND status=\'ACTIVE\'', [companyId])).rows;
  let comparisons = 0;
  for (const worker of workers) {
    const entries = work.filter(row => row.worker_id === worker.id);
    let piecework = 0;
    let pieces = 0;
    let unknownEntries = 0;
    for (const row of entries) {
      const rate = prices.get(JSON.stringify([row.model_id, row.op_name]));
      const qty = Math.max(0, Number(row.quantity));
      pieces += qty;
      if (rate == null) unknownEntries += row.entries;
      else piecework += qty * rate;
    }
    const balance = type => Number(deductions.find(row => row.worker_id === worker.id && row.type === type)?.amount || 0);
    const oklad = balance('OKLAD');
    const avans = Math.max(0, balance('AVANS'));
    const jarima = Math.max(0, balance('JARIMA'));
    const magazin = balance('MAGAZIN');
    const expected = { pieceworkGross: piecework, oklad, avans, jarima, magazin,
      gross: piecework + oklad, net: piecework + oklad - avans - jarima - magazin - Math.max(0, Number(worker.staj)),
      pieces, unknownEntryCount: unknownEntries };
    const observed = actual.workers.find(row => row.workerId === worker.id);
    assert(observed, 'Oracle worker missing from payroll');
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(observed[field], value, `Independent SQL payroll oracle mismatch: period=${period.id} worker=${worker.id} field=${field}`);
      comparisons++;
    }
    if (unknownEntries) assert(observed.accountingReasons.includes('UNKNOWN_HISTORICAL_RATE'), 'Unknown wages must stay explicit');
  }
  return comparisons;
}
module.exports = { verifyBackupPayroll };
