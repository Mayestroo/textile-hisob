import { describe, expect, it } from 'vitest';
import { buildPartyTicketsList, getPartyHealth } from './partyAnalytics';
import type { PrintedPartyRecord, SubmittedTicketRecord } from '../types/workbook';

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

  it('marks archived patta numbers from previous months as submitted when includeArchived is true', () => {
    const party = {
      id: 'party-prev', partyNumber: '1', modelId: 'model-a', modelName: 'Model A',
      color: 'Ko\'k', pattaCount: 5, cumulativePattaCount: 5,
      ishSoniPerPatta: 50, totalIshSoni: 250, ishSoni: 250, cumulativeIshSoni: 0,
      sizes: { M: '5' }, printedAt: '2026-09-01T10:00:00.000Z',
      archivedPattaNumbers: [1, 2, 3]
    };

    const tickets = buildPartyTicketsList(party, [], ['M'], true);
    expect(tickets).toHaveLength(5);
    expect(tickets.filter((t) => t.isSubmitted)).toHaveLength(3);
    expect(tickets.filter((t) => !t.isSubmitted)).toHaveLength(2);
    expect(tickets[0].enteredQty).toBe(50);
    expect(tickets[0].deficit).toBe(0);
    expect(tickets[3].enteredQty).toBe(0);
    expect(tickets[3].deficit).toBe(50);
  });
});

describe('party printed/legacy number namespaces', () => {
  const party: PrintedPartyRecord = {
    id: 'party-a', partyNumber: '7', modelId: 'model-a', modelName: 'A', color: '',
    pattaCount: 2, cumulativePattaCount: 3, pattaStartNumber: 2, pattaEndNumber: 3,
    ishSoniPerPatta: 10, ishSoni: 20, cumulativeIshSoni: 20, sizes: { M: '1', L: '1' }, printedAt: ''
  };
  const ticket = (number: number, extra = {}): SubmittedTicketRecord => ({
    id: `ticket-${number}`, modelId: 'model-a', partyNumber: '7', partyRecordId: 'party-a',
    pattaNumber: number, qty: 10, submittedAt: '2026-09-01', ...extra
  });
  it('displays actual ticket 2 once in range 2..3, including archive-only-submitted mode', () => {
    const rows = buildPartyTicketsList(party, [ticket(2)], ['M']);
    expect(rows.map(r => [r.pattaNumber, r.size, r.id, r.enteredQty, r.isSubmitted]))
      .toEqual([[2, 'M', 'ticket-2', 10, true], [3, 'L', undefined, 0, false]]);
    expect(rows.filter(r => r.isSubmitted)).toHaveLength(1);
    expect(rows.reduce((sum, r) => sum + r.enteredQty, 0)).toBe(10);
    expect(getPartyHealth(rows).status).toBe('in_progress');
    expect(buildPartyTicketsList(party, [ticket(2)], [], true, true).map(r => r.pattaNumber)).toEqual([2]);
  });
  it('gives absolute matches precedence over conflicting legacy fallback regardless of input order', () => {
    for (const tickets of [[ticket(1, { qty: 99 }), ticket(2)], [ticket(2), ticket(1, { qty: 99 })]]) {
      const rows = buildPartyTicketsList(party, tickets, []);
      expect(rows.map(r => [r.pattaNumber, r.enteredQty, r.isSubmitted])).toEqual([[2, 10, true], [3, 0, false]]);
    }
  });
  it('maps each archived number once with the same absolute-first rule, even when its row is hidden', () => {
    const archived = { ...party, archivedPattaNumbers: [2] };
    const rows = buildPartyTicketsList(archived, [ticket(2)], []);
    expect(rows.map(r => [r.pattaNumber, r.enteredQty, r.isSubmitted])).toEqual([[3, 0, false]]);
    expect(buildPartyTicketsList(archived, [ticket(2)], [], true)).toHaveLength(2);
    expect(buildPartyTicketsList({ ...party, archivedPattaNumbers: [1, 2] }, [], []).map(r => r.pattaNumber)).toEqual([3]);
  });
  it('preserves unambiguous legacy relative submissions and archived numbers using stored or inferred range', () => {
    const legacy = { ...party, pattaStartNumber: undefined, pattaEndNumber: undefined, cumulativePattaCount: 12 };
    const rows = buildPartyTicketsList(legacy, [ticket(1), ticket(2)], []);
    expect(rows.map(r => [r.pattaNumber, r.enteredQty])).toEqual([[11, 10], [12, 10]]);
    expect(rows.filter(r => r.isSubmitted)).toHaveLength(2);
    expect(getPartyHealth(rows).status).toBe('complete');
    expect(buildPartyTicketsList({ ...legacy, archivedPattaNumbers: [1] }, [ticket(2)], []).map(r => [r.pattaNumber, r.enteredQty]))
      .toEqual([[12, 10]]);
    expect(buildPartyTicketsList({ ...legacy, pattaEndNumber: 22 }, [ticket(1)], [])[0].pattaNumber).toBe(21);
  });
  it('keeps start=1, archived history, party/model scope and duplicate ticket identity safe', () => {
    const first = { ...party, pattaStartNumber: 1, pattaEndNumber: 2, isClosed: true };
    const rows = buildPartyTicketsList(first, [ticket(1, { isClosed: true }),
      ticket(2, { partyRecordId: 'other' }), ticket(2, { partyRecordId: null, modelId: 'other', isClosed: true })], [], true);
    expect(rows.map(r => r.enteredQty)).toEqual([10, 0]);
    const duplicate = buildPartyTicketsList(party, [ticket(2), ticket(3, { id: 'ticket-2' })], []);
    expect(duplicate.filter(r => r.isSubmitted)).toHaveLength(1);
  });
});
