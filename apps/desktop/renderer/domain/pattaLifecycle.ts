/** Pure journal-only classifier. It does not mutate payroll or reservation state. */
import { buildPartyTicketsList } from './partyAnalytics';
export type PattaLifecycle = 'active' | 'closed' | 'ended' | 'legacy';

export interface LifecycleParty {
  id: string;
  companyId?: string;
  modelId: string;
  pattaCount: number;
  pattaStartNumber?: number | null;
  isClosed?: boolean;
  isArchived?: boolean;
  endedAt?: string | null;
  endedOperationId?: string | null;
  archivedPattaNumbers?: number[];
}

export interface LifecycleTicket {
  id: string;
  companyId?: string;
  modelId: string;
  partyRecordId?: string | null;
  pattaNumber: number;
  periodId?: string | null;
  status?: string;
  qty?: number | null;
  isClosed?: boolean;
}

export interface LifecyclePeriod {
  id: string;
  isClosed: boolean;
  closeOperationId?: string | null;
  /** Verified immutable archive contains this exact accepted ticket ID. */
  archivedTicketIds?: readonly string[];
}

export interface LifecycleItem {
  key: string;
  companyId: string;
  partyId: string | null;
  modelId: string;
  pattaNumber: number;
  ticketId: string | null;
  periodId: string | null;
  lifecycle: PattaLifecycle;
  evidence: 'finish' | 'period' | 'archive' | 'unknown' | 'open';
  accepted: boolean;
  actualQuantity: number | null;
  hidden: boolean;
  pendingClose?: boolean;
  /** A matching PENDING_SYNC attempt makes this unaccepted slot's actual unknown. */
  pendingAttempt?: boolean;
}

