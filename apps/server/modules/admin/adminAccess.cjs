'use strict';

function adminAccessError(code = 'ADMIN_COMPANY_SCOPE_REQUIRED') {
  const error = new Error(code);
  error.code = code;
  error.statusCode = 403;
  return error;
}

function normalizeTelegramId(value) {
  const id = String(value ?? '').trim();
  return /^\d{1,24}$/.test(id) ? id : null;
}

async function resolveAdminAccess(pool, telegramId, globalAdminIds) {
  const id = normalizeTelegramId(telegramId);
  if (!id) throw adminAccessError('ADMIN_SESSION_NOT_AUTHORIZED');
  if (globalAdminIds instanceof Set && globalAdminIds.has(id)) {
    return { telegramId: id, isGlobalAdmin: true, companyIds: null };
  }

  const result = await pool.query(`SELECT company_id FROM activation_company_admins
    WHERE telegram_id = $1 AND is_active = TRUE ORDER BY company_id`, [id]);
  const companyIds = [...new Set(result.rows.map((row) => String(row.company_id)))];
  if (!companyIds.length) throw adminAccessError('ADMIN_TELEGRAM_ID_NOT_AUTHORIZED');
  return { telegramId: id, isGlobalAdmin: false, companyIds };
}

function assertCompanyAccess(access, companyId) {
  if (access?.isGlobalAdmin === true) return String(companyId || '').trim();
  const id = String(companyId || '').trim();
  if (!id || !Array.isArray(access?.companyIds) || !access.companyIds.includes(id)) {
    throw adminAccessError('ADMIN_COMPANY_SCOPE_REQUIRED');
  }
  return id;
}

function requireGlobalAdmin(access) {
  if (access?.isGlobalAdmin !== true) throw adminAccessError('ADMIN_GLOBAL_SCOPE_REQUIRED');
}

function scopeCompanyFilters(access, filters = {}) {
  if (access?.isGlobalAdmin === true) return filters;
  const requestedCompanyId = String(filters.companyId || '').trim();
  if (requestedCompanyId) assertCompanyAccess(access, requestedCompanyId);
  if (!Array.isArray(access?.companyIds) || access.companyIds.length !== 1) {
    throw adminAccessError('ADMIN_COMPANY_SELECTION_REQUIRED');
  }
  return { ...filters, companyId: access.companyIds[0] };
}

module.exports = {
  normalizeTelegramId,
  resolveAdminAccess,
  assertCompanyAccess,
  requireGlobalAdmin,
  scopeCompanyFilters
};
