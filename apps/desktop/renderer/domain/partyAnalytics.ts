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

  const ticketByPattaNumber = new Map<number, SubmittedTicketRecord>();
  for (const t of relevantTickets) {
    if (t.pattaNumber !== undefined && t.pattaNumber !== null && !ticketByPattaNumber.has(t.pattaNumber)) {
      ticketByPattaNumber.set(t.pattaNumber, t);
    }
  }

  let currentPattaIndex = 1;
  const sizesObj = partyRecord.sizes || {};
  const ishSoniPerPatta = partyRecord.ishSoniPerPatta || partyRecord.ishSoni || 1;
  const archivedSet = new Set(partyRecord.archivedPattaNumbers || []);

  const startPatta = (partyRecord.cumulativePattaCount > partyRecord.pattaCount)
    ? (partyRecord.cumulativePattaCount - partyRecord.pattaCount + 1)
    : 1;

  // Combine activeSizes with any keys in sizesObj to ensure all printed sizes are evaluated
  const allSizes = Array.from(new Set([...activeSizes, ...Object.keys(sizesObj)]));

  for (const sz of allSizes) {
    const countForSize = parseInt(sizesObj[sz] || '0', 10);
    if (!countForSize || countForSize <= 0) continue;

    for (let i = 0; i < countForSize; i++) {
      const relNum = currentPattaIndex++;
      const actualSeqNum = startPatta + relNum - 1;

      // If this patta was already archived in previous periods, skip it in active month
      if (!includeArchived && (archivedSet.has(relNum) || archivedSet.has(actualSeqNum))) {
        continue;
      }

      // O(1) Map lookup for both relative number (1, 2, 3...) and sequential printed number (5, 6, 7...)
      const sub = ticketByPattaNumber.get(actualSeqNum) || ticketByPattaNumber.get(relNum);
      const isSubmitted = !!sub;

      // In closed/archived months, if onlySubmitted is requested, skip unentered tickets!
      if (onlySubmitted && !isSubmitted) {
        continue;
      }

      const enteredQty = sub ? sub.qty : 0;
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
