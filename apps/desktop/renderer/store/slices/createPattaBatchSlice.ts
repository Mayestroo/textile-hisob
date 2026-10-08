import { StateCreator } from 'zustand';
import { WorkbookStore, PattaBatchSlice } from '../types';
import { ModelPattaBatchConfig, PrintedPartyRecord } from '../../types/workbook';
import { DEFAULT_BATCH_SIZES } from '../../constants/batchConstants';
import { formatDateTime } from '../../utils/formatters';
import { triggerDebouncedSave } from '../helpers/debounceSave';
import { createRecordId, findAvailablePattaStart, findNextPartyNumber, removePattaSizeFromBatchConfigs } from '../pattaBatch';

export const createPattaBatchSlice: StateCreator<WorkbookStore, [], [], PattaBatchSlice> = (set, get) => ({
  availableSizes: [...DEFAULT_BATCH_SIZES],
  nextPartyNumber: 1,
  pattaBatchConfigs: {},
  printedPartyHistory: [],

  addCustomSize: (sizeName: string) => {
    const clean = sizeName.trim().toUpperCase();
    if (!clean) return;
    const state = get();
    const current = state.availableSizes || DEFAULT_BATCH_SIZES;
    if (current.some((s) => s.toLowerCase() === clean.toLowerCase())) {
      state.addNotification('warning', 'Mavjud razmer', `«${clean}» razmeri allaqachon mavjud.`);
      return;
    }
    const updated = [...current, clean];
    set({ availableSizes: updated });
    get().saveToDisk({ availableSizes: updated });
    state.addNotification('success', "Razmer qo'shildi", `Yangi «${clean}» razmeri muvaffaqiyatli qo'shildi.`);
  },

  deleteCustomSize: (sizeName: string) => {
    const clean = sizeName.trim().toUpperCase();
    const state = get();
    const current = state.availableSizes || DEFAULT_BATCH_SIZES;
    const updated = current.filter((s) => s.toUpperCase() !== clean);
    const pattaBatchConfigs = removePattaSizeFromBatchConfigs(state.pattaBatchConfigs, clean);
    set({ availableSizes: updated, pattaBatchConfigs });
    get().saveToDisk({ availableSizes: updated, pattaBatchConfigs });
    state.addNotification('info', "Razmer o'chirildi", `«${clean}» razmeri ro'yxatdan olib tashlandi.`);
  },

  incrementPartyNumber: (modelId: string, printedPartyStr: string) => {
    const printedNum = parseInt(printedPartyStr, 10) || 1;
    const newNextParty = printedNum + 1;

    set((state) => {
      const updatedConfigs: Record<string, ModelPattaBatchConfig> = {};

      for (const m of state.models) {
        const c = state.pattaBatchConfigs[m.id];
        const isTarget = m.id === modelId;
        const resetSizes: Record<string, string> = {};
        for (const s of state.availableSizes || DEFAULT_BATCH_SIZES) {
          resetSizes[s] = isTarget ? '' : c?.sizes?.[s] || '';
        }

        updatedConfigs[m.id] = {
          partyNumber: isTarget ? '' : (c?.isCustomParty ? c.partyNumber : ''),
          isCustomParty: isTarget ? false : Boolean(c?.isCustomParty),
          totalIshSoni: isTarget ? '' : c?.totalIshSoni || '',
          color: c?.color || m.color || 'Кора',
          sizes: resetSizes
        };
      }

      get().saveToDisk({
        pattaBatchConfigs: updatedConfigs,
        nextPartyNumber: newNextParty
      });

      return {
        nextPartyNumber: newNextParty,
        pattaBatchConfigs: updatedConfigs
      };
    });
  },

  updatePattaBatchConfig: (modelId: string, updates: Partial<ModelPattaBatchConfig>) => {
    set((state) => {
      const current = state.pattaBatchConfigs[modelId] || {
        partyNumber: '1',
        totalIshSoni: '',
        color: 'Кора',
        sizes: {}
      };
      const updated = {
        ...state.pattaBatchConfigs,
        [modelId]: { ...current, ...updates }
      };
      triggerDebouncedSave(() => {
        get().saveToDisk({ pattaBatchConfigs: updated });
      }, 1200, 'patta_batch');
      return { pattaBatchConfigs: updated };
    });
  },

  updatePattaBatchSize: (modelId: string, size: string, count: string) => {
    set((state) => {
      const sizeKey = size.trim().toUpperCase();
      const currentSizes = state.availableSizes || DEFAULT_BATCH_SIZES;
      const availableSizes = currentSizes.some((value) => value.toUpperCase() === sizeKey)
        ? currentSizes
        : [...currentSizes, sizeKey];
      const current = state.pattaBatchConfigs[modelId] || {
        partyNumber: '1',
        totalIshSoni: '',
        color: 'Кора',
        sizes: {}
      };
      const updatedSizes = { ...(current.sizes || {}), [sizeKey]: count };
      const updated = {
        ...state.pattaBatchConfigs,
        [modelId]: { ...current, sizes: updatedSizes }
      };
      triggerDebouncedSave(() => {
        get().saveToDisk({ pattaBatchConfigs: updated, availableSizes });
      }, 1200, 'patta_batch');
      return { availableSizes, pattaBatchConfigs: updated };
    });
  },

  addPrintedPartyRecord: (item) => {
    const state = get();
    const history = state.printedPartyHistory || [];
    const formattedDate = formatDateTime(new Date());

    const existingIndex = history.findIndex(
      (h) => !h.isClosed && h.modelId === item.modelId && String(h.partyNumber).trim() === String(item.partyNumber).trim()
    );
    const existing = existingIndex >= 0 ? history[existingIndex] : undefined;
    const pattaStartNumber = existing?.pattaStartNumber
      ?? findAvailablePattaStart(history, Number(item.pattaCount || 1), state.nextPattaNumber, state.reusablePattaRanges);
    const pattaEndNumber = existing?.pattaEndNumber ?? (pattaStartNumber + Number(item.pattaCount || 0) - 1);

    const newRecord: PrintedPartyRecord = {
      id: existingIndex >= 0 ? history[existingIndex].id : createRecordId(),
      partyNumber: item.partyNumber,
      modelId: item.modelId,
      modelName: item.modelName,
      color: item.color,
      pattaCount: item.pattaCount || 0,
      cumulativePattaCount: Math.max(0, pattaEndNumber),
      pattaStartNumber: item.pattaCount ? pattaStartNumber : undefined,
      pattaEndNumber: item.pattaCount ? pattaEndNumber : undefined,
      ishSoni: item.ishSoni || 0,
      cumulativeIshSoni: 0,
      printedAt: formattedDate
    };

    const working = [...history];
    if (existingIndex >= 0) {
      working[existingIndex] = newRecord;
    } else {
      working.push(newRecord);
    }

    let cumPattas = 0;
    let cumIshs = 0;
    for (const r of working) {
      if (r.pattaEndNumber && r.pattaEndNumber > cumPattas) cumPattas = r.pattaEndNumber;
      if (r.cumulativePattaCount && r.cumulativePattaCount > cumPattas) {
        cumPattas = r.cumulativePattaCount;
      }
      if (r.cumulativeIshSoni && r.cumulativeIshSoni > cumIshs) {
        cumIshs = r.cumulativeIshSoni;
      }
    }
    const updatedHistory = working.map((r) => {
      if (r.pattaStartNumber && r.pattaEndNumber) return r;
      if (r.cumulativePattaCount && r.cumulativePattaCount > 0) {
        return r;
      }
      cumPattas += r.pattaCount || 0;
      cumIshs += r.totalIshSoni || r.ishSoni || 0;
      return {
        ...r,
        cumulativePattaCount: cumPattas,
        cumulativeIshSoni: cumIshs
      };
    });

    set({ printedPartyHistory: updatedHistory });
    get().saveToDisk({ printedPartyHistory: updatedHistory });
  },

  batchPrintCompleted: (printedItems) => {
    const state = get();
    const history = state.printedPartyHistory || [];
    const formattedDate = formatDateTime(new Date());

    let workingHistory = [...history];
    const printedModelIds = new Set(printedItems.map((p) => p.modelId));

    let nextAvailableParty = findNextPartyNumber(workingHistory);
    let nextGlobalPatta = Math.max(1, Number(state.nextPattaNumber) || 1);

    for (const p of printedItems) {
      let resolvedPartyNumber = String(p.partyNumber).trim();

      // Guard: prevent party number collision with another active model
      const conflictOtherModelIndex = workingHistory.findIndex(
        (h) => !h.isClosed && h.modelId !== p.modelId && String(h.partyNumber).trim() === resolvedPartyNumber
      );
      if (conflictOtherModelIndex >= 0) {
        while (workingHistory.some((party) => !party.isClosed && party.isArchived !== true
          && String(party.partyNumber).trim() === String(nextAvailableParty))) nextAvailableParty += 1;
        resolvedPartyNumber = String(nextAvailableParty++);
      }

      const model = state.models.find((m) => m.id === p.modelId);
      const existingIndex = workingHistory.findIndex(
        (h) => !h.isClosed && h.modelId === p.modelId && String(h.partyNumber).trim() === resolvedPartyNumber
      );
      const existingRecord = existingIndex >= 0 ? workingHistory[existingIndex] : undefined;
      const pattaStartNumber = existingRecord?.pattaStartNumber
        ?? findAvailablePattaStart(workingHistory, Number(p.pattaCount || 1), nextGlobalPatta, state.reusablePattaRanges);
      const pattaEndNumber = existingRecord?.pattaEndNumber ?? (pattaStartNumber + p.pattaCount - 1);
      if (!existingRecord && pattaStartNumber >= nextGlobalPatta) nextGlobalPatta = pattaEndNumber + 1;

      const recordData: PrintedPartyRecord = {
        id: existingIndex >= 0 ? workingHistory[existingIndex].id : createRecordId(),
        partyNumber: resolvedPartyNumber,
        modelId: p.modelId,
        modelName: model?.title || model?.name || p.modelId,
        color: p.color,
        pattaCount: p.pattaCount,
        cumulativePattaCount: pattaEndNumber,
        pattaStartNumber,
        pattaEndNumber,
        ishSoniPerPatta: p.ishSoniPerPatta || 0,
        totalIshSoni: p.totalIshSoni || p.ishSoni,
        ishSoni: p.totalIshSoni || p.ishSoni,
        cumulativeIshSoni: 0,
        sizes: p.sizes ? { ...p.sizes } : undefined,
        printedAt: formattedDate
      };

      if (existingIndex >= 0) {
        // Agar bir xil model va partiya qayta chop etilsa, dublikat yaratmasdan yangilaymiz
        workingHistory[existingIndex] = recordData;
      } else {
        workingHistory.push(recordData);
      }
    }

    // Cumulative stats ni saqlash:
    // Avval chop etilgan partiyalar o'zining kumulyativ qiymatini saqlaydi!
    // Faqat yangi qo'shilgan partiyalar uchun avvalgi eng yuqori kumulyativdan boshlab hisoblanadi.
    let globalCumPattas = 0;
    let globalCumIshs = 0;
    for (const r of workingHistory) {
      if (r.pattaEndNumber && r.pattaEndNumber > globalCumPattas) {
        globalCumPattas = r.pattaEndNumber;
      }
      if (r.cumulativePattaCount && r.cumulativePattaCount > globalCumPattas) {
        globalCumPattas = r.cumulativePattaCount;
      }
      if (r.cumulativeIshSoni && r.cumulativeIshSoni > globalCumIshs) {
        globalCumIshs = r.cumulativeIshSoni;
      }
    }

    const updatedHistory = workingHistory.map((r) => {
      if (r.pattaStartNumber && r.pattaEndNumber) return r;
      if (r.cumulativePattaCount && r.cumulativePattaCount > 0) {
        return r;
      }
      globalCumPattas += r.pattaCount;
      globalCumIshs += r.totalIshSoni || r.ishSoni || 0;
      return {
        ...r,
        cumulativePattaCount: globalCumPattas,
        cumulativeIshSoni: globalCumIshs
      };
    });

    const updatedConfigs: Record<string, ModelPattaBatchConfig> = {};
    for (const m of state.models) {
      const c = state.pattaBatchConfigs[m.id];
      const isPrinted = printedModelIds.has(m.id);
      const resetSizes: Record<string, string> = {};
      for (const s of state.availableSizes || DEFAULT_BATCH_SIZES) {
        resetSizes[s] = isPrinted ? '' : c?.sizes?.[s] || '';
      }
      updatedConfigs[m.id] = {
        partyNumber: isPrinted ? '' : (c?.isCustomParty ? c.partyNumber : ''),
        isCustomParty: isPrinted ? false : Boolean(c?.isCustomParty),
        totalIshSoni: isPrinted ? '' : c?.totalIshSoni || '',
        color: c?.color || m.color || 'Кора',
        sizes: resetSizes
      };
    }

    // Calculate nextPartyNumber as lowest unused positive integer among active parties
    const nextAvailable = findNextPartyNumber(updatedHistory);

    // Clean any tombstones from deletedPartyIds for re-printed parties so they are never blocked
    const newlyPrintedKeys = new Set(
      printedItems.map((p) => `${p.modelId}#${p.partyNumber}`)
    );
    const updatedDeletedPartyIds = (state.deletedPartyIds || []).filter(
      (id) => !newlyPrintedKeys.has(id)
    );

    set({
      nextPartyNumber: nextAvailable,
      pattaBatchConfigs: updatedConfigs,
      printedPartyHistory: updatedHistory,
      deletedPartyIds: updatedDeletedPartyIds
    });

    get().saveToDisk({
      nextPartyNumber: nextAvailable,
      pattaBatchConfigs: updatedConfigs,
      printedPartyHistory: updatedHistory,
      deletedPartyIds: updatedDeletedPartyIds
    });
  },

  deletePrintedPartyRecord: (id: string) => {
    const state = get();
    const target = (state.printedPartyHistory || []).find((r) => r.id === id);
    const filtered = (state.printedPartyHistory || []).map((party) => party.id === id
      ? { ...party, isClosed: true, isArchived: true }
      : party);
    const resolvedNextParty = findNextPartyNumber(filtered);

    const tombstoneKeys = [id];
    if (target) {
      tombstoneKeys.push(`${target.modelId}#${target.partyNumber}`);
    }
    const updatedDeletedPartyIds = Array.from(new Set([...(state.deletedPartyIds || []), ...tombstoneKeys]));
    const reusablePattaRanges = target?.pattaStartNumber && target.pattaEndNumber
      ? [...(state.reusablePattaRanges || []), { start: target.pattaStartNumber, end: target.pattaEndNumber }]
      : state.reusablePattaRanges || [];

    set({
      printedPartyHistory: filtered,
      nextPartyNumber: resolvedNextParty,
      deletedPartyIds: updatedDeletedPartyIds,
      reusablePattaRanges
    });
    get().saveToDisk({
      printedPartyHistory: filtered,
      nextPartyNumber: resolvedNextParty,
      deletedPartyIds: updatedDeletedPartyIds,
      reusablePattaRanges
    });
  },

  clearPrintedPartyHistory: async () => {
    const state = get();
    const ok = await state.confirmAction({
      title: "Chop etish tarixini tozalash",
      message: "Barcha partiyalar chop etish tarixini tozalamoqchimisiz?",
      confirmText: "Ha, tozalansin",
      isDanger: true
    });
    if (ok) {
      const history = state.printedPartyHistory || [];
      const archivedHistory = history.map((party) => ({ ...party, isClosed: true, isArchived: true }));
      const reusablePattaRanges = [
        ...(state.reusablePattaRanges || []),
        ...history.flatMap((party) => party.pattaStartNumber && party.pattaEndNumber
          ? [{ start: party.pattaStartNumber, end: party.pattaEndNumber }]
          : [])
      ];
      set({ printedPartyHistory: archivedHistory, nextPartyNumber: 1, reusablePattaRanges });
      get().saveToDisk({ printedPartyHistory: archivedHistory, nextPartyNumber: 1, reusablePattaRanges });
    }
  },

  confirmPartyActualQuantities: async (partyRecordId: string) => {
    const state = get();
    const partyRecord = (state.printedPartyHistory || []).find((r) => r.id === partyRecordId);
    if (!partyRecord) return;

    const partyTickets = (state.submittedTickets || []).filter(
      (s) => s.modelId === partyRecord.modelId && String(s.partyNumber) === String(partyRecord.partyNumber)
    );

    if (partyTickets.length === 0) {
      state.addNotification('warning', "Pattalar yo'q", 'Ushbu partiya uchun hali birorta ham patta kiritilmagan.');
      return;
    }

    const actualTotalIsh = partyTickets.reduce((sum, t) => sum + (t.qty || 0), 0);
    const newPerPatta =
      partyRecord.pattaCount > 0
        ? Math.round(actualTotalIsh / partyRecord.pattaCount)
        : actualTotalIsh;

    const updatedHistory = (state.printedPartyHistory || []).map((r) => {
      if (r.id === partyRecordId) {
        return {
          ...r,
          ishSoni: actualTotalIsh,
          totalIshSoni: actualTotalIsh,
          ishSoniPerPatta: newPerPatta
        };
      }
      return r;
    });

    set({ printedPartyHistory: updatedHistory });
    await get().saveToDisk({ printedPartyHistory: updatedHistory });

    state.addNotification(
      'success',
      'Tasdiqlandi!',
      `Partiya ${partyRecord.partyNumber} ning jami soni haqiqiy ${actualTotalIsh.toLocaleString()} dona deb tasdiqlandi va monitoring yangilandi.`
    );
  },

  completePartySeries: async () => {
    const state = get();
    const formattedDate = formatDateTime(new Date());

    // 1. Mark active printed parties as closed
    const updatedHistory = (state.printedPartyHistory || []).map((r) => {
      if (!r.isClosed) {
        return {
          ...r,
          isClosed: true,
          closedAt: formattedDate
        };
      }
      return r;
    });

    // 2. Mark active submitted tickets as closed
    const updatedTickets = (state.submittedTickets || []).map((t) => {
      if (!t.isClosed) {
        return {
          ...t,
          isClosed: true
        };
      }
      return t;
    });

    // 3. Reset configs for all models so party inputs start completely clean
    const resetConfigs: Record<string, ModelPattaBatchConfig> = {};
    for (const m of state.models) {
      const resetSizes: Record<string, string> = {};
      for (const s of state.availableSizes || DEFAULT_BATCH_SIZES) {
        resetSizes[s] = '';
      }
      resetConfigs[m.id] = {
        partyNumber: '',
        isCustomParty: false,
        totalIshSoni: '',
        color: m.color || 'Кора',
        sizes: resetSizes
      };
    }

    // 4. Update state: nextPartyNumber resets to 1!
    set({
      nextPartyNumber: 1,
      pattaBatchConfigs: resetConfigs,
      printedPartyHistory: updatedHistory,
      submittedTickets: updatedTickets
    });

    // 5. Persist through the local database and canonical VPS sync pipeline
    await get().saveToDisk({
      nextPartyNumber: 1,
      pattaBatchConfigs: resetConfigs,
      printedPartyHistory: updatedHistory,
      submittedTickets: updatedTickets
    });

    state.addNotification(
      'success',
      'Partiya yakunlandi',
      'Joriy partiyalar turkumi muvaffaqiyatli yakunlandi. Navbatdagi partiya va patta raqami 1 dan boshlanadi.'
    );
  }
});
