import { describe, expect, it, vi } from 'vitest';

const { assertCompanyAccess, resolveAdminAccess, scopeCompanyFilters } = require('../adminAccess.cjs');

describe('company-scoped Telegram admin access', () => {
  it('honors an explicit authorized company for a multi-company admin without changing other filters', () => {
    const access = { companyIds: ['company-a', 'company-b'] };
    const filters = { companyId: ' company-b ', search: 'Fixture', periodId: 'period-b', limit: '12' };
    expect(assertCompanyAccess(access, filters.companyId)).toBe('company-b');
    expect(scopeCompanyFilters(access, filters)).toEqual({ ...filters, companyId: 'company-b' });
    expect(filters.companyId).toBe(' company-b ');
    expect(() => scopeCompanyFilters(access, {})).toThrowError(expect.objectContaining({ code: 'ADMIN_COMPANY_SELECTION_REQUIRED' }));
    expect(() => scopeCompanyFilters(access, { companyId: ' ' })).toThrowError(expect.objectContaining({ code: 'ADMIN_COMPANY_SELECTION_REQUIRED' }));
    expect(() => scopeCompanyFilters(access, { companyId: 'company-c' })).toThrowError(expect.objectContaining({ code: 'ADMIN_COMPANY_SCOPE_REQUIRED' }));
  });

  it('resolves only active company grants for authorized Telegram admins', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ company_id: 'comp_novda' }] })) };
    await expect(resolveAdminAccess(pool, '274466315'))
      .resolves.toEqual({ telegramId: '274466315', companyIds: ['comp_novda'] });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('activation_company_admins'), ['274466315']);
  });

  it('scopes implicit and explicit company filters and rejects cross-company access', () => {
    const access = { telegramId: '274466315', companyIds: ['comp_novda'] };
    expect(scopeCompanyFilters(access, { search: 'Ali' })).toEqual({ search: 'Ali', companyId: 'comp_novda' });
    expect(scopeCompanyFilters(access, { companyId: 'comp_novda' })).toEqual({ companyId: 'comp_novda' });
    expect(() => assertCompanyAccess(access, 'other_company')).toThrowError(expect.objectContaining({ code: 'ADMIN_COMPANY_SCOPE_REQUIRED' }));
    expect(() => scopeCompanyFilters(access, { companyId: 'other_company' })).toThrowError(expect.objectContaining({ code: 'ADMIN_COMPANY_SCOPE_REQUIRED' }));
  });

  it('does not authorize an ID without an active company grant', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(resolveAdminAccess(pool, '99887766'))
      .rejects.toMatchObject({ code: 'ADMIN_TELEGRAM_ID_NOT_AUTHORIZED', statusCode: 403 });
  });
});
