import { WorkbookStore } from './types';
import { ModelPattaBatchConfig, PrintedPartyRecord } from '../types/workbook';

type BatchState = Pick<WorkbookStore,
  'models' | 'workers' | 'nextPartyNumber' | 'nextPattaNumber' | 'pattaBatchConfigs' | 'printedPartyHistory' |
  'submittedTickets' | 'availableSizes' | 'deletedPartyIds' | 'reusablePattaRanges'>;

type PrintedItem = {
  modelId: string;
  partyNumber: string;
  pattaCount: number;
  ishSoniPerPatta?: number;
  totalIshSoni?: number;
  ishSoni: number;
  sizes?: Record<string, string>;
  color: string;
};

export function createRecordId() {
  const randomUUID = (globalThis.crypto as Crypto & { randomUUID?: () => string } | undefined)?.randomUUID;
  if (typeof randomUUID !== 'function') throw new Error('_COMMAND_REQUIRED: UUID generation is unavailable');
  return randomUUID.call(globalThis.crypto);
}

function computeCumulative(history: PrintedPartyRecord[]) {
  let cumulativePattas = 0;
  let cumulativeIsh = 0;
  for (const party of history) {
    cumulativePattas = Math.max(cumulativePattas, Number(party.pattaEndNumber || party.cumulativePattaCount || 0));
    cumulativeIsh = Math.max(cumulativeIsh, Number(party.cumulativeIshSoni || 0));
  }
  return history.map((party) => {
    const hasExplicitRange = Number.isSafeInteger(party.pattaStartNumber) && Number.isSafeInteger(party.pattaEndNumber);
    const hasPattaEnd = Number(party.pattaEndNumber || party.cumulativePattaCount || 0) > 0;
    if (hasExplicitRange) cumulativePattas = Math.max(cumulativePattas, Number(party.pattaEndNumber));
    else if (hasPattaEnd) cumulativePattas = Math.max(cumulativePattas, Number(party.cumulativePattaCount));
    else cumulativePattas += Number(party.pattaCount || 0);
    if (party.cumulativeIshSoni && party.cumulativeIshSoni > 0) {
      cumulativeIsh = Math.max(cumulativeIsh, party.cumulativeIshSoni);
      if (hasExplicitRange) return party;
      return { ...party, cumulativePattaCount: hasPattaEnd ? Number(party.cumulativePattaCount) : cumulativePattas };
    }
    cumulativeIsh += Number(party.totalIshSoni || party.ishSoni || 0);
    return {
      ...party,
      cumulativePattaCount: hasExplicitRange ? party.cumulativePattaCount
        : hasPattaEnd ? Number(party.cumulativePattaCount) : cumulativePattas,
      cumulativeIshSoni: cumulativeIsh
    };
  });
}

export function findAvailablePattaStart(
  history: PrintedPartyRecord[],
  pattaCount: number,
  nextPattaNumber: number,
  reusablePattaRanges: Array<{ start: number; end: number }> = []
): number {
  const highWater = Math.max(1, Number(nextPattaNumber) || 1);
  const count = Number(pattaCount);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('INVALID_PATTA_COUNT');
  const historyRanges = history.flatMap((party) => {
    const start = Number(party.pattaStartNumber);
    const end = Number(party.pattaEndNumber);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return [];
    return [{ start, end, archived: party.isArchived === true, closed: party.isClosed === true }];
  });
  const ranges = historyRanges.concat(reusablePattaRanges.map((range) => ({
    start: Number(range.start), end: Number(range.end), archived: true, closed: true
  })).filter((range) => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    && range.start > 0 && range.end >= range.start));
  const occupied = ranges.filter((range) => !range.archived && !range.closed).sort((a, b) => a.start - b.start);
  const released = ranges.filter((range) => range.archived && range.start < highWater)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (const range of released) {
    let candidate = range.start;
    const releasedEnd = Math.min(range.end, highWater - 1);
    while (candidate + count - 1 <= releasedEnd) {
      const conflict = occupied.find((item) => item.start <= candidate + count - 1 && item.end >= candidate);
      if (!conflict) return candidate;
      candidate = conflict.end + 1;
    }
  }

  let candidate = highWater;
  while (candidate + count - 1 <= Number.MAX_SAFE_INTEGER) {
    const conflict = occupied.find((item) => item.start <= candidate + count - 1 && item.end >= candidate);
    if (!conflict) return candidate;
    candidate = conflict.end + 1;
  }
  throw new Error('INVALID_PATTA_COUNT');
}

