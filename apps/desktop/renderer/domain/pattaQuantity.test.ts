import { describe, expect, it } from 'vitest';
import { buildPartyWorkSummary, buildPattaWorkTickets, calculatePartyWorkQuantities, normalizePattaSizeCounts } from './pattaQuantity';

describe('buildPattaWorkTickets', () => {
  it('builds one per-patta work record for each patta in a party total', () => {
    const tickets = buildPattaWorkTickets(972, { M: '9' });

    expect(tickets).toEqual(Array.from({ length: 9 }, () => ({ size: 'M', perPatta: 108 })));
    expect(tickets.reduce((total, ticket) => total + ticket.perPatta, 0)).toBe(972);
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
