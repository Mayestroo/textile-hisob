import { describe, expect, it } from 'vitest';
import { parseEditableNumericDraft } from './HisobView';

describe('Hisob editable numeric input drafts', () => {
  it('keeps valid final numbers and treats an empty field as zero on commit', () => {
    expect(parseEditableNumericDraft('30')).toBe(30);
    expect(parseEditableNumericDraft(' 40.5 ')).toBe(40.5);
    expect(parseEditableNumericDraft('')).toBe(0);
  });

  it('rejects invalid or negative values without submitting them', () => {
    expect(parseEditableNumericDraft('not a number')).toBeNull();
    expect(parseEditableNumericDraft('-1')).toBeNull();
  });
});