export function findNextPartyNumber(history: PrintedPartyRecord[]): number {
  const activeNumbers = new Set(history.filter((party) => !party.isClosed && party.isArchived !== true)
    .map((party) => Number.parseInt(String(party.partyNumber).trim(), 10))
    .filter((number) => Number.isSafeInteger(number) && number > 0));
  let next = 1;
  while (activeNumbers.has(next)) next += 1;
  return next;
}

export function removePattaSizeFromBatchConfigs(
  configs: Record<string, ModelPattaBatchConfig>,
  sizeName: string
): Record<string, ModelPattaBatchConfig> {
  const normalized = String(sizeName || '').trim().toUpperCase();
  return Object.fromEntries(Object.entries(configs || {}).map(([modelId, config]) => [
    modelId,
    {
      ...config,
      sizes: Object.fromEntries(Object.entries(config.sizes || {})
        .filter(([size]) => size.trim().toUpperCase() !== normalized))
    }
  ]));
}

export function buildPattaPreviewStarts(
  history: PrintedPartyRecord[],
  requests: Array<{ modelId: string; partyNumber: string; pattaCount: number }>,
  nextPattaNumber: number,
  reusablePattaRanges: Array<{ start: number; end: number }> = []
): number[] {
  const working = [...history];
  let highWater = Math.max(1, Number(nextPattaNumber) || 1);
  return requests.map((request, index) => {
    const existing = working.find((party) => !party.isClosed && party.isArchived !== true
      && party.modelId === request.modelId && String(party.partyNumber).trim() === String(request.partyNumber).trim());
    const count = Math.max(1, Number(request.pattaCount) || 1);
    const start = existing?.pattaStartNumber
      ?? findAvailablePattaStart(working, count, highWater, reusablePattaRanges);
    if (!existing && request.pattaCount > 0) {
      const end = start + request.pattaCount - 1;
      working.push({
        id: `preview-${index}`,
        partyNumber: String(request.partyNumber),
        modelId: request.modelId,
        modelName: '',
        color: '',
        pattaCount: request.pattaCount,
        cumulativePattaCount: end,
        pattaStartNumber: start,
        pattaEndNumber: end,
        ishSoni: 0,
        cumulativeIshSoni: 0,
        printedAt: ''
      });
      if (start >= highWater) highWater = end + 1;
    }
    return start;
  });
}

export function buildBatchSettingsPayload(
  state: BatchState,
  pattaBatchConfigs: Record<string, ModelPattaBatchConfig> = state.pattaBatchConfigs,
  availableSizes: string[] = state.availableSizes || []
) {
  return {
    availableSizes,
    configs: Object.entries(pattaBatchConfigs || {}).map(([modelId, config]) => ({
      modelId,
      partyNumber: config.partyNumber || '',
      isCustomParty: Boolean(config.isCustomParty),
      totalIshSoni: config.totalIshSoni || '',
      color: config.color || '',
      sizes: { ...(config.sizes || {}) }
    }))
  };
}

