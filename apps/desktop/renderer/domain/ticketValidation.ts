import { ModelConfig, Worker, TicketFormState, PrintedPartyRecord, SubmittedTicketRecord } from '../types/workbook';

export interface TicketValidationResult {
  isValid: boolean;
  errorType?: 'warning' | 'error';
  title?: string;
  message?: string;
  actualPattaNum?: number;
  filledEntries?: Array<{
    opName: string;
    workerId: number;
    workerNameSnapshot?: string;
    rateSnapshot?: number;
  }>;
  partyOwner?: PrintedPartyRecord;
}

export interface TicketPartyStatus {
  partyOwner?: PrintedPartyRecord;
  isNonExistentParty: boolean;
  isWrongModelParty: boolean;
  minPattaForParty: number;
  maxPattaForParty: number;
  actualPattaNum: number;
  isExceededPattaNum: boolean;
  alreadySubmittedTicket?: SubmittedTicketRecord;
  hasBlockingError: boolean;
  errorBannerText: string;
}

export function isDuplicateTicketRecord(
  ticket: SubmittedTicketRecord,
  partyOwner: PrintedPartyRecord | null | undefined,
  modelId: string,
  partyStr: string,
  pattaNumbers: number[]
): boolean {
  const matchPatta = pattaNumbers.some(
    (pNum) => pNum !== undefined && pNum !== null && ticket.pattaNumber === pNum
  );
  if (!matchPatta) return false;

  if (partyOwner?.id && ticket.partyRecordId) {
    return ticket.partyRecordId === partyOwner.id;
  }
  const matchParty = String(ticket.partyNumber || '').trim() === partyStr.trim();
  const matchModel = ticket.modelId === modelId;
  if (partyOwner && !partyOwner.isClosed) {
    return !ticket.isClosed && matchModel && matchParty;
  }
  return matchModel && matchParty;
}

/**
 * Computes party status for UI banner display in PattaView
 */
