import { describe, expect, it } from 'vitest';
import { getPattaSizesForSystem, isNumericPattaSize } from './pattaSizeSystem';

describe('Patta size system switcher', () => {
  it('separates letter and numeric sizes while preserving their configured order', () => {
    const configured = ['XXS', 'M', '42', '44', '4XL', '62'];

    expect(getPattaSizesForSystem(configured, 'letters')).toEqual(['XXS', 'M', '4XL']);
    expect(getPattaSizesForSystem(configured, 'numbers')).toEqual([
      '40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60', '62'
    ]);
  });

  it('offers numeric presets when a company has not configured numeric sizes yet', () => {
    expect(getPattaSizesForSystem(['S', 'M', 'L'], 'numbers')).toEqual([
      '40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60'
    ]);
  });

  it('treats numeric size ranges as numeric and excludes removed 36/38 choices', () => {
    expect(isNumericPattaSize('40-42')).toBe(true);
    expect(isNumericPattaSize(' 40 - 42 ')).toBe(true);
    expect(getPattaSizesForSystem(['S', '36', '38', '40-42'], 'numbers')).toEqual([
      '40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60', '40-42'
    ]);
  });
});
