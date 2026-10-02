import { describe, expect, it } from 'vitest';
import { buildPartyWorkSummary, buildPattaWorkTickets, calculateBatchWorkQuantities, calculatePartyWorkQuantities, normalizePattaSizeCounts } from './pattaQuantity';

describe('buildPattaWorkTickets', () => {
  it('uses the entered work count for each patta and multiplies the batch total', () => {
    const tickets = buildPattaWorkTickets(100, { XXS: '1', XS: '1', S: '1', M: '1', L: '1', XL: '1', XXL: '1', XXXL: '1', '4XL': '1', '5XL': '1' });

    expect(tickets).toHaveLength(10);
    expect(tickets.every((ticket) => ticket.perPatta === 100)).toBe(true);
    expect(tickets.reduce((total, ticket) => total + ticket.perPatta, 0)).toBe(1000);
    expect(calculateBatchWorkQuantities(100, tickets.length)).toEqual({
      ishSoniPerPatta: 100,
      pattaCount: 10,
      totalIshSoni: 1000
    });
  });
});

describe('normalizePattaSizeCounts', () => {
  it('normalizes blank values and base-10 integer strings and numbers', () => {
    expect(normalizePattaSizeCounts({ XXS: '9', XS: '  ', S: 2 })).toEqual({
      sizes: { XXS: 9, XS: 0, S: 2 },
      pattaCount: 11
    });
  });

  it.each(['2e1', '2.5', '-1', '9007199254740992', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
    'rejects invalid size counts: %s',
    (count) => {
      expect(() => normalizePattaSizeCounts({ M: count })).toThrow('INVALID_PATTA_SIZE_COUNT');
    }
  );

  it('rejects an unsafe aggregate patta count', () => {
    expect(() => normalizePattaSizeCounts({ M: Number.MAX_SAFE_INTEGER, L: '1' }))
      .toThrow('INVALID_PATTA_SIZE_TOTAL');
  });
});

describe('calculatePartyWorkQuantities', () => {
  it('divides a party total by that batch’s actual patta count', () => {
    expect(calculatePartyWorkQuantities(972, 9)).toEqual({
      partyTotal: 972,
      pattaCount: 9,
      perPatta: 108
    });
    expect(calculatePartyWorkQuantities(960, 12).perPatta).toBe(80);
    expect(buildPartyWorkSummary(972, 9)).toEqual({
      ishSoniPerPatta: 108,
      totalIshSoni: 972,
      ishSoni: 972
    });
  });

  it('rejects a non-positive total or patta count', () => {
    expect(() => calculatePartyWorkQuantities(0, 9)).toThrow('INVALID_PARTY_TOTAL');
    expect(() => calculatePartyWorkQuantities(972, 0)).toThrow('INVALID_PATTA_COUNT');
  });

  it('rejects a total that does not divide evenly', () => {
    expect(() => calculatePartyWorkQuantities(1000, 9)).toThrow('PARTY_TOTAL_NOT_DIVISIBLE');
  });
});

describe('calculateBatchWorkQuantities', () => {
  it('multiplies the one-patta work count by the batch patta count', () => {
    expect(calculateBatchWorkQuantities(100, 10)).toEqual({
      ishSoniPerPatta: 100,
      pattaCount: 10,
      totalIshSoni: 1000
    });
  });

  it('rejects invalid per-patta work counts and unsafe batch totals', () => {
    expect(() => calculateBatchWorkQuantities(0, 10)).toThrow('INVALID_PARTY_TOTAL');
    expect(() => calculateBatchWorkQuantities(100, 0)).toThrow('INVALID_PATTA_COUNT');
    expect(() => calculateBatchWorkQuantities(Number.MAX_SAFE_INTEGER, 2)).toThrow('INVALID_PARTY_TOTAL');
  });
});