export function getTicketPartyStatus(
  form: TicketFormState,
  model: ModelConfig,
  printedPartyHistory: PrintedPartyRecord[],
  submittedTickets: SubmittedTicketRecord[],
  options?: { requireTicketValidation?: boolean; strictParty?: boolean; strictPatta?: boolean }
): TicketPartyStatus {
  const strictParty = options?.strictParty ?? options?.requireTicketValidation !== false;
  const strictPatta = options?.strictPatta ?? options?.requireTicketValidation !== false;
  const currentPartyStr = String(form.party || '');
  const currentPattaNum = parseInt(form.patta || '0', 10) || 0;

  if (!strictParty && !strictPatta) {
    let alreadySubmittedTicket: SubmittedTicketRecord | undefined;
    if (currentPartyStr && currentPattaNum > 0) {
      alreadySubmittedTicket = (submittedTickets || []).find(
        (s) =>
          s.modelId === model.id &&
          String(s.partyNumber) === currentPartyStr &&
          s.pattaNumber === currentPattaNum
      );
    }
    const hasBlockingError = !!alreadySubmittedTicket;
    let errorBannerText = '';
    if (alreadySubmittedTicket) {
      errorBannerText = `Partiya ${currentPartyStr}, Patta ${currentPattaNum} allaqachon hisobga kiritilgan (${alreadySubmittedTicket.submittedAt} da)!`;
    }

    return {
      partyOwner: undefined,
      isNonExistentParty: false,
      isWrongModelParty: false,
      minPattaForParty: 1,
      maxPattaForParty: 999999,
      actualPattaNum: currentPattaNum || 1,
      isExceededPattaNum: false,
      alreadySubmittedTicket,
      hasBlockingError,
      errorBannerText
    };
  }

  const activeParties = (printedPartyHistory || []).filter((h) => !h.isClosed);
  const partyOwner = activeParties.find((h) => h.modelId === model.id && String(h.partyNumber) === currentPartyStr)
    || (printedPartyHistory || []).slice().reverse().find((h) => h.modelId === model.id && String(h.partyNumber) === currentPartyStr);

  const isNonExistentParty = strictParty && !partyOwner;
  const isWrongModelParty = strictParty && !!partyOwner && partyOwner.modelId !== model.id;

  const minPattaForParty = partyOwner
    ? (partyOwner.pattaStartNumber ?? (partyOwner.cumulativePattaCount > partyOwner.pattaCount
        ? partyOwner.cumulativePattaCount - partyOwner.pattaCount + 1
        : 1))
    : 1;
  const maxPattaForParty = partyOwner
    ? (partyOwner.pattaEndNumber ?? (partyOwner.cumulativePattaCount || partyOwner.pattaCount))
    : 1;

  let actualPattaNum = currentPattaNum;
  if (
    partyOwner &&
    currentPattaNum >= 1 &&
    currentPattaNum <= partyOwner.pattaCount &&
    minPattaForParty > 1 &&
    currentPattaNum < minPattaForParty
  ) {
    actualPattaNum = minPattaForParty + currentPattaNum - 1;
  }

  const isValidSequential = currentPattaNum >= minPattaForParty && currentPattaNum <= maxPattaForParty;
  const isValidRelative = currentPattaNum >= 1 && currentPattaNum <= (partyOwner?.pattaCount || 0);
  const isExceededPattaNum = strictPatta && !!partyOwner && partyOwner.modelId === model.id && !isValidSequential && !isValidRelative;

  const isArchivedInPreviousPeriod = !!(
    partyOwner &&
    partyOwner.archivedPattaNumbers &&
    (partyOwner.archivedPattaNumbers.includes(actualPattaNum) || partyOwner.archivedPattaNumbers.includes(currentPattaNum))
  );

  const alreadySubmittedTicket = (submittedTickets || []).find((s) =>
    isDuplicateTicketRecord(s, partyOwner, model.id, currentPartyStr, [actualPattaNum, currentPattaNum])
  );

  const hasBlockingError = isNonExistentParty || isWrongModelParty || isExceededPattaNum || isArchivedInPreviousPeriod || !!alreadySubmittedTicket;

  let errorBannerText = '';
  if (isNonExistentParty) {
    errorBannerText = `Partiya ${currentPartyStr} hali chop etilmagan! Avval «Patta» varag'ida chop eting.`;
  } else if (isWrongModelParty) {
    errorBannerText = `Partiya ${currentPartyStr} «${partyOwner?.modelName}» modeli uchun chiqarilgan!`;
  } else if (isExceededPattaNum) {
    errorBannerText = minPattaForParty > 1
      ? `Partiya ${currentPartyStr} da pattalar ${minPattaForParty} dan ${maxPattaForParty} gacha (${partyOwner?.pattaCount} ta)!`
      : `Partiya ${currentPartyStr} da jami ${partyOwner?.pattaCount} ta patta bor!`;
  } else if (isArchivedInPreviousPeriod) {
    errorBannerText = `Partiya ${currentPartyStr}, Patta ${currentPattaNum} oldingi yopilgan oyda topshirilgan!`;
  } else if (alreadySubmittedTicket) {
    errorBannerText = `Partiya ${currentPartyStr}, Patta ${currentPattaNum} allaqachon hisobga kiritilgan (${alreadySubmittedTicket.submittedAt} da)!`;
  }

  return {
    partyOwner,
    isNonExistentParty,
    isWrongModelParty,
    minPattaForParty,
    maxPattaForParty,
    actualPattaNum,
    isExceededPattaNum,
    alreadySubmittedTicket,
    hasBlockingError,
    errorBannerText
  };
}

/**
 * Validates a ticket prior to submission (Jonatish)
 */
