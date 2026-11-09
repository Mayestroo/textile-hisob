/** Pure journal-only classifier. It does not mutate payroll or reservation state. */
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
}

export function selectLifecycleItems(input: {
  parties: readonly LifecycleParty[];
  tickets: readonly LifecycleTicket[];
  periods: readonly LifecyclePeriod[];
  mode?: 'current' | 'all-time' | 'archive';
  archivePeriodId?: string;
}): { items: LifecycleItem[]; excludedAttempts: LifecycleTicket[]; incomplete: string[] } {
  const { parties, tickets, periods, mode = 'all-time', archivePeriodId } = input;
  const partyById = new Map(parties.map(p => [p.id, p]));
  const periodById = new Map(periods.map(p => [p.id, p]));
  const archived = new Map(periods.map(p => [p.id, new Set(p.archivedTicketIds || [])]));
  const occupied = new Set<string>();
  const seenTickets = new Map<string, LifecycleTicket>();
  const items: LifecycleItem[] = [];
  const excludedAttempts: LifecycleTicket[] = [];
  const incomplete: string[] = [];
  const ended = (party?: LifecycleParty) => Boolean(party?.endedAt && party?.endedOperationId);
  for (const ticket of tickets) {
    const old = seenTickets.get(ticket.id);
    if (old) {
      if (old.periodId !== ticket.periodId || old.partyRecordId !== ticket.partyRecordId || old.qty !== ticket.qty) incomplete.push(`CONFLICTING_TICKET:${ticket.id}`);
      continue;
    }
    seenTickets.set(ticket.id, ticket);
    if (ticket.status === 'VOIDED' || ticket.status === 'PENDING_DELETE' || ticket.status === 'CONFLICT') {
      excludedAttempts.push(ticket); continue;
    }
    const party = ticket.partyRecordId ? partyById.get(ticket.partyRecordId) : undefined;
    const ticketCompany = ticket.companyId || party?.companyId || 'company_main';
    const exact = party && (!party.companyId || !ticket.companyId || party.companyId === ticket.companyId) && party.modelId === ticket.modelId;
    if (ticket.partyRecordId && !exact) incomplete.push(`UNKNOWN_PARTY:${ticket.id}`);
    const period = ticket.periodId ? periodById.get(ticket.periodId) : undefined;
    const inArchive = Boolean(ticket.periodId && archived.get(ticket.periodId)?.has(ticket.id));
    const accepted = ticket.status === 'CONFIRMED' || (!ticket.status && inArchive);
    if (!ticket.status && !inArchive) incomplete.push(`UNKNOWN_ACCEPTANCE:${ticket.id}`);
    if (mode === 'archive' && (!accepted || archivePeriodId !== ticket.periodId || !inArchive)) continue;
    if (mode === 'current' && party?.isArchived) continue;
    const slotKey = exact ? `${ticketCompany}:${party.id}:${ticket.pattaNumber}` : null;
    if (slotKey && accepted) {
      if (occupied.has(slotKey)) { incomplete.push(`DUPLICATE_SLOT:${slotKey}`); continue; }
      occupied.add(slotKey);
    }
    const closed = accepted && Boolean((period?.isClosed && period.closeOperationId) || (period?.isClosed && inArchive));
    const legacy = !exact && Boolean(ticket.partyRecordId) || (ticket.isClosed && !closed) || (party?.isClosed && !closed);
    const lifecycle: PattaLifecycle = exact && ended(party) ? 'ended' : closed ? 'closed' : legacy ? 'legacy' : 'active';
    items.push({ key: slotKey || `${ticketCompany}:free:${ticket.id}`, companyId: ticketCompany,
      partyId: exact ? party.id : null, modelId: ticket.modelId, pattaNumber: ticket.pattaNumber,
      ticketId: ticket.id, periodId: ticket.periodId || null, lifecycle,
      evidence: lifecycle === 'ended' ? 'finish' : closed ? inArchive ? 'archive' : 'period' : legacy ? 'unknown' : 'open',
      accepted, actualQuantity: accepted && Number.isFinite(ticket.qty) ? Number(ticket.qty) : null,
      hidden: Boolean(party?.isArchived) });
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
        hidden: Boolean(party.isArchived) });
    }
  }
  return { items, excludedAttempts, incomplete };
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
