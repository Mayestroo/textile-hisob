import { WorkbookStore } from './types';
import { ModelPattaBatchConfig, PrintedPartyRecord } from '../types/workbook';

type BatchState = Pick<WorkbookStore,
  'models' | 'workers' | 'nextPartyNumber' | 'pattaBatchConfigs' | 'printedPartyHistory' |
  'submittedTickets' | 'availableSizes' | 'deletedPartyIds'>;

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

function createRecordId() {
  const randomUUID = (globalThis.crypto as Crypto & { randomUUID?: () => string } | undefined)?.randomUUID;
  if (typeof randomUUID === 'function') return `rec_${randomUUID.call(globalThis.crypto).replace(/-/g, '')}`;
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function computeCumulative(history: PrintedPartyRecord[]) {
  let cumulativePattas = 0;
  let cumulativeIsh = 0;
  for (const party of history) {
    cumulativePattas = Math.max(cumulativePattas, Number(party.cumulativePattaCount || 0));
    cumulativeIsh = Math.max(cumulativeIsh, Number(party.cumulativeIshSoni || 0));
  }
  return history.map((party) => {
    if (party.cumulativePattaCount && party.cumulativePattaCount > 0) return party;
    cumulativePattas += Number(party.pattaCount || 0);
    cumulativeIsh += Number(party.totalIshSoni || party.ishSoni || 0);
    return { ...party, cumulativePattaCount: cumulativePattas, cumulativeIshSoni: cumulativeIsh };
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
  deletedPartyIds: string[];
} {
  if (!Array.isArray(printedItems) || printedItems.length === 0 || printedItems.length > 128) {
    throw new Error('INVALID_BATCH_PARTIES: at least one and at most 128 parties are required');
  }
  const history = [...(state.printedPartyHistory || [])];
  const printedModelIds = new Set(printedItems.map((item) => item.modelId));
  let highestActiveParty = 0;
  for (const party of history) {
    if (!party.isClosed) {
      const number = Number.parseInt(String(party.partyNumber), 10);
      if (Number.isFinite(number) && number > highestActiveParty) highestActiveParty = number;
    }
  }
  let nextSequential = Math.max(state.nextPartyNumber || 1, highestActiveParty + 1);
  const working = [...history];
  const changedPartyIds = new Set<string>();
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
    const totalIshSoni = Number(item.totalIshSoni ?? item.ishSoni ?? 0);
    const party: PrintedPartyRecord = {
      id: existingIndex >= 0 ? working[existingIndex].id : createRecordId(),
      partyNumber,
      modelId: item.modelId,
      modelName: model.title || model.name || item.modelId,
      color: item.color,
      pattaCount: Number(item.pattaCount || 0),
      cumulativePattaCount: existingIndex >= 0 ? Number(working[existingIndex].cumulativePattaCount || 0) : 0,
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
  const activeNumbers = new Set(updatedHistory.filter((party) => !party.isClosed)
    .map((party) => Number.parseInt(String(party.partyNumber), 10)).filter((number) => Number.isSafeInteger(number)));
  let nextPartyNumber = 1;
  while (activeNumbers.has(nextPartyNumber)) nextPartyNumber += 1;
  const printedKeys = new Set(printedItems.map((item) => `${item.modelId}#${item.partyNumber}`));
  const deletedPartyIds = (state.deletedPartyIds || []).filter((id) => !printedKeys.has(id));
  return {
    batchId: createRecordId().replace(/^rec_/, 'batch_'),
    parties: updatedHistory.filter((party) => changedPartyIds.has(party.id)),
    settings: buildBatchSettingsPayload(state, configs),
    nextPartyNumber,
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
