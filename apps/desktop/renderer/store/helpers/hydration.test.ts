import { describe, expect, it } from 'vitest';
import { hydrateWorkbookData, isPayloadOwnedByCompany, isValidCompanyId } from './hydration';

describe('canonical hydration', () => {
  it('normalizes web fallback data and rebuilds derived quantities', () => {
    const data = hydrateWorkbookData({
      companyId: 'company_a',
      models: [{ id: 'm', name: 'm', operations: [{ name: 'Sew', rate: 1 }], pattaOpsOrder: [], hisobQuantities: { 1: { Sew: 99, Old: 3 } } }],
      submittedTickets: [{ id: 't', modelId: 'm', qty: 2, entries: [{ opName: 'Sew', workerId: 1 }] }]
    });
    expect(data.models[0].hisobQuantities).toEqual({ 1: { Sew: 2 } });
    expect(data.ticketForms.m).toBeDefined();
    expect(data.pattaBatchConfigs.m).toBeDefined();
  });

  it('preserves reusable patta ranges from archived local history', () => {
    const data = hydrateWorkbookData({
      companyId: 'company_a',
      printedPartyHistory: [{ id: 'archived', partyNumber: '1', modelId: 'm', pattaCount: 4,
        cumulativePattaCount: 4, pattaStartNumber: 1, pattaEndNumber: 4,
        isClosed: true, isArchived: true }]
    });

    expect(data.reusablePattaRanges).toEqual([{ start: 1, end: 4 }]);
  });

  it('rejects missing, unassigned, and malformed company contexts', () => {
    expect(isValidCompanyId('company_a')).toBe(true);
    expect(isValidCompanyId('unassigned')).toBe(false);
    expect(isValidCompanyId('../other')).toBe(false);
    expect(isValidCompanyId(undefined)).toBe(false);
  });

  it('accepts only an explicitly matching payload owner', () => {
    expect(isPayloadOwnedByCompany({ companyId: 'company-a' }, 'company-a')).toBe(true);
    expect(isPayloadOwnedByCompany({ companyId: 'company-b' }, 'company-a')).toBe(false);
    expect(isPayloadOwnedByCompany({ companyId: '../company-a' }, 'company-a')).toBe(false);
    expect(isPayloadOwnedByCompany({}, 'company-a')).toBe(false);
    expect(isPayloadOwnedByCompany({ companyId: 'company-a' }, 'company-b')).toBe(false);
  });

  it('does not alter historical operation IDs or duplicate legacy records', async () => {
    const { sanitizeModels } = await import('./storeSanitizers');
    const [model] = sanitizeModels([{
      id: 'm',
      name: 'M',
      operations: [
        { id: 'legacy-op-17', col: 17, name: 'Sew' },
        { id: 'legacy-op-19', col: 19, name: 'Sew' }
      ],
      pattaOpsOrder: ['Sew']
    }]);
    expect(model.operations.map((operation) => operation.id)).toEqual(['legacy-op-17', 'legacy-op-19']);
    expect(model.operations.map((operation) => operation.col)).toEqual([17, 19]);
  });

  it('skips malformed operations while preserving valid historical identities', async () => {
    const { sanitizeModels } = await import('./storeSanitizers');
    const [model] = sanitizeModels([{
      id: 'm', name: 'M',
      operations: [{ id: 'op-a', name: 'Cut' }, null, { id: 'op-b', name: 'Cut' }, { bad: true }],
      pattaOpsOrder: ['Cut']
    }]);
    expect(model.operations.map((operation) => operation.id)).toEqual(['op-a', 'op-b']);
    expect(model.operations.map((operation) => operation.name)).toEqual(['Cut', 'Cut']);
  });
});
