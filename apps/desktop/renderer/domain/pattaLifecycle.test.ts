import { describe, expect, it } from 'vitest';
import { groupLifecycleCohorts, selectLifecycleItems, type LifecycleParty, type LifecycleTicket } from './pattaLifecycle';

describe('exact-ID lifecycle cohorts separate from payroll', () => {
  const parties: LifecycleParty[] = [
    { id: 'A', companyId: 'own', modelId: 'M', pattaCount: 2, pattaStartNumber: 1 },
    { id: 'B', companyId: 'own', modelId: 'M', pattaCount: 1, pattaStartNumber: 3, isClosed: true }
  ];
  const tickets: LifecycleTicket[] = [
    { id: 'A1', companyId: 'own', modelId: 'M', partyRecordId: 'A', pattaNumber: 1, periodId: 'P', status: 'CONFIRMED', qty: 10 },
    { id: 'B1', companyId: 'own', modelId: 'M', partyRecordId: 'B', pattaNumber: 3, periodId: 'P', status: 'CONFIRMED', qty: 7 }
  ];
  const P = { id: 'P', isClosed: true, closeOperationId: 'closeP', archivedTicketIds: ['A1', 'B1'] };
  const Q = { id: 'Q', isClosed: false };
  const counts = (items: ReturnType<typeof selectLifecycleItems>['items']) => Object.fromEntries(
    ['active', 'closed', 'ended', 'legacy'].map(lifecycle => [lifecycle, {
      groups: groupLifecycleCohorts(items.filter(item => item.lifecycle === lifecycle)).length,
      pattas: items.filter(item => item.lifecycle === lifecycle).length,
      actual: items.filter(item => item.lifecycle === lifecycle).reduce((sum, item) => sum + (item.actualQuantity || 0), 0)
    }]));

  it('Case 2: P closes A1 and B1 but carries A2; P archive has entered tickets only', () => {
    const all = selectLifecycleItems({ parties, tickets, periods: [P, Q] });
    expect(counts(all.items)).toMatchObject({ active: { groups: 1, pattas: 1, actual: 0 },
      closed: { groups: 2, pattas: 2, actual: 17 } });
    expect(counts(selectLifecycleItems({ parties, tickets, periods: [P, Q], mode: 'archive', archivePeriodId: 'P' }).items))
      .toMatchObject({ closed: { groups: 2, pattas: 2, actual: 17 }, active: { pattas: 0 } });
  });

  it('Case 3: Q enters five and exact accepted series finish overlays both months without changing P facts', () => {
    const entered = [...tickets, { id: 'A2', companyId: 'own', modelId: 'M', partyRecordId: 'A', pattaNumber: 2,
      periodId: 'Q', status: 'CONFIRMED', qty: 5 }];
    const after = parties.map(party => ({ ...party, endedAt: '2026-11-09T00:00:00.000Z', endedOperationId: 'finishQ' }));
    const result = selectLifecycleItems({ parties: after, tickets: entered, periods: [P, Q] });
    expect(counts(result.items).ended).toEqual({ groups: 2, pattas: 3, actual: 22 });
    expect(counts(selectLifecycleItems({ parties: after, tickets: entered, periods: [P, Q], mode: 'archive', archivePeriodId: 'P' }).items).ended)
      .toEqual({ groups: 2, pattas: 2, actual: 17 });
    expect(result.items.map(item => item.ticketId)).toEqual(['A1', 'B1', 'A2']);
    expect(17 * 7).toBe(119);
    expect(5 * 9).toBe(45);
  });

  it('Case 4: Finish incomplete party C (2 slots, 1 entered qty 8) yields 1 group / 2 pattas, actual 8', () => {
    const partyC: LifecycleParty = {
      id: 'C', companyId: 'own', modelId: 'M', pattaCount: 2, pattaStartNumber: 1,
      endedAt: '2026-11-09T12:00:00.000Z', endedOperationId: 'op_finish_C'
    };
    const ticketC1: LifecycleTicket = {
      id: 'C1', companyId: 'own', modelId: 'M', partyRecordId: 'C', pattaNumber: 1,
      periodId: 'P', status: 'CONFIRMED', qty: 8
    };
    const res = selectLifecycleItems({ parties: [partyC], tickets: [ticketC1], periods: [P] });
    expect(counts(res.items).ended).toEqual({ groups: 1, pattas: 2, actual: 8 });
    const unentered = res.items.find(item => item.pattaNumber === 2);
    expect(unentered?.accepted).toBe(false);
    expect(unentered?.actualQuantity).toBe(null);
  });

  it('Case 6: Exclusions (legacy L, hidden H, already-ended E)', () => {
    const mixParties: LifecycleParty[] = [
      { id: 'L', companyId: 'own', modelId: 'M', pattaCount: 1, isClosed: true }, // unknown legacy
      { id: 'H', companyId: 'own', modelId: 'M', pattaCount: 1, isArchived: true }, // history-hidden
      { id: 'E', companyId: 'own', modelId: 'M', pattaCount: 1, isClosed: true, endedAt: '2026-10-01', endedOperationId: 'op_old' } // ended
    ];
    // In current mode, hidden H is omitted
    const currentRes = selectLifecycleItems({ parties: mixParties, tickets: [], periods: [P], mode: 'current' });
    expect(currentRes.items.some(i => i.partyId === 'H')).toBe(false);
    expect(currentRes.items.find(i => i.partyId === 'L')?.lifecycle).toBe('legacy');
    expect(currentRes.items.find(i => i.partyId === 'E')?.lifecycle).toBe('ended');

    // In all-time mode, hidden H is included with hidden=true
    const allTimeRes = selectLifecycleItems({ parties: mixParties, tickets: [], periods: [P], mode: 'all-time' });
    const hiddenItem = allTimeRes.items.find(i => i.partyId === 'H');
    expect(hiddenItem).toBeDefined();
    expect(hiddenItem?.hidden).toBe(true);
  });

  it('Case 7: Old archive pre-close party.isClosed=false with confirmed P ticket shows CLOSED', () => {
    const oldParty: LifecycleParty = { id: 'OldP', companyId: 'own', modelId: 'M', pattaCount: 1, isClosed: false };
    const oldTicket: LifecycleTicket = { id: 'tOld', companyId: 'own', modelId: 'M', partyRecordId: 'OldP', pattaNumber: 1, periodId: 'P', status: 'CONFIRMED', qty: 15 };
    const res = selectLifecycleItems({ parties: [oldParty], tickets: [oldTicket], periods: [P] });
    expect(res.items[0].lifecycle).toBe('closed');
    expect(res.items[0].actualQuantity).toBe(15);
  });

  it('Case 12: Excluded attempts (VOIDED, PENDING_DELETE, CONFLICT) do not fulfill slots', () => {
    const freshParty: LifecycleParty = { id: 'F', companyId: 'own', modelId: 'M', pattaCount: 1, pattaStartNumber: 1 };
    const voidTicket: LifecycleTicket = { id: 'v1', companyId: 'own', modelId: 'M', partyRecordId: 'F', pattaNumber: 1, status: 'VOIDED', qty: 10 };
    const res = selectLifecycleItems({ parties: [freshParty], tickets: [voidTicket], periods: [Q] });
    expect(res.excludedAttempts).toHaveLength(1);
    expect(res.items[0].lifecycle).toBe('active');
    expect(res.items[0].accepted).toBe(false);
    expect(res.items[0].actualQuantity).toBe(null);
  });

  it('Case 16: Free mode tickets show CLOSED without fabricated party; groups can be 0', () => {
    const freeTicket: LifecycleTicket = {
      id: 'free_1', companyId: 'own', modelId: 'M', partyRecordId: null, pattaNumber: 0,
      periodId: 'P', status: 'CONFIRMED', qty: 25
    };
    const res = selectLifecycleItems({ parties: [], tickets: [freeTicket], periods: [P] });
    expect(res.items[0].lifecycle).toBe('closed');
    expect(res.items[0].partyId).toBe(null);
    expect(counts(res.items).closed).toEqual({ groups: 0, pattas: 1, actual: 25 });
  });
});