export function selectLifecycleItems(input: {
  parties: readonly LifecycleParty[];
  tickets: readonly LifecycleTicket[];
  periods: readonly LifecyclePeriod[];
  mode?: 'current' | 'all-time' | 'archive';
  archivePeriodId?: string;
  pendingClosePeriodIds?: readonly string[];
}): { items: LifecycleItem[]; excludedAttempts: LifecycleTicket[]; incomplete: string[] } {
  const { parties, tickets, periods, mode = 'all-time', archivePeriodId, pendingClosePeriodIds = [] } = input;
  const partyById = new Map(parties.map(p => [p.id, p]));
  const periodById = new Map(periods.map(p => [p.id, p]));
  const archived = new Map(periods.map(p => [p.id, new Set(p.archivedTicketIds || [])]));
  const occupied = new Set<string>();
  const seenTickets = new Map<string, LifecycleTicket>();
  const items: LifecycleItem[] = [];
  const excludedAttempts: LifecycleTicket[] = [];
  const incomplete: string[] = [];
  const ended = (party?: LifecycleParty) => Boolean(party?.endedAt && party?.endedOperationId);
  const normalizedNumber = new Map<string, number>();
  const unresolvedPartyTicketIds = new Set<string>();
  for (const party of parties) {
    const partyTickets = tickets.filter((ticket) => ticket.partyRecordId === party.id && ticket.modelId === party.modelId &&
      (ticket.status === 'CONFIRMED' || (!ticket.status && Boolean(ticket.periodId && archived.get(ticket.periodId)?.has(ticket.id)))));
    const slots = buildPartyTicketsList({ id: party.id, companyId: party.companyId, modelId: party.modelId,
      partyNumber: '', pattaCount: party.pattaCount, cumulativePattaCount: (party.pattaStartNumber || 1) + party.pattaCount - 1,
      pattaStartNumber: party.pattaStartNumber || 1, pattaEndNumber: (party.pattaStartNumber || 1) + party.pattaCount - 1,
      sizes: { __slot: String(party.pattaCount) }, ishSoniPerPatta: 0, totalIshSoni: 0, ishSoni: 0,
      cumulativeIshSoni: 0, printedAt: '', archivedPattaNumbers: [], isClosed: false } as any,
    partyTickets.map((ticket) => ({ id: ticket.id, partyRecordId: ticket.partyRecordId, partyNumber: '', modelId: ticket.modelId,
      pattaNumber: ticket.pattaNumber, qty: Number(ticket.qty || 0), status: ticket.status as any,
      isClosed: false, submittedAt: '' } as any)), ['__slot'], true);
    for (const slot of slots) if (slot.id) normalizedNumber.set(slot.id, slot.pattaNumber);
    for (const ticket of partyTickets) if (!normalizedNumber.has(ticket.id)) unresolvedPartyTicketIds.add(ticket.id);
  }
  for (const ticketId of [...unresolvedPartyTicketIds]) {
    const ticket = tickets.find((candidate) => candidate.id === ticketId);
    const party = ticket?.partyRecordId ? partyById.get(ticket.partyRecordId) : undefined;
    if (!ticket || !party) continue;
    const start = party.pattaStartNumber || 1;
    const absoluteEnd = start + party.pattaCount - 1;
    const target = ticket.pattaNumber >= start && ticket.pattaNumber <= absoluteEnd
      ? ticket.pattaNumber
      : ticket.pattaNumber >= 1 && ticket.pattaNumber <= party.pattaCount ? start + ticket.pattaNumber - 1 : undefined;
    if (target !== undefined && [...normalizedNumber.values()].includes(target)) {
      normalizedNumber.set(ticket.id, target);
      unresolvedPartyTicketIds.delete(ticket.id);
    }
  }
  const normalizedTickets = tickets.map((ticket) => {
    const pattaNumber = normalizedNumber.get(ticket.id);
    if (pattaNumber === undefined || pattaNumber === ticket.pattaNumber) return ticket;
    return { ...ticket, pattaNumber };
  });
  const absoluteTicketIds = new Set(tickets.filter((ticket) => {
    const party = ticket.partyRecordId ? partyById.get(ticket.partyRecordId) : undefined;
    const start = party?.pattaStartNumber || 1;
    return Boolean(party && ticket.pattaNumber >= start && ticket.pattaNumber <= start + party.pattaCount - 1);
  }).map(ticket => ticket.id));
  const pendingAttemptSlots = new Set<string>();
  if (mode !== 'archive') for (const ticket of normalizedTickets) {
    if (ticket.status !== 'PENDING_SYNC' || !ticket.partyRecordId || !ticket.periodId) continue;
    const party = partyById.get(ticket.partyRecordId);
    const period = periodById.get(ticket.periodId);
    if (!party || !period || period.isClosed || party.isClosed || party.isArchived || ended(party) ||
        party.modelId !== ticket.modelId || (party.companyId && ticket.companyId && party.companyId !== ticket.companyId)) continue;
    const start = party.pattaStartNumber || 1;
    const end = start + party.pattaCount - 1;
    const target = ticket.pattaNumber >= start && ticket.pattaNumber <= end
      ? ticket.pattaNumber
      : ticket.pattaNumber >= 1 && ticket.pattaNumber <= party.pattaCount
        ? start + ticket.pattaNumber - 1
        : undefined;
    if (target === undefined) continue;
    const companyId = ticket.companyId || party.companyId || 'company_main';
    pendingAttemptSlots.add(`${companyId}:${party.id}:${target}`);
  }
  const candidatesBySlot = new Map<string, LifecycleTicket[]>();
  for (const ticket of normalizedTickets) {
    const old = seenTickets.get(ticket.id);
    if (old) {
      if (old.companyId !== ticket.companyId || old.modelId !== ticket.modelId || old.periodId !== ticket.periodId ||
          old.partyRecordId !== ticket.partyRecordId || old.pattaNumber !== ticket.pattaNumber || old.qty !== ticket.qty) {
        incomplete.push(`CONFLICTING_TICKET:${ticket.id}`);
      }
      continue;
    }
    seenTickets.set(ticket.id, ticket);
    const isInArchive = Boolean(ticket.periodId && archived.get(ticket.periodId)?.has(ticket.id));
    if ((ticket.status === 'UNKNOWN' || !ticket.status) && !isInArchive) incomplete.push(`UNKNOWN_ACCEPTANCE:${ticket.id}`);
    if (ticket.status !== 'CONFIRMED' && !( !ticket.status && Boolean(ticket.periodId && archived.get(ticket.periodId)?.has(ticket.id)))) {
      excludedAttempts.push(ticket); continue;
    }
    if (unresolvedPartyTicketIds.has(ticket.id)) {
      incomplete.push(`OUT_OF_RANGE_TICKET:${ticket.id}`);
      excludedAttempts.push(ticket);
      continue;
    }
    const party = ticket.partyRecordId ? partyById.get(ticket.partyRecordId) : undefined;
    const ticketCompany = ticket.companyId || party?.companyId || 'company_main';
    const exact = party && (!party.companyId || !ticket.companyId || party.companyId === ticket.companyId) && party.modelId === ticket.modelId;
    if (ticket.partyRecordId && !exact) incomplete.push(`UNKNOWN_PARTY:${ticket.id}`);
    const period = ticket.periodId ? periodById.get(ticket.periodId) : undefined;
    const inArchive = Boolean(ticket.periodId && archived.get(ticket.periodId)?.has(ticket.id));
    const accepted = ticket.status === 'CONFIRMED' || (!ticket.status && inArchive);
    if (mode === 'archive' && (!accepted || archivePeriodId !== ticket.periodId || !inArchive)) continue;
    if (mode === 'current' && party?.isArchived) continue;
    const slotKey = exact ? `${ticketCompany}:${party.id}:${ticket.pattaNumber}` : null;
    if (slotKey && accepted) {
      candidatesBySlot.set(slotKey, [...(candidatesBySlot.get(slotKey) || []), ticket]);
      continue;
    }
    const closed = accepted && Boolean(period?.isClosed && inArchive);
    const legacy = !exact && Boolean(ticket.partyRecordId) || (ticket.isClosed && !closed) || (party?.isClosed && !closed);
    const lifecycle: PattaLifecycle = exact && ended(party) ? 'ended' : closed ? 'closed' : legacy ? 'legacy' : 'active';
    items.push({ key: slotKey || `${ticketCompany}:free:${ticket.id}`, companyId: ticketCompany,
      partyId: exact ? party.id : null, modelId: ticket.modelId, pattaNumber: ticket.pattaNumber,
      ticketId: ticket.id, periodId: ticket.periodId || null, lifecycle,
      evidence: lifecycle === 'ended' ? 'finish' : closed ? inArchive ? 'archive' : 'period' : legacy ? 'unknown' : 'open',
      accepted, actualQuantity: accepted && Number.isFinite(ticket.qty) ? Number(ticket.qty) : null,
      hidden: Boolean(party?.isArchived), pendingClose: Boolean(ticket.periodId && pendingClosePeriodIds.includes(ticket.periodId)),
      pendingAttempt: Boolean(slotKey && pendingAttemptSlots.has(slotKey)) });
  }
  for (const [slotKey, slotTickets] of candidatesBySlot) {
    const ordered = [...slotTickets].sort((a, b) => Number(absoluteTicketIds.has(b.id)) - Number(absoluteTicketIds.has(a.id)) || a.id.localeCompare(b.id));
    const ticket = ordered[0];
    if (ordered.length > 1) incomplete.push(`DUPLICATE_SLOT:${slotKey}`);
    occupied.add(slotKey);
    const party = ticket.partyRecordId ? partyById.get(ticket.partyRecordId) : undefined;
    const period = ticket.periodId ? periodById.get(ticket.periodId) : undefined;
    const inArchive = Boolean(ticket.periodId && archived.get(ticket.periodId)?.has(ticket.id));
    const closed = Boolean(period?.isClosed && inArchive);
    const lifecycle: PattaLifecycle = ended(party) ? 'ended' : closed ? 'closed' : (party?.isClosed ? 'legacy' : 'active');
    items.push({ key: slotKey, companyId: ticket.companyId || party?.companyId || 'company_main', partyId: party?.id || null,
      modelId: ticket.modelId, pattaNumber: ticket.pattaNumber, ticketId: ticket.id, periodId: ticket.periodId || null,
      lifecycle, evidence: lifecycle === 'ended' ? 'finish' : closed ? inArchive ? 'archive' : 'period' : 'open',
      accepted: true, actualQuantity: Number.isFinite(ticket.qty) ? Number(ticket.qty) : null,
      hidden: Boolean(party?.isArchived), pendingClose: Boolean(ticket.periodId && pendingClosePeriodIds.includes(ticket.periodId)),
      pendingAttempt: pendingAttemptSlots.has(slotKey) });
  }
  if (mode !== 'archive') for (const party of parties) {
    if (mode === 'current' && party.isArchived) continue;
    const pCompany = party.companyId || 'company_main';
    for (let offset = 0; offset < party.pattaCount; offset += 1) {
      const pattaNumber = (party.pattaStartNumber || 1) + offset;
      const key = `${pCompany}:${party.id}:${pattaNumber}`;
      if (occupied.has(key) || items.some(item => item.key === key)) continue;
      const legacy = party.isArchived || party.isClosed || party.archivedPattaNumbers?.includes(pattaNumber);
      items.push({ key, companyId: pCompany, partyId: party.id, modelId: party.modelId, pattaNumber,
        ticketId: null, periodId: null, lifecycle: ended(party) ? 'ended' : legacy ? 'legacy' : 'active',
        evidence: ended(party) ? 'finish' : legacy ? 'unknown' : 'open', accepted: false, actualQuantity: null,
        hidden: Boolean(party.isArchived), pendingAttempt: pendingAttemptSlots.has(key) });
    }
  }
  return { items, excludedAttempts, incomplete };
}

export function countPendingActualUncertainty(items: readonly LifecycleItem[]): number {
  return items.filter((item) => item.pendingAttempt && !item.accepted && item.actualQuantity === null).length;
}

export function summarizeActualWorkUncertainty(items: readonly LifecycleItem[], unknownExpectedWorkCount = 0) {
  const unknownLegacyActualCount = items.filter((item) => item.partyId && item.lifecycle === 'legacy' && !item.accepted && item.actualQuantity === null).length;
  const pendingUnknownActualCount = countPendingActualUncertainty(items);
  return {
    unknownLegacyActualCount,
    pendingUnknownActualCount,
    unknownPartyActualCount: unknownLegacyActualCount + pendingUnknownActualCount,
    hasUnknownActual: unknownExpectedWorkCount > 0 || unknownLegacyActualCount > 0 || pendingUnknownActualCount > 0
  };
}

export function groupLifecycleCohorts(items: readonly LifecycleItem[]) {
  const groups = new Map<string, LifecycleItem[]>();
  for (const item of items) {
    if (!item.partyId) continue;
    const key = `${item.companyId}:${item.partyId}:${item.lifecycle}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return [...groups].map(([key, entries]) => ({ key, items: entries }));
}
