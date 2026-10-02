import { describe, expect, it } from 'vitest';
import { getPattaSizesForSystem } from './pattaSizeSystem';

describe('Patta size system switcher', () => {
  it('separates letter and numeric sizes while preserving their configured order', () => {
    const configured = ['XXS', 'M', '42', '44', '4XL', '62'];

    expect(getPattaSizesForSystem(configured, 'letters')).toEqual(['XXS', 'M', '4XL']);
    expect(getPattaSizesForSystem(configured, 'numbers')).toEqual([
      '36', '38', '40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60', '62'
    ]);
  });

  it('offers numeric presets when a company has not configured numeric sizes yet', () => {
    expect(getPattaSizesForSystem(['S', 'M', 'L'], 'numbers')).toEqual([
      '36', '38', '40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60'
    ]);
  });
});
