import { describe, expect, it } from 'vitest';
import {
  getPattaSizesForSystem,
  isNumericPattaSize,
  sortPattaSizes
} from '../pattaSizeSystem';
import { buildPattaWorkTickets } from '../pattaQuantity';

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

describe('Canonical size sorting for patta printing and model sizes', () => {
  it('sorts numeric sizes ascending when adding lower size e.g. 52, 54 and adding 48', () => {
    const input = ['52', '54', '48'];
    expect(sortPattaSizes(input)).toEqual(['48', '52', '54']);
  });

  it('sorts letter sizes in canonical apparel order when adding XS to S, M, L', () => {
    const input = ['S', 'M', 'L', 'XS'];
    expect(sortPattaSizes(input)).toEqual(['XS', 'S', 'M', 'L']);

    const fullOrder = ['L', 'XXL', 'M', '3XL', 'S', '4XL', 'XL', 'XS', 'XXS'];
    expect(sortPattaSizes(fullOrder)).toEqual([
      'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'
    ]);
  });

  it('handles numeric range sizes correctly in ascending order', () => {
    const input = ['52-54', '44-46', '48', '40'];
    expect(sortPattaSizes(input)).toEqual(['40', '44-46', '48', '52-54']);
  });

  it('builds work tickets strictly following sorted size order', () => {
    const ticketsWithoutOrder = buildPattaWorkTickets(
      20,
      { '54': 1, '52': 2, '48': 1 }
    );
    expect(ticketsWithoutOrder.map((t) => t.size)).toEqual(['48', '52', '52', '54']);

    const ticketsWithSortedOrder = buildPattaWorkTickets(
      20,
      { '54': 1, '52': 2, '48': 1 },
      sortPattaSizes(['52', '54', '48'])
    );
    expect(ticketsWithSortedOrder.map((t) => t.size)).toEqual(['48', '52', '52', '54']);
  });

  it('builds work tickets in sorted order for letter sizes with added XS', () => {
    const tickets = buildPattaWorkTickets(
      15,
      { 'L': 1, 'M': 1, 'S': 1, 'XS': 2 }
    );
    expect(tickets.map((t) => t.size)).toEqual(['XS', 'XS', 'S', 'M', 'L']);
  });
});
