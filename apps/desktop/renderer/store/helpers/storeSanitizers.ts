import { Worker, ModelConfig, TicketFormState, ModelPattaBatchConfig, SubmittedTicketRecord } from '../../types/workbook';
import { DEFAULT_BATCH_SIZES } from '../../constants/batchConstants';
import { formatDateIso } from '../../utils/formatters';

export function createInitialPattaBatchConfigs(
  models: ModelConfig[],
  sizesList: readonly string[] = DEFAULT_BATCH_SIZES
): Record<string, ModelPattaBatchConfig> {
  const configs: Record<string, ModelPattaBatchConfig> = {};
  for (const m of models) {
    const sizesObj: Record<string, string> = {};
    for (const s of sizesList) {
      sizesObj[s] = '';
    }
    configs[m.id] = {
      partyNumber: '',
      isCustomParty: false,
      totalIshSoni: '',
      color: m.color || 'Кора',
      sizes: sizesObj
    };
  }
  return configs;
}

export function createInitialTicketForms(models: ModelConfig[]): Record<string, TicketFormState> {
  const forms: Record<string, TicketFormState> = {};
  const today = formatDateIso();
  for (const m of models) {
    let cleanParty = m.party || '';
    if (cleanParty.includes('6632') || cleanParty.includes('Мато Партия')) {
      cleanParty = '';
    }
    forms[m.id] = {
      date: today,
      party: cleanParty,
      color: m.color || 'Кора',
      size: m.size || 'XL',
      qty: '',
      patta: '',
      entries: {}
    };
  }
  return forms;
}

