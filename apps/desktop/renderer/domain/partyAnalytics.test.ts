import { describe, expect, it } from 'vitest';
import { buildPartyTicketsList } from './partyAnalytics';

describe('buildPartyTicketsList work quantities', () => {
  it('uses per-patta work quantity while keeping the party total equal to 972', () => {
    const tickets = buildPartyTicketsList({
      id: 'party-4', partyNumber: '4', modelId: 'body-long', modelName: 'BODY-LONG',
      color: 'MELANJ', pattaCount: 9, cumulativePattaCount: 9,
      ishSoniPerPatta: 108, totalIshSoni: 972, ishSoni: 972,
      cumulativeIshSoni: 972,
      sizes: { XS: '1', S: '3', M: '3', L: '2' }, printedAt: '2026-09-07T16:49:00.000Z'
    }, [], ['XS', 'S', 'M', 'L']);

    expect(tickets).toHaveLength(9);
    expect(tickets.map((ticket) => ticket.expectedQty)).toEqual(Array(9).fill(108));
    expect(tickets.reduce((sum, ticket) => sum + ticket.expectedQty, 0)).toBe(972);
  });

  it('derives per-patta quantity from a legacy total instead of repeating the total for every patta', () => {
    const tickets = buildPartyTicketsList({
      id: 'party-legacy', partyNumber: '1', modelId: 'buxoro-long', modelName: 'Buxoro long',
      color: 'Кора', pattaCount: 10, cumulativePattaCount: 10,
      ishSoni: 650, cumulativeIshSoni: 0,
      sizes: { M: '10' }, printedAt: '2026-09-07T14:52:00.000Z'
    }, [], ['M']);

    expect(tickets.map((ticket) => ticket.expectedQty)).toEqual(Array(10).fill(65));
    expect(tickets.reduce((sum, ticket) => sum + ticket.expectedQty, 0)).toBe(650);
  });
});