export function buildBatchPrintMutation(state: BatchState, printedItems: PrintedItem[], now = new Date()): {
  batchId: string;
  parties: PrintedPartyRecord[];
  settings: ReturnType<typeof buildBatchSettingsPayload>;
  nextPartyNumber: number;
  nextPattaNumber: number;
  deletedPartyIds: string[];
} {
  if (!Array.isArray(printedItems) || printedItems.length === 0 || printedItems.length > 128) {
    throw new Error('INVALID_BATCH_PARTIES: at least one and at most 128 parties are required');
  }
  const history = [...(state.printedPartyHistory || [])];
  const printedModelIds = new Set(printedItems.map((item) => item.modelId));
  let nextSequential = findNextPartyNumber(history);
  const working = [...history];
  const changedPartyIds = new Set<string>();
  let nextGlobalPatta = Math.max(1, Number(state.nextPattaNumber) || 1);
  for (const item of printedItems) {
    let partyNumber = String(item.partyNumber).trim();
    const conflictingModel = working.find((party) => !party.isClosed && party.modelId !== item.modelId && String(party.partyNumber).trim() === partyNumber);
    if (conflictingModel) {
      while (working.some((party) => !party.isClosed && String(party.partyNumber).trim() === String(nextSequential))) nextSequential += 1;
      partyNumber = String(nextSequential++);
    }
    const model = state.models.find((candidate) => candidate.id === item.modelId);
    if (!model) throw new Error(`MODEL_NOT_FOUND: ${item.modelId}`);
    const existingIndex = working.findIndex((party) => !party.isClosed && party.modelId === item.modelId && String(party.partyNumber).trim() === partyNumber);
    const existing = existingIndex >= 0 ? working[existingIndex] : undefined;
    const pattaCount = Number(item.pattaCount || 0);
    const pattaStartNumber = existing?.pattaStartNumber
      ?? findAvailablePattaStart(working, pattaCount, nextGlobalPatta, state.reusablePattaRanges);
    const pattaEndNumber = existing?.pattaEndNumber ?? (pattaStartNumber + pattaCount - 1);
    if (!existing && pattaStartNumber >= nextGlobalPatta) nextGlobalPatta = pattaEndNumber + 1;
    const totalIshSoni = Number(item.totalIshSoni ?? item.ishSoni ?? 0);
    const party: PrintedPartyRecord = {
      id: existingIndex >= 0 ? working[existingIndex].id : createRecordId(),
      partyNumber,
      modelId: item.modelId,
      modelName: model.title || model.name || item.modelId,
      color: item.color,
      pattaCount: Number(item.pattaCount || 0),
      cumulativePattaCount: Math.max(0, pattaEndNumber),
      pattaStartNumber: pattaCount ? pattaStartNumber : undefined,
      pattaEndNumber: pattaCount ? pattaEndNumber : undefined,
      ishSoniPerPatta: Number(item.ishSoniPerPatta || 0),
      totalIshSoni,
      ishSoni: totalIshSoni,
      cumulativeIshSoni: existingIndex >= 0 ? Number(working[existingIndex].cumulativeIshSoni || 0) : 0,
      sizes: item.sizes ? { ...item.sizes } : undefined,
      printedAt: now.toISOString(),
      serverRevision: existingIndex >= 0 ? Number(working[existingIndex].serverRevision || 0) : 0
    };
    changedPartyIds.add(party.id);
    if (existingIndex >= 0) working[existingIndex] = party;
    else working.push(party);
  }

  const updatedHistory = computeCumulative(working);
  const configs: Record<string, ModelPattaBatchConfig> = {};
  for (const model of state.models) {
    const current = state.pattaBatchConfigs[model.id];
    const printed = printedModelIds.has(model.id);
    const sizes: Record<string, string> = {};
    for (const size of state.availableSizes || []) sizes[size] = printed ? '' : current?.sizes?.[size] || '';
    configs[model.id] = {
      partyNumber: printed ? '' : (current?.isCustomParty ? current.partyNumber : ''),
      isCustomParty: printed ? false : Boolean(current?.isCustomParty),
      totalIshSoni: printed ? '' : current?.totalIshSoni || '',
      color: current?.color || model.color || 'Кора',
      sizes
    };
  }
  const nextPartyNumber = findNextPartyNumber(updatedHistory);
  const printedKeys = new Set(printedItems.map((item) => `${item.modelId}#${item.partyNumber}`));
  const deletedPartyIds = (state.deletedPartyIds || []).filter((id) => !printedKeys.has(id));
  return {
    batchId: `batch_${createRecordId()}`,
    parties: updatedHistory.filter((party) => changedPartyIds.has(party.id)),
    settings: buildBatchSettingsPayload(state, configs),
    nextPartyNumber,
    nextPattaNumber: nextGlobalPatta,
    deletedPartyIds
  };
}

export function buildPartySummary(state: BatchState, item: {
  partyNumber: string; modelId: string; modelName: string; color: string; pattaCount: number; ishSoni: number;
}): PrintedPartyRecord {
  const now = new Date().toISOString();
  const existing = (state.printedPartyHistory || []).find((party) =>
    !party.isClosed && party.modelId === item.modelId && String(party.partyNumber).trim() === String(item.partyNumber).trim()
  );
  const record: PrintedPartyRecord = {
    id: existing?.id || createRecordId(),
    partyNumber: item.partyNumber,
    modelId: item.modelId,
    modelName: item.modelName,
    color: item.color,
    pattaCount: item.pattaCount || 0,
    cumulativePattaCount: Number(existing?.cumulativePattaCount || 0),
    ishSoni: item.ishSoni || 0,
    cumulativeIshSoni: Number(existing?.cumulativeIshSoni || 0),
    printedAt: now,
    serverRevision: Number(existing?.serverRevision || 0)
  };
  const history = [...(state.printedPartyHistory || [])];
  const index = history.findIndex((party) => party.id === record.id);
  if (index >= 0) history[index] = record;
  else history.push(record);
  return computeCumulative(history).find((party) => party.id === record.id) || record;
}