export function cleanWorkerName(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/[\ufffd\uFFFD?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeWorkerName(raw: string): string {
  if (!raw) return '';
  return cleanWorkerName(raw)
    .toLowerCase()
    .replace(/xon$|хон$|opa$|опа$|aka$|ака$|bonu$|бону$|oy$|ой$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const CANONICAL_WORKER_ALIASES: Record<string, number> = {};

export const LEGACY_WORKER_ID_MAP: Record<number, number> = {};

export function sanitizeWorkers(wList: any[]): Worker[] {
  if (!Array.isArray(wList)) return [];

  const workerMap = new Map<number, Worker>();
  const validList = [...wList].filter((w) => w && typeof w.id === 'number' && w.id > 0);

  for (const w of validList) {
    const cleanName = cleanWorkerName(w.name || '');
    const current: Worker = {
      ...w,
      id: w.id,
      name: cleanName || w.name,
      avans: Math.max(0, Number(w.avans) || 0),
      jarima: Math.max(0, Number(w.jarima) || 0),
      staj: Math.max(0, Number(w.staj) || 0)
    };

    const existing = workerMap.get(w.id);
    if (!existing) {
      workerMap.set(w.id, current);
    } else {
      const existingTime = existing.updatedAt || 0;
      const currentTime = current.updatedAt || 0;
      if (currentTime > existingTime) {
        workerMap.set(w.id, {
          ...existing,
          ...current,
          name: current.name || existing.name
        });
      } else if (currentTime < existingTime) {
        if (!existing.name && current.name) {
          workerMap.set(w.id, { ...existing, name: current.name });
        }
      } else {
        workerMap.set(w.id, {
          ...existing,
          ...current,
          name: current.name || existing.name
        });
      }
    }
  }

  return Array.from(workerMap.values()).sort((a, b) => a.id - b.id);
}


export function sanitizeModels(mList: any[]): ModelConfig[] {
  if (!Array.isArray(mList)) return [];
  return mList.filter((m: any) => m && typeof m === 'object').map((m: any) => {
    let cleanName = (m.name || m.id || '').trim();
    let cleanId = (m.id || cleanName).trim();

    // If model was renamed (e.g. Aleksandr-oversize -> Aleksandr-Приталинний), sync ID with current name
    if (cleanId === 'Aleksandr-oversize' && cleanName.includes('Приталин')) {
      cleanId = cleanName;
    }

    // Always keep title in sync with the current clean model name
    const cleanPrefix = cleanName.replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim();
    const fixedTitle = `Модел- ${cleanPrefix}`;
    const hisobSheet = m.hisobSheetName || `${cleanName}-hisob`;

    let cleanParty = m.party || '';
    if (cleanParty.includes('6632') || cleanParty.includes('Мато Партия')) {
      cleanParty = '';
    }

    // Preserve operation identity during hydration. Historical tickets and reports may
    // still reference an older operation id or a duplicate legacy name.
    const uniqueOps: any[] = [];
    const seenOps = new Set<string>();
    for (const [index, o] of (Array.isArray(m.operations) ? m.operations : []).entries()) {
      if (!o || typeof o !== 'object') continue;
      const name = (o.name || '').trim();
      if (name) {
        seenOps.add(name.toLowerCase());
        uniqueOps.push({ ...o, name, col: Number.isFinite(o.col) ? o.col : 3 + index * 2, id: o.id || `op_${o.col || 3 + index * 2}` });
      }
    }

    // 2. Deduplicate pattaOpsOrder (keep unique names in sync with uniqueOps)
    const seenPatta = new Set<string>();
    const uniquePattaOps: string[] = [];
    for (const p of (m.pattaOpsOrder || [])) {
      const pClean = (p || '').trim();
      if (pClean && seenOps.has(pClean.toLowerCase()) && !seenPatta.has(pClean.toLowerCase())) {
        seenPatta.add(pClean.toLowerCase());
        uniquePattaOps.push(pClean);
      }
    }
    for (const o of uniqueOps) {
      if (!seenPatta.has(o.name.toLowerCase())) {
        seenPatta.add(o.name.toLowerCase());
        uniquePattaOps.push(o.name);
      }
    }

    return {
      ...m,
      id: cleanId,
      name: cleanName,
      hisobSheetName: hisobSheet,
      title: fixedTitle,
      party: cleanParty,
      operations: uniqueOps,
      pattaOpsOrder: uniquePattaOps,
      hisobQuantities: m.hisobQuantities && typeof m.hisobQuantities === 'object' ? m.hisobQuantities : {}
    };
  });
}

export function sanitizeForms(forms: any, modelsList: ModelConfig[]): Record<string, TicketFormState> {
  const initial = createInitialTicketForms(modelsList);
  if (!forms) return initial;
  const cleanForms: Record<string, TicketFormState> = {};
  for (const m of modelsList) {
    const f = forms[m.id] || initial[m.id] || {
      date: formatDateIso(),
      party: '',
      color: m.color || 'Кора',
      size: m.size || 'XL',
      qty: '',
      patta: '',
      entries: {}
    };
    let cleanParty = f.party || '';
    if (cleanParty.includes('6632') || cleanParty.includes('Мато Партия')) {
      cleanParty = '';
    }
    cleanForms[m.id] = {
      date: f.date || formatDateIso(),
      party: cleanParty,
      color: f.color || m.color || 'Кора',
      size: f.size || m.size || 'XL',
      qty: f.qty !== undefined ? String(f.qty) : '',
      patta: f.patta !== undefined ? String(f.patta) : '',
      entries: (f.entries && typeof f.entries === 'object') ? { ...f.entries } : {}
    };
  }
  return cleanForms;
}

export function sanitizePattaBatchConfigs(
  configs: any,
  modelsList: ModelConfig[],
  sizesListOrParty?: any,
  maybeSizesList?: readonly string[]
): Record<string, ModelPattaBatchConfig> {
  const sizesList: readonly string[] = Array.isArray(sizesListOrParty)
    ? sizesListOrParty
    : Array.isArray(maybeSizesList)
    ? maybeSizesList
    : DEFAULT_BATCH_SIZES;
  const initial = createInitialPattaBatchConfigs(modelsList, sizesList);
  if (!configs) return initial;

  const cleanConfigs: Record<string, ModelPattaBatchConfig> = {};
  for (const m of modelsList) {
    const c = configs[m.id];
    const sizesObj: Record<string, string> = {};
    for (const s of sizesList) {
      sizesObj[s] = (c && c.sizes && c.sizes[s] !== undefined) ? String(c.sizes[s]) : '';
    }
    if (c && c.sizes) {
      for (const [szKey, szVal] of Object.entries(c.sizes)) {
        if (sizesObj[szKey] === undefined) {
          sizesObj[szKey] = String(szVal || '');
        }
      }
    }

    const isCustom = Boolean(c && c.isCustomParty && c.partyNumber && String(c.partyNumber).trim() !== '');
    const pNum = isCustom ? String(c.partyNumber).trim() : '';

    cleanConfigs[m.id] = {
      partyNumber: pNum,
      isCustomParty: isCustom,
      totalIshSoni: (c && c.totalIshSoni !== undefined) ? String(c.totalIshSoni) : '',
      color: (c && c.color) || m.color || 'Кора',
      sizes: sizesObj
    };
  }
  return cleanConfigs;
}

export function sanitizePrintedPartyHistory(history: any[]): any[] {
  if (!Array.isArray(history) || history.length === 0) return [];

  // 1. Deduplication and normalization by unique record ID
  const idMap = new Map<string, any>();
  for (const r of history) {
    if (!r) continue;
    const cleanId = String(r.id || '').trim();
    if (!cleanId) continue;

    const existing = idMap.get(cleanId);
    if (!existing) {
      idMap.set(cleanId, { ...r, id: cleanId });
    } else {
      const merged = {
        ...existing,
        ...r,
        id: cleanId,
        isClosed: Boolean(existing.isClosed || r.isClosed),
        closedAt: r.closedAt || existing.closedAt,
        cumulativePattaCount: existing.cumulativePattaCount || r.cumulativePattaCount,
        cumulativeIshSoni: existing.cumulativeIshSoni || r.cumulativeIshSoni
      };
      if (r.modelId && String(r.modelId).trim()) {
        merged.modelId = r.modelId;
      }
      idMap.set(cleanId, merged);
    }
  }

  // Include any legacy records that had no ID
  for (const r of history) {
    if (!r || (r.id && String(r.id).trim())) continue;
    const key = `${String(r.modelId || '').trim()}_${String(r.partyNumber || '').trim()}`;
    const generatedId = `rec_legacy_${key}`;
    if (!idMap.has(generatedId)) {
      idMap.set(generatedId, { ...r, id: generatedId });
    }
  }

  // 2. Sort chronologically: by cumulativePattaCount (if both > 0) or by creation timestamp
  const sorted = Array.from(idMap.values()).sort((a, b) => {
    const cumA = Number(a.pattaEndNumber || a.cumulativePattaCount) || 0;
    const cumB = Number(b.pattaEndNumber || b.cumulativePattaCount) || 0;
    if (cumA > 0 && cumB > 0) return cumA - cumB;
    const timeA = parseInt((a.id || '').replace(/^rec_(\d+).*/, '$1'), 10) || 0;
    const timeB = parseInt((b.id || '').replace(/^rec_(\d+).*/, '$1'), 10) || 0;
    return timeA - timeB;
  });

  // 3. Preserve existing cumulative counts! Physical paper tickets have fixed numbers printed on them.
  let runningCumPattas = 0;
  let runningCumIshs = 0;

  return sorted.map((r) => {
    const pCount = Number(r.pattaCount) || 0;
    const ishCount = Number(r.totalIshSoni || r.ishSoni) || 0;

    let cumPatta = Number(r.cumulativePattaCount);
    let cumIsh = Number(r.cumulativeIshSoni);
    const hasExplicitRange = Number.isSafeInteger(r.pattaStartNumber) && Number.isSafeInteger(r.pattaEndNumber);

    if (hasExplicitRange) {
      runningCumPattas = Math.max(runningCumPattas, Number(r.pattaEndNumber));
    } else if (!cumPatta || cumPatta <= 0) {
      runningCumPattas += pCount;
      cumPatta = runningCumPattas;
    } else {
      runningCumPattas = Math.max(runningCumPattas, cumPatta);
    }

    if (!cumIsh || cumIsh <= 0) {
      runningCumIshs += ishCount;
      cumIsh = runningCumIshs;
    } else {
      runningCumIshs = Math.max(runningCumIshs, cumIsh);
    }

    const cleanR: any = {
      ...r,
      cumulativePattaCount: hasExplicitRange ? Number(r.cumulativePattaCount || 0) : cumPatta,
      cumulativeIshSoni: cumIsh
    };
    if (cleanR.closedAt === undefined) {
      delete cleanR.closedAt;
    }
    return cleanR;
  });
}

/**
 * submittedTickets dagi barcha topshirilgan pattalardan hisobQuantities ni qayta tiklash/reconciliation qilish.
 * Agar model.hisobQuantities bo'sh bo'lib qolsa yoki submittedTickets dan kam bo'lsa,
 * ushbu funksiya model.hisobQuantities ni submittedTickets dagi haqiqiy ishlar bilan to'ldiradi.
 */
export function reconcileModelHisobQuantities(
  models: ModelConfig[],
  submittedTickets: SubmittedTicketRecord[]
): ModelConfig[] {
  if (!models || models.length === 0) return models || [];
  const safeTickets = submittedTickets || [];

  // 1. submittedTickets bo'yicha har bir model, ishchi va operatsiya bo'yicha jami sonlarni hisoblaymiz
  const ticketTotalsByModel: Record<string, Record<number, Record<string, number>>> = {};

  for (const t of safeTickets) {
    if (!t.modelId || !t.entries || t.entries.length === 0) continue;
    const mId = t.modelId;
    if (!ticketTotalsByModel[mId]) {
      ticketTotalsByModel[mId] = {};
    }
    const mHq = ticketTotalsByModel[mId];
    const qty = Number(t.qty) || 0;
    if (qty <= 0) continue;

    for (const e of t.entries) {
      if (e.workerId === undefined || e.workerId === null || !e.opName) continue;
      const targetWorkerId = e.workerId;

      if (!mHq[targetWorkerId]) {
        mHq[targetWorkerId] = {};
      }
      mHq[targetWorkerId][e.opName] = (mHq[targetWorkerId][e.opName] || 0) + qty;
    }
  }

  // 2. Har bir modelga tekshirib qo'llaymiz
  return models.map((m) => {
    const computedHq = ticketTotalsByModel[m.id] || {};
    const normalizedHq: Record<number, Record<string, number>> = {};
    for (const [workerId, operations] of Object.entries(computedHq)) {
      const cleanOperations: Record<string, number> = {};
      for (const [operationName, value] of Object.entries(operations)) {
        if (Number.isFinite(value) && value > 0) cleanOperations[operationName] = value;
      }
      if (Object.keys(cleanOperations).length > 0) normalizedHq[Number(workerId)] = cleanOperations;
    }

    return {
      ...m,
      hisobQuantities: normalizedHq
    };
  });
}

