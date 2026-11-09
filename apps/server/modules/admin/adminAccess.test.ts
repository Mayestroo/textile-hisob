import { describe, expect, it, vi } from 'vitest';

const { assertCompanyAccess, requireGlobalAdmin, resolveAdminAccess, scopeCompanyFilters } = require('./adminAccess.cjs');

describe('company-scoped Telegram admin access', () => {
  it('honors an explicit authorized company for a multi-company admin without changing other filters', () => {
    const access = { isGlobalAdmin: false, companyIds: ['company-a', 'company-b'] };
    const filters = { companyId: ' company-b ', search: 'Fixture', periodId: 'period-b', limit: '12' };
    expect(assertCompanyAccess(access, filters.companyId)).toBe('company-b');
    expect(scopeCompanyFilters(access, filters)).toEqual({ ...filters, companyId: 'company-b' });
    expect(filters.companyId).toBe(' company-b ');
    expect(() => scopeCompanyFilters(access, {})).toThrowError(expect.objectContaining({ code: 'ADMIN_COMPANY_SELECTION_REQUIRED' }));
    expect(() => scopeCompanyFilters(access, { companyId: ' ' })).toThrowError(expect.objectContaining({ code: 'ADMIN_COMPANY_SELECTION_REQUIRED' }));
    expect(() => scopeCompanyFilters(access, { companyId: 'company-c' })).toThrowError(expect.objectContaining({ code: 'ADMIN_COMPANY_SCOPE_REQUIRED' }));
    const globalFilters = { search: 'Fixture' };
    expect(scopeCompanyFilters({ isGlobalAdmin: true }, globalFilters)).toBe(globalFilters);
  });

  it('keeps configured global admins global and resolves grants for company-only admins', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ company_id: 'comp_novda' }] })) };
    await expect(resolveAdminAccess(pool, '1526974123', new Set(['1526974123'])))
      .resolves.toEqual({ telegramId: '1526974123', isGlobalAdmin: true, companyIds: null });
    await expect(resolveAdminAccess(pool, '274466315', new Set(['1526974123'])))
      .resolves.toEqual({ telegramId: '274466315', isGlobalAdmin: false, companyIds: ['comp_novda'] });
  });

  it('scopes implicit and explicit company filters and rejects cross-company/global access', () => {
    const access = { telegramId: '274466315', isGlobalAdmin: false, companyIds: ['comp_novda'] };
    expect(scopeCompanyFilters(access, { search: 'Ali' })).toEqual({ search: 'Ali', companyId: 'comp_novda' });
    expect(scopeCompanyFilters(access, { companyId: 'comp_novda' })).toEqual({ companyId: 'comp_novda' });
    expect(() => assertCompanyAccess(access, 'other_company')).toThrowError(expect.objectContaining({ code: 'ADMIN_COMPANY_SCOPE_REQUIRED' }));
    expect(() => scopeCompanyFilters(access, { companyId: 'other_company' })).toThrowError(expect.objectContaining({ code: 'ADMIN_COMPANY_SCOPE_REQUIRED' }));
    expect(() => requireGlobalAdmin(access)).toThrowError(expect.objectContaining({ code: 'ADMIN_GLOBAL_SCOPE_REQUIRED' }));
  });

  it('does not authorize an ID without a global allowlist entry or active company grant', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(resolveAdminAccess(pool, '99887766', new Set(['1526974123'])))
      .rejects.toMatchObject({ code: 'ADMIN_TELEGRAM_ID_NOT_AUTHORIZED', statusCode: 403 });
  });
});
