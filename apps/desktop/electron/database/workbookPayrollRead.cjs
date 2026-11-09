'use strict';
const { loadWorkbookProjectionFromSqlite } = require('./projectionReader.cjs');
const { loadPayrollValuationFromSqlite } = require('./payrollReader.cjs');
const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');

function readWorkbookPayrollProjection(db, companyId) {
  const data = loadWorkbookProjectionFromSqlite(db, companyId);
  let payrollValuation;
  try {
    payrollValuation = loadPayrollValuationFromSqlite(db, companyId, data.currentPeriod?.id || null);
  } catch {
    payrollValuation = { companyId, period: null, workers: [], accountingStatus: 'UNAVAILABLE',
      accountingReasons: ['PAYROLL_READ_UNAVAILABLE'], syncStatus: 'UNKNOWN' };
  }
  return { ...data, payrollValuation };
}

function readPeriodPayrollProjection(db, companyId, periodId, archiveData) {
  try {
    // Historical roster/staj is usable only when it matches the independently
    // validated, company/period-bound archive stored in this database.
    const row = db.prepare('SELECT archive_json, sha256 FROM period_archives WHERE company_id=? AND period_id=?')
      .get(companyId, periodId);
    let workers;
    if (row && archiveData && typeof row.archive_json === 'string') {
      try {
        const persisted = JSON.parse(row.archive_json);
        const hash = computePayloadHash(canonicalStringify(persisted));
        if (hash === row.sha256 && hash === computePayloadHash(canonicalStringify(archiveData))
          && Array.isArray(persisted.models) && persisted.period?.id === periodId
          && (persisted.period.companyId == null || persisted.period.companyId === companyId)
          && Array.isArray(persisted.workers)) workers = persisted.workers;
      } catch { /* malformed archive cannot supply a historical roster */ }
    }
    return loadPayrollValuationFromSqlite(db, companyId, periodId, workers ? { workers } : {});
  } catch {
    return { companyId, period: null, workers: [], accountingStatus: 'UNAVAILABLE',
      accountingReasons: ['PAYROLL_READ_UNAVAILABLE'], syncStatus: 'UNKNOWN' };
  }
}

module.exports = { readWorkbookPayrollProjection, readPeriodPayrollProjection };