export function validateTicketForSubmission(
  form: TicketFormState,
  model: ModelConfig,
  workers: Worker[],
  printedPartyHistory: PrintedPartyRecord[],
  submittedTickets: SubmittedTicketRecord[],
  options?: { requireTicketValidation?: boolean; strictParty?: boolean; strictPatta?: boolean }
): TicketValidationResult {
  const strictParty = options?.strictParty ?? options?.requireTicketValidation !== false;
  const strictPatta = options?.strictPatta ?? options?.requireTicketValidation !== false;
  const isStrict = strictParty || strictPatta;

  const qty = Number(form.qty);
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    return {
      isValid: false,
      errorType: 'warning',
      title: 'Ish sonini kiriting',
      message: 'J3 dagi ish sonini kiriting (musbat butun son).'
    };
  }

  const filledEntries: Array<{
    opName: string;
    workerId: number;
    workerNameSnapshot?: string;
    rateSnapshot?: number;
  }> = [];
  for (const [opName, wVal] of Object.entries(form.entries)) {
    if (wVal !== '' && wVal !== undefined && wVal !== null) {
      if (!model.operations.some((operation) => operation.name === opName)) {
        return {
          isValid: false,
          errorType: 'error',
          title: "Noto'g'ri operatsiya",
          message: `«${opName}» ushbu model operatsiyalari ro'yxatida yo'q.`
        };
      }
      let wId = Number(wVal);
      if (!Number.isSafeInteger(wId) || wId <= 0) {
        return {
          isValid: false,
          errorType: 'error',
          title: "Noto'g'ri ishchi kodi",
          message: `Ishchi kodi noto'g'ri: "${wVal}"`
        };
      }
      const matchedWorker = workers.find((w) => w.id === wId);
      if (!matchedWorker) {
        return {
          isValid: false,
          errorType: 'error',
          title: 'Ishchi topilmadi',
          message: `Ishchi topilmadi (hisob varaqda)! Kodi: ${wId}`
        };
      }
      const matchedOp = model.operations.find((operation) => operation.name === opName);
      filledEntries.push({
        opName,
        workerId: wId,
        workerNameSnapshot: matchedWorker.name,
        rateSnapshot: matchedOp?.rate !== undefined ? matchedOp.rate : 0
      });
    }
  }

  if (filledEntries.length === 0) {
    return {
      isValid: false,
      errorType: 'warning',
      title: 'Ishchilar kiritilmadi',
      message: "Hech bo'lmaganda bitta operatsiyaga ishchi raqamini kiriting."
    };
  }

  const currentPartyStr = String(form.party || '').trim();
  const pattaText = String(form.patta || '').trim();
  const currentPattaNum = /^\d+$/.test(pattaText) ? Number(pattaText) : 0;

  if (!isStrict) {
    let actualPattaNum = currentPattaNum;
    if (!Number.isSafeInteger(actualPattaNum) || actualPattaNum <= 0) {
      if (!strictPatta) {
        return { isValid: true, actualPattaNum: 0, filledEntries, partyOwner: undefined };
      }
      // Auto-assign next patta number if left blank or 0 in free mode
      const partyKey = currentPartyStr || '1';
      const existingForParty = (submittedTickets || []).filter(
        (s) => s.modelId === model.id && String(s.partyNumber || '1') === partyKey
      );
      const maxExisting = existingForParty.length > 0
        ? Math.max(...existingForParty.map((s) => s.pattaNumber || 0))
        : 0;
      actualPattaNum = maxExisting + 1;
    } else {
      // User explicitly typed a patta number: check if already submitted
      let alreadySubmitted: SubmittedTicketRecord | undefined;
      if (currentPartyStr && actualPattaNum > 0) {
        alreadySubmitted = (submittedTickets || []).find(
          (s) =>
            s.modelId === model.id &&
            String(s.partyNumber) === currentPartyStr &&
            s.pattaNumber === actualPattaNum
        );
      }
      if (alreadySubmitted) {
        return {
          isValid: false,
          errorType: 'error',
          title: 'Bu patta allaqachon kiritilgan!',
          message: `Partiya ${currentPartyStr}, Patta ${actualPattaNum} allaqachon hisobga o'tkazilgan (${alreadySubmitted.submittedAt || ''} da, ${alreadySubmitted.qty} dona).`
        };
      }
    }

    return {
      isValid: true,
      actualPattaNum,
      filledEntries,
      partyOwner: undefined
    };
  }

  // --- Qat'iy rejim (Strict Mode) checks below ---
  if (strictPatta && (!Number.isSafeInteger(currentPattaNum) || currentPattaNum <= 0)) {
    return {
      isValid: false,
      errorType: 'error',
      title: 'Patta raqami xato!',
      message: 'Patta raqamini musbat butun son sifatida kiriting.'
    };
  }

  const activeParties = (printedPartyHistory || []).filter((h) => !h.isClosed);
  const partyOwner = activeParties.find((h) => h.modelId === model.id && String(h.partyNumber).trim() === currentPartyStr)
    || (printedPartyHistory || []).slice().reverse().find((h) => h.modelId === model.id && String(h.partyNumber).trim() === currentPartyStr);

  if (strictParty && !partyOwner) {
    return {
      isValid: false,
      errorType: 'error',
      title: 'Partiya topilmadi!',
      message: `Partiya ${currentPartyStr} mavjud emas (hali chop etilmagan)! Avval «Pattalar (Pechat)» varag'ida ushbu partiyani shakllantirib chop eting.`
    };
  }

  if (strictParty && partyOwner && partyOwner.modelId !== model.id) {
    return {
      isValid: false,
      errorType: 'error',
      title: 'Model xato!',
      message: `Partiya ${currentPartyStr} «${partyOwner.modelName}» modeli uchun chiqarilgan! Ushbu partiyani «${model.name}» varag'iga kiritib bo'lmaydi. Iltimos, «${partyOwner.modelName}» varag'iga o'tib kiriting.`
    };
  }

  const minPattaForParty = partyOwner?.pattaStartNumber
    ?? (partyOwner ? partyOwner.cumulativePattaCount - partyOwner.pattaCount + 1 : 1);
  const maxPattaForParty = partyOwner?.pattaEndNumber ?? partyOwner?.cumulativePattaCount ?? Number.MAX_SAFE_INTEGER;

  let actualPattaNum = currentPattaNum;
  if (
    currentPattaNum >= 1 &&
    currentPattaNum <= (partyOwner?.pattaCount || 0) &&
    minPattaForParty > 1 &&
    currentPattaNum < minPattaForParty
  ) {
    actualPattaNum = minPattaForParty + currentPattaNum - 1;
  }

  if (strictPatta && (actualPattaNum < minPattaForParty || actualPattaNum > maxPattaForParty)) {
    return {
      isValid: false,
      errorType: 'error',
      title: 'Patta raqami xato!',
      message: `Partiya ${currentPartyStr} da faqat ${minPattaForParty} dan ${maxPattaForParty} gacha patta chiqarilgan! Patta ${currentPattaNum} mavjud emas.`
    };
  }

  const alreadySubmitted = (submittedTickets || []).find((s) =>
    isDuplicateTicketRecord(s, partyOwner, model.id, currentPartyStr, [actualPattaNum])
  );

  if (alreadySubmitted) {
    return {
      isValid: false,
      errorType: 'error',
      title: 'Bu patta allaqachon kiritilgan!',
      message: `Partiya ${currentPartyStr}, Patta ${actualPattaNum} allaqachon hisobga o'tkazilgan (${alreadySubmitted.submittedAt || ''} da, ${alreadySubmitted.qty} dona). Bitta patta ikki marta kiritilishi mumkin emas!`
    };
  }

  return {
    isValid: true,
    actualPattaNum,
    filledEntries,
    partyOwner
  };
}
