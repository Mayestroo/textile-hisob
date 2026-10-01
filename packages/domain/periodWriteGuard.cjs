'use strict';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function periodError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function businessDate(effectiveDate, storedTimestamp) {
  if (effectiveDate !== undefined && effectiveDate !== null) {
    if (typeof effectiveDate !== 'string' || !ISO_DATE.test(effectiveDate)) {
      throw periodError('INVALID_EFFECTIVE_DATE', 'effectiveDate must be an ISO calendar date (YYYY-MM-DD)');
    }
    return effectiveDate;
  }
  if (typeof storedTimestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(storedTimestamp)) {
    throw periodError('BUSINESS_DATE_REQUIRED', 'A valid effectiveDate or stored timestamp is required for this mutation');
  }
  return storedTimestamp.slice(0, 10);
}

function assertPeriodOpen(db, companyId, effectiveDate, storedTimestamp) {
  const date = businessDate(effectiveDate, storedTimestamp);
  const period = db.prepare(`
    SELECT id, start_date, end_date FROM periods
    WHERE company_id = ? AND is_closed = 1
      AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
    ORDER BY start_date DESC LIMIT 1
  `).get(companyId, date, date);
  if (period) {
    throw periodError('PERIOD_CLOSED', `Business date ${date} belongs to closed period ${period.id}`, { periodId: period.id, businessDate: date });
  }
  return date;
}

module.exports = { businessDate, assertPeriodOpen };
