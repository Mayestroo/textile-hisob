import { describe, expect, it } from 'vitest';
import { isValidCompanyId, validateRequestedCompanyId } from './companyAuthority.cjs';

describe('main-process company authority', () => {
  it('allows a requested company only when it matches the active license', () => {
    expect(validateRequestedCompanyId('company-a', 'company-a')).toBe('company-a');
  });

  it.each([
    ['company-b', 'company-a'],
    [undefined, 'company-a'],
    ['company-a', null],
    ['../company-a', 'company-a']
  ])('rejects requested company %s with active license %s', (requested, active) => {
    expect(() => validateRequestedCompanyId(requested, active)).toThrow();
  });

  it('rejects malformed and unassigned IDs', () => {
    expect(isValidCompanyId('unassigned')).toBe(false);
    expect(isValidCompanyId('../company-a')).toBe(false);
  });
});
