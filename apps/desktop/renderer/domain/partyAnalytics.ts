import { PrintedPartyRecord, SubmittedTicketRecord } from '../types/workbook';

export interface PartyPattaItem {
  pattaNumber: number;
  actualPattaNumber?: number;
  relativePattaNumber?: number;
  size: string;
  expectedQty: number;
  isSubmitted: boolean;
  enteredQty: number;
  deficit: number;
  submittedAt?: string;
  id?: string;
}

export interface PartyHealthResult {
  status: 'empty' | 'skipped' | 'mismatch' | 'surplus' | 'deficit' | 'complete' | 'waiting' | 'in_progress';
  label: string;
  isError: boolean;
  hasMismatch: boolean;
  message: string;
}

/**
 * Builds list of individual patta items for a given printed party record
 */
export function buildPartyTicketsList(
  partyRecord: PrintedPartyRecord,
  submittedTickets: SubmittedTicketRecord[],
  activeSizes: string[],
  includeArchived: boolean = false,
  onlySubmitted: boolean = false
): PartyPattaItem[] {
  const list: PartyPattaItem[] = [];
  const partyNumStr = String(partyRecord.partyNumber);
  const modelId = partyRecord.modelId;

  const relevantTickets = (submittedTickets || []).filter((t) => {
    if (t.partyRecordId && partyRecord.id) {
      return t.partyRecordId === partyRecord.id;
    }
    return (
      String(t.partyNumber) === partyNumStr &&
      t.modelId === modelId &&
      (partyRecord.isClosed ? t.isClosed : !t.isClosed)
    );
  });

  let currentPattaIndex = 1;
  const sizesObj = partyRecord.sizes || {};
  const storedPerPatta = Number(partyRecord.ishSoniPerPatta);
  const legacyPartyTotal = Number(partyRecord.totalIshSoni ?? partyRecord.ishSoni);
  const ishSoniPerPatta = Number.isFinite(storedPerPatta) && storedPerPatta > 0
    ? storedPerPatta
    : partyRecord.pattaCount > 0 && Number.isFinite(legacyPartyTotal)
      ? legacyPartyTotal / partyRecord.pattaCount
      : 0;
  const endPatta = partyRecord.pattaEndNumber ?? partyRecord.cumulativePattaCount;
  const startPatta = partyRecord.pattaStartNumber
    ?? (endPatta > partyRecord.pattaCount
      ? endPatta - partyRecord.pattaCount + 1
      : 1);

  // Combine activeSizes with any keys in sizesObj to ensure all printed sizes are evaluated
  const allSizes = Array.from(new Set([...activeSizes, ...Object.keys(sizesObj)]));
  const slots: Array<{ actual: number; relative: number; size: string }> = [];

  for (const sz of allSizes) {
    const countForSize = parseInt(sizesObj[sz] || '0', 10);
    if (!countForSize || countForSize <= 0) continue;

    for (let i = 0; i < countForSize; i++) {
      const relNum = currentPattaIndex++;
      const actualSeqNum = startPatta + relNum - 1;
      slots.push({ actual: actualSeqNum, relative: relNum, size: sz });
    }
  }

  // Resolve against ALL printed slots before hiding archived rows. A number in
  // the absolute namespace must never be reused as a relative number elsewhere.
  // Legacy relative numbers remain supported only outside the absolute range.
  const actualNumbers = new Set(slots.map(slot => slot.actual));
  const resolveNumber = (number: number): number | undefined => {
    if (actualNumbers.has(number)) return number;
    if (Number.isSafeInteger(number) && number >= 1 && number <= slots.length) return startPatta + number - 1;
    return undefined;
  };
  const ticketByPattaNumber = new Map<number, SubmittedTicketRecord>();
  const usedTicketIds = new Set<string>();
  // Reserve absolute matches first, independent of input order; fallback cannot
  // overwrite an absolute ticket or assign the same ticket identity twice.
  for (const absolutePass of [true, false]) {
    for (const ticket of relevantTickets) {
      if (actualNumbers.has(ticket.pattaNumber) !== absolutePass) continue;
      const actual = resolveNumber(ticket.pattaNumber);
      if (actual === undefined || ticketByPattaNumber.has(actual) || usedTicketIds.has(ticket.id)) continue;
      ticketByPattaNumber.set(actual, ticket);
      usedTicketIds.add(ticket.id);
    }
  }
  const archivedSet = new Set((partyRecord.archivedPattaNumbers || []).map(resolveNumber));

  for (const { actual: actualSeqNum, relative: relNum, size: sz } of slots) {
    const isArchived = archivedSet.has(actualSeqNum);
    if (!includeArchived && isArchived) continue;
    const sub = ticketByPattaNumber.get(actualSeqNum);
    // Archived patta numbers represent fulfilled work even if their original
    // ticket is no longer present in the current projection.
    const isSubmitted = !!sub || isArchived;

    // In closed/archived months, if onlySubmitted is requested, skip unentered tickets!
    if (onlySubmitted && !isSubmitted) {
      continue;
    }

    const enteredQty = sub ? sub.qty : (isArchived ? ishSoniPerPatta : 0);
    const expected = ishSoniPerPatta;
    const deficit = isSubmitted ? expected - enteredQty : expected;

    list.push({
      id: sub?.id,
      pattaNumber: actualSeqNum,
      actualPattaNumber: actualSeqNum,
      relativePattaNumber: relNum,
      size: sz,
      expectedQty: expected,
      isSubmitted,
      enteredQty,
      deficit,
      submittedAt: sub?.submittedAt
    });
  }

  return list;
}

