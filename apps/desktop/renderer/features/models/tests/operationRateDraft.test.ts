import { describe, expect, it } from 'vitest';
import { cloneRateDraft, finalizeRateDraft, parseRateDraft } from '../operationRateDraft';
import type { Operation } from '../../../types/workbook';
describe('desktop tariff editor does not certify unknown wages as zero', () => {
  it('preserves null and explicit zero when opening/resetting a draft', () => {
    const original = [{ id: 'known', name: 'Sew', rate: 7 }, { id: 'unknown', name: 'Cut', rate: null }, { id: 'zero', name: 'Free', rate: 0 }];
    const draft = cloneRateDraft(original as Operation[]);
    draft[0].rate = 9;
    expect(draft.map(operation => operation.rate)).toEqual([9, null, 0]);
    expect(original[0].rate).toBe(7);
    expect(finalizeRateDraft(draft)).toBeNull();
    draft[1].rate = 0;
    expect(finalizeRateDraft(draft)?.map(operation => operation.rate)).toEqual([9, 0, 0]);
    expect(cloneRateDraft(original as Operation[])[1].rate).toBeNull();
  });
  it.each(['', '  ', 'abc', '-1', '2oops', 'Infinity'])('refuses blank or invalid %j before a command is created', value => {
    const rate = parseRateDraft(value);
    expect(finalizeRateDraft([{ id: 'op', name: 'Sew', rate }])).toBeNull();
  });
  it('retains existing finite fractional rates and explicit zero', () => {
    expect(parseRateDraft('1 200.5')).toBe(1200.5);
    expect(finalizeRateDraft([{ id: 'op', name: 'Sew', rate: parseRateDraft('0') }])?.[0].rate).toBe(0);
  });
});
