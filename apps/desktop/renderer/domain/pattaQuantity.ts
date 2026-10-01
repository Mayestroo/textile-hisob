export interface PartyWorkQuantities {
  partyTotal: number;
  pattaCount: number;
  perPatta: number;
}

export interface PartyWorkSummary {
  ishSoniPerPatta: number;
  totalIshSoni: number;
  ishSoni: number;
}

export interface NormalizedPattaSizeCounts {
  sizes: Record<string, number>;
  pattaCount: number;
}

export interface PattaWorkTicket {
  size: string;
  perPatta: number;
}

export function normalizePattaSizeCounts(
  sizes: Record<string, string | number> | undefined
): NormalizedPattaSizeCounts {
  let pattaCount = 0;
  const normalizedEntries = Object.entries(sizes || {}).map(([size, rawCount]) => {
    let count: number;
    if (typeof rawCount === 'number') {
      count = rawCount;
    } else if (typeof rawCount === 'string') {
      const trimmedCount = rawCount.trim();
      if (trimmedCount === '') {
        count = 0;
      } else if (/^\d+$/.test(trimmedCount)) {
        count = Number(trimmedCount);
      } else {
        throw new Error(`INVALID_PATTA_SIZE_COUNT:${size}`);
      }
    } else {
      throw new Error(`INVALID_PATTA_SIZE_COUNT:${size}`);
    }

    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`INVALID_PATTA_SIZE_COUNT:${size}`);
    }

    pattaCount += count;
    if (!Number.isSafeInteger(pattaCount)) {
      throw new Error('INVALID_PATTA_SIZE_TOTAL');
    }

    return [size, count] as const;
  });

  return { sizes: Object.fromEntries(normalizedEntries), pattaCount };
}

export function calculatePartyWorkQuantities(
  partyTotal: number,
  pattaCount: number
): PartyWorkQuantities {
  if (!Number.isSafeInteger(partyTotal) || partyTotal <= 0) {
    throw new Error('INVALID_PARTY_TOTAL');
  }
  if (!Number.isSafeInteger(pattaCount) || pattaCount <= 0) {
    throw new Error('INVALID_PATTA_COUNT');
  }
  if (partyTotal % pattaCount !== 0) {
    throw new Error('PARTY_TOTAL_NOT_DIVISIBLE');
  }
  return { partyTotal, pattaCount, perPatta: partyTotal / pattaCount };
}

export function buildPattaWorkTickets(
  partyTotal: number,
  sizes: Record<string, string | number> | undefined
): PattaWorkTicket[] {
  const normalizedSizes = normalizePattaSizeCounts(sizes);
  const quantities = calculatePartyWorkQuantities(partyTotal, normalizedSizes.pattaCount);
  const tickets: PattaWorkTicket[] = [];

  for (const [size, count] of Object.entries(normalizedSizes.sizes)) {
    for (let index = 0; index < count; index += 1) {
      tickets.push({ size, perPatta: quantities.perPatta });
    }
  }

  return tickets;
}

export function buildPartyWorkSummary(partyTotal: number, pattaCount: number): PartyWorkSummary {
  const quantities = calculatePartyWorkQuantities(partyTotal, pattaCount);
  return {
    ishSoniPerPatta: quantities.perPatta,
    totalIshSoni: quantities.partyTotal,
    ishSoni: quantities.partyTotal
  };
}