/**
 * Evaluates the completion and discrepancy health of a party with exact UI labels
 */
export function getPartyHealth(ticketsList: PartyPattaItem[]): PartyHealthResult {
  if (ticketsList.length === 0) {
    return { status: 'empty', label: "Bo'sh", isError: false, hasMismatch: false, message: '' };
  }

  const submitted = ticketsList.filter((t) => t.isSubmitted);
  const submittedCount = submitted.length;
  const maxSubmittedNum = Math.max(0, ...submitted.map((t) => t.pattaNumber));

  const deficitTickets = ticketsList.filter((t) => t.isSubmitted && t.enteredQty < t.expectedQty);
  const surplusTickets = ticketsList.filter((t) => t.isSubmitted && t.enteredQty > t.expectedQty);
  const skippedTickets = ticketsList.filter((t) => !t.isSubmitted && t.pattaNumber < maxSubmittedNum);

  const hasDeficit = deficitTickets.length > 0;
  const hasSurplus = surplusTickets.length > 0;
  const hasSkipped = skippedTickets.length > 0;

  if (hasSkipped) {
    const missingStr = skippedTickets.map((t) => `Patta ${t.pattaNumber}`).join(', ');
    return {
      status: 'skipped',
      label: `⚠️ ${missingStr} kiritilmagan!`,
      isError: true,
      hasMismatch: true,
      message: `${missingStr} o'tkazib yuborilgan!`
    };
  }

  if (hasSurplus && hasDeficit) {
    return {
      status: 'mismatch',
      label: `⚠️ Tafovut mavjud`,
      isError: true,
      hasMismatch: true,
      message: 'Haqiqiy son reja bilan farq qilmoqda!'
    };
  }

  if (hasSurplus) {
    const surplusStr = surplusTickets.map((t) => `Patta ${t.pattaNumber} (+${t.enteredQty - t.expectedQty})`).join(', ');
    return {
      status: 'surplus',
      label: `⚠️ Ortiqcha: ${surplusStr}`,
      isError: true,
      hasMismatch: true,
      message: 'Ortiqcha son kiritilgan!'
    };
  }

  if (hasDeficit) {
    const deficitStr = deficitTickets.map((t) => `Patta ${t.pattaNumber} (-${t.expectedQty - t.enteredQty})`).join(', ');
    return {
      status: 'deficit',
      label: `⚠️ Kamomat: ${deficitStr}`,
      isError: true,
      hasMismatch: true,
      message: 'Kamomat mavjud!'
    };
  }

  if (submittedCount === ticketsList.length) {
    return {
      status: 'complete',
      label: `✅ To'liq kiritilgan (${submittedCount}/${ticketsList.length})`,
      isError: false,
      hasMismatch: false,
      message: 'Hammasi joyida'
    };
  }

  if (submittedCount === 0) {
    return {
      status: 'waiting',
      label: `⏳ Kutilmoqda (0/${ticketsList.length})`,
      isError: false,
      hasMismatch: false,
      message: 'Hali kiritilmadi'
    };
  }

  return {
    status: 'in_progress',
    label: `⏳ Jarayonda (${submittedCount}/${ticketsList.length})`,
    isError: false,
    hasMismatch: false,
    message: `${submittedCount} ta kiritildi`
  };
}
