import { describe, expect, it } from 'vitest';
const { classifyAdjustment } = require('../historical-reconciliation.cjs');
const row = { company_id: 'a', adjustment_id: 'adj', model_id: 'm', worker_id: 1, op_name: 'Sew', delta_qty: '3' };
const source = { companyId: 'a', adjustmentId: 'adj', modelId: 'm', workerId: 1, opName: 'Sew', deltaQty: 3,
  originalTicketId: 't', originalEntryId: 'e', originalPeriodId: 'P', originalRateSnapshot: 0 };
const entry = { companyId: 'a', ticketId: 't', entryId: 'e', periodId: 'P', modelId: 'm', workerId: 1, opName: 'Sew', rateSnapshot: 0 };
describe('historical financial evidence, not heuristic attribution', () => {
  it('requires direct attribution plus immutable work and accepts proven zero distinctly', () => {
    expect(classifyAdjustment(row, { sources: [source], immutableEntries: [entry] }).classification).toBe('VERIFIED');
    expect(classifyAdjustment(row, { sources: [source], immutableEntries: [{ ...entry, rateSnapshot: null }] }).classification).toBe('UNRESOLVED');
  });
  it('does not assign a period from similar work, creation time or an accepted unlinked command', () => {
    expect(classifyAdjustment(row, { sources: [{ ...source, originalPeriodId: null }], immutableEntries: [entry] }).classification).toBe('UNRESOLVED');
    expect(classifyAdjustment(row, { sources: [], immutableEntries: [entry] }).classification).toBe('UNRESOLVED');
  });
  it('labels contradictory direct facts ambiguous and never crosses tenants', () => {
    expect(classifyAdjustment(row, { sources: [{ ...source, companyId: 'b' }], immutableEntries: [entry] }).classification).toBe('AMBIGUOUS');
    expect(classifyAdjustment(row, { sources: [source], immutableEntries: [{ ...entry, companyId: 'b' }] }).classification).toBe('UNRESOLVED');
    expect(classifyAdjustment(row, { sources: [source, { ...source, originalPeriodId: 'Q' }], immutableEntries: [entry] }).classification).toBe('AMBIGUOUS');
  });
});
