import { StateCreator } from 'zustand';
import { WorkbookStore, ModelSlice } from '../types';
import { ModelConfig } from '../../types/workbook';
import { STANDARD_OPERATIONS } from '../../constants/operationConstants';
import { triggerDebouncedSave } from '../helpers/debounceSave';
import { getElectronApi, resolveElectronRuntimeMode } from '../runtimeMode';
import { createWorkbookCommand, requestReconnect, reloadWorkbookProjection, submitWorkbookCommand } from '../businessMutations';

async function tryModelMutation(
  state: Pick<WorkbookStore, 'addNotification' | 'licenseStatus'>,
  get: () => WorkbookStore,
  set: (partial: Partial<WorkbookStore>) => void,
  commandType: 'UpsertModel' | 'DeactivateModel',
  modelId: string,
  payload: Record<string, any>
): Promise<{ handled: boolean; success: boolean } | null> {
  const initialLicenseStatus = state.licenseStatus;
  const runtime = await resolveElectronRuntimeMode(getElectronApi());
  if (get().licenseStatus !== initialLicenseStatus) {
    state.addNotification('error', '_SESSION_CHANGED', 'The active company changed while the operation was in flight.');
    return { handled: true, success: false };
  }
  if (runtime.mode !== 'sync') return null;
  if (!runtime.success) {
    state.addNotification('error', runtime.code || '_RUNTIME_NOT_READY', runtime.error || ' runtime readiness failed.');
    return { handled: true, success: false };
  }
  const companyId = state.licenseStatus?.companyId;
  if (!companyId) {
    state.addNotification('error', '_RUNTIME_NOT_READY', 'A company binding is required for  model changes.');
    return { handled: true, success: false };
  }
  const command = createWorkbookCommand(commandType, companyId, modelId, payload);
  const result = await submitWorkbookCommand(command, get, set);
  if (!result.success) {
    state.addNotification('error', result.code || '_COMMAND_REJECTED', result.error || ' model change was rejected.');
    return { handled: true, success: false };
  }
  return { handled: true, success: true };
}

function modelCommandPayload(model: ModelConfig, operationRenames?: Array<{ fromName: string; toName: string }>): Record<string, any> {
  return {
    id: model.id,
    name: model.name,
    hisobSheetName: model.hisobSheetName,
    title: model.title,
    party: model.party,
    color: model.color,
    size: model.size,
    operations: model.operations,
    pattaOpsOrder: model.pattaOpsOrder,
    ...(operationRenames ? { operationRenames } : {})
  };
}

function createUuid(): string {
  const randomUUID = (globalThis.crypto as Crypto & { randomUUID?: () => string } | undefined)?.randomUUID;
  if (typeof randomUUID !== 'function') throw new Error('_COMMAND_REQUIRED: UUID generation is unavailable');
  return randomUUID.call(globalThis.crypto);
}

async function tryHisobAdjustment(
  state: Pick<WorkbookStore, 'addNotification' | 'licenseStatus'>,
  get: () => WorkbookStore,
  set: (partial: Partial<WorkbookStore>) => void,
  modelId: string,
  workerId: number,
  opName: string,
  targetQty: number
): Promise<{ handled: boolean; success: boolean } | null> {
  const eAPI = getElectronApi();
  const runtime = await resolveElectronRuntimeMode(eAPI);
  if (runtime.mode !== 'sync') return null;
  if (!runtime.success) {
    state.addNotification('error', runtime.code || '_RUNTIME_NOT_READY', runtime.error || ' runtime readiness failed.');
    return { handled: true, success: false };
  }
  const companyId = state.licenseStatus?.companyId;
  const currentState = get();
  const model = (currentState.models || []).find((item) => item.id === modelId);
  const worker = (currentState.workers || []).find((item) => item.id === workerId);
  if (!companyId || !model || !worker || typeof eAPI?.RecordAdjustmentCommand !== 'function') {
    state.addNotification('error', '_COMMAND_REQUIRED', ' quantity adjustments require an active company, model, worker, and command bridge.');
    return { handled: true, success: false };
  }
  const operation = model.operations.find((item) => item.name === opName);
  if (!operation) {
    state.addNotification('error', 'UNKNOWN_OPERATION', `Operation "${opName}" is not defined in model "${modelId}".`);
    return { handled: true, success: false };
  }
  const currentQty = Number(model.hisobQuantities?.[workerId]?.[opName] || 0);
  const deltaQty = Number(targetQty) - currentQty;
  if (!Number.isFinite(deltaQty)) {
    state.addNotification('error', 'INVALID_QUANTITY', 'Quantity must be a finite number.');
    return { handled: true, success: false };
  }
  if (deltaQty === 0) return { handled: true, success: true };
  const commandId = createUuid();
  const operationId = createUuid();
  const result = await eAPI.RecordAdjustmentCommand({
    commandId,
    operationId,
    adjustmentId: createUuid(),
    companyId,
    modelId,
    workerId,
    opName,
    deltaQty,
    reason: 'MANUAL_CORRECTION',
    createdBy: '_WORKBOOK_UI',
    status: 'APPROVED',
    effectiveDate: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString()
  });
  if (!result?.success) {
    state.addNotification('error', result?.code || 'WORKBOOK_COMMAND_FAILED', result?.error || ' quantity adjustment was rejected.');
    return { handled: true, success: false };
  }
  try {
    const projection = await reloadWorkbookProjection(eAPI, companyId);
    if (get().licenseStatus !== state.licenseStatus) {
      state.addNotification('error', '_SESSION_CHANGED', 'The company session changed before the  projection reloaded.');
      return { handled: true, success: false };
    }
    set(projection as Partial<WorkbookStore>);
  } catch {
    state.addNotification('warning', '_PROJECTION_RELOAD_PENDING', 'The quantity change is saved locally and will appear after the next reload.');
  }
  requestReconnect(eAPI, companyId);
  return { handled: true, success: true };
}

export const createModelSlice: StateCreator<WorkbookStore, [], [], ModelSlice> = (set, get) => ({
  models: [],

  addModel: async (name, options) => {
    const state = get();
    const cleanName = name.trim().replace(/\s+/g, '-');
    if (!cleanName) return;

    if (
      state.models.some(
        (m) =>
          m.name.toLowerCase() === cleanName.toLowerCase() ||
          m.id.toLowerCase() === cleanName.toLowerCase()
      )
    ) {
      state.addNotification('error', 'Mavjud', `"${cleanName}" nomli model allaqachon mavjud!`);
      return;
    }

    let operations: any[] = [];
    let pattaOpsOrder: string[] = [];

    if (options?.templateType === 'clone' && options.cloneFromId) {
      const source = state.models.find((m) => m.id === options.cloneFromId);
      if (source) {
        operations = source.operations.map((op, idx) => ({
          id: `op_${Date.now()}_${idx}`,
          name: op.name,
          rate: op.rate
        }));
        pattaOpsOrder = [...source.pattaOpsOrder];
      }
    } else if (options?.templateType === 'standard' || !options?.templateType) {
      operations = STANDARD_OPERATIONS.map((op, idx) => ({
        id: `op_${Date.now()}_${idx}`,
        name: op.name,
        rate: op.rate
      }));
      pattaOpsOrder = STANDARD_OPERATIONS.map((o) => o.name);
    }

    const newModel: ModelConfig = {
      id: cleanName,
      name: cleanName,
      hisobSheetName: `${cleanName}-hisob`,
      title: options?.title || `Модел- ${cleanName}`,
      party: options?.party || '',
      color: options?.color || 'Кора',
      size: options?.size || 'XL',
      operations,
      pattaOpsOrder,
      hisobQuantities: {}
    };

    const updatedModels = [...state.models, newModel];
    const updatedTicketForms = {
      ...state.ticketForms,
      [cleanName]: {
        date: new Date().toISOString().slice(0, 10),
        party: options?.party || '',
        color: options?.color || 'Кора',
        size: options?.size || 'XL',
        qty: '',
        patta: '1',
        entries: {}
      }
    };
    const updatedPattaBatches = {
      ...state.pattaBatchConfigs,
      [cleanName]: {
        partyNumber: '',
        isCustomParty: false,
        totalIshSoni: '',
        color: options?.color || 'Кора',
        sizes: {}
      }
    };

    const updatedDeletedModelIds = (state.deletedModelIds || []).filter(
      (id) => id.toLowerCase() !== cleanName.toLowerCase()
    );

    const sync = await tryModelMutation(state, get, set, 'UpsertModel', newModel.id, modelCommandPayload(newModel));
    if (sync?.handled) {
      if (sync.success) {
        set({ activeSheet: cleanName });
        state.addNotification('success', "Model qo'shildi", `"${cleanName}" modeli  bazasiga saqlandi.`);
      }
      return;
    }

    set({
      models: updatedModels,
      ticketForms: updatedTicketForms,
      pattaBatchConfigs: updatedPattaBatches,
      deletedModelIds: updatedDeletedModelIds,
      activeSheet: cleanName
    });
    if (!(await get().saveToDisk({
      models: updatedModels,
      ticketForms: updatedTicketForms,
      pattaBatchConfigs: updatedPattaBatches,
      deletedModelIds: updatedDeletedModelIds,
      companyId: state.licenseStatus?.companyId
    }))) return;
    state.addNotification(
      'success',
      "Model qo'shildi",
      `"${cleanName}" va "${cleanName}-hisob" tayyor shablon bilan yaratildi!`
    );
  },

  deleteModel: async (modelId) => {
    const state = get();
    if (state.models.length <= 1) {
      state.addNotification('error', 'Xatolik', "Oxirgi modelni o'chirib bo'lmaydi.");
      return;
    }

    const sync = await tryModelMutation(state, get, set, 'DeactivateModel', modelId, { modelId });
    if (sync?.handled) {
      if (sync.success) {
        set({ activeSheet: get().models[0]?.name || 'Umumiy' });
        state.addNotification('info', "O'chirildi", 'Model  tarixini saqlagan holda faol holatdan olindi.');
      }
      return;
    }

    const updatedModels = state.models.filter((m) => m.id !== modelId);
    const updatedDeletedModelIds = Array.from(new Set([...(state.deletedModelIds || []), modelId]));
    const nextSheet = updatedModels[0]?.name || 'Umumiy';
    set({ models: updatedModels, activeSheet: nextSheet, deletedModelIds: updatedDeletedModelIds });
    if (!(await get().saveToDisk({ models: updatedModels, deletedModelIds: updatedDeletedModelIds, companyId: state.licenseStatus?.companyId }))) return;
    state.addNotification('info', "O'chirildi", "Model va uning hisob varag'i o'chirildi.");
  },

  renameModel: async (modelId, newName) => {
    const state = get();
    const cleanName = newName.trim().replace(/-hisob$/i, '');
    if (!cleanName) return;
    if (
      state.models.some(
        (m) => m.id !== modelId && m.name.toLowerCase() === cleanName.toLowerCase()
      )
    ) {
      state.addNotification('warning', 'Mavjud nom', `"${cleanName}" nomli model allaqachon mavjud.`);
      return;
    }

    const targetModel = state.models.find((m) => m.id === modelId || m.name === modelId);
    if (!targetModel) return;
    const oldId = targetModel.id;

    const sync = await tryModelMutation(state, get, set, 'UpsertModel', oldId, modelCommandPayload({
      ...targetModel,
      name: cleanName,
      hisobSheetName: `${cleanName}-hisob`,
      title: `Модел- ${cleanName}`
    }));
    if (sync?.handled) {
      if (sync.success) {
        const activeSheet = get().activeSheet;
        if (activeSheet === targetModel.name || activeSheet === targetModel.id || activeSheet === oldId) set({ activeSheet: cleanName });
        else if (activeSheet === targetModel.hisobSheetName || activeSheet === `${oldId}-hisob`) set({ activeSheet: `${cleanName}-hisob` });
        state.addNotification('success', 'Nomlandi', `Model nomi "${cleanName}" ga o'zgartirildi.`);
      }
      return;
    }

    const updatedModels = state.models.map((m) => {
      if (m.id !== oldId) return m;
      return {
        ...m,
        id: cleanName,
        name: cleanName,
        hisobSheetName: `${cleanName}-hisob`,
        title: `Модел- ${cleanName}`
      };
    });

    // Migrate ticket forms
    const updatedTicketForms = { ...state.ticketForms };
    if (updatedTicketForms[oldId]) {
      updatedTicketForms[cleanName] = updatedTicketForms[oldId];
      if (oldId !== cleanName) delete updatedTicketForms[oldId];
    }

    // Migrate patta batch configs
    const updatedPattaBatches = { ...state.pattaBatchConfigs };
    if (updatedPattaBatches[oldId]) {
      updatedPattaBatches[cleanName] = updatedPattaBatches[oldId];
      if (oldId !== cleanName) delete updatedPattaBatches[oldId];
    }

    // Migrate submitted tickets
    const updatedTickets = (state.submittedTickets || []).map((t) => {
      if (t.modelId === oldId) {
        return { ...t, modelId: cleanName };
      }
      return t;
    });

    // Migrate printed party history
    const updatedHistory = (state.printedPartyHistory || []).map((h) => {
      if (h.modelId === oldId) {
        return { ...h, modelId: cleanName, modelName: cleanName };
      }
      return h;
    });

    let currentActive = state.activeSheet;
    if (currentActive === targetModel.name || currentActive === targetModel.id || currentActive === oldId) {
      currentActive = cleanName;
    } else if (
      currentActive === targetModel.hisobSheetName ||
      currentActive === `${oldId}-hisob` ||
      currentActive === `${targetModel.name}-hisob`
    ) {
      currentActive = `${cleanName}-hisob`;
    }

    const filteredDeleted = (state.deletedModelIds || []).filter(
      (id) => id.toLowerCase() !== cleanName.toLowerCase()
    );
    const updatedDeletedModelIds = oldId.toLowerCase() !== cleanName.toLowerCase()
      ? Array.from(new Set([...filteredDeleted, oldId]))
      : filteredDeleted;

    set({
      models: updatedModels,
      ticketForms: updatedTicketForms,
      pattaBatchConfigs: updatedPattaBatches,
      submittedTickets: updatedTickets,
      printedPartyHistory: updatedHistory,
      deletedModelIds: updatedDeletedModelIds,
      activeSheet: currentActive
    });

    if (!(await get().saveToDisk({
      models: updatedModels,
      ticketForms: updatedTicketForms,
      pattaBatchConfigs: updatedPattaBatches,
      submittedTickets: updatedTickets,
      printedPartyHistory: updatedHistory,
      deletedModelIds: updatedDeletedModelIds,
      companyId: state.licenseStatus?.companyId
    }))) return;

    state.addNotification('success', 'Nomlandi', `Model nomi "${cleanName}" ga o'zgartirildi.`);
  },

  syncNewOperation: async (modelId: string, opName: string, rate: number) => {
    const state = get();
    const cleanOpName = opName.trim();
    if (!cleanOpName) return;

    const updatedModels = state.models.map((m) => {
      if (m.id === modelId) {
        if (m.operations.some((op) => op.name.toLowerCase() === cleanOpName.toLowerCase())) {
          state.addNotification('info', 'Mavjud', 'Bu operatsiya allaqachon mavjud.');
          return m;
        }

        const newOp = {
          id: `op_${Date.now()}`,
          name: cleanOpName,
          rate: Number(rate) || 0
        };

        const rawOps = [...m.operations, newOp];
        const updatedOps = rawOps.map((op, idx) => ({
          ...op,
          col: 3 + idx * 2,
          id: op.id || `op_${3 + idx * 2}`
        }));

        const updatedPattaOrder = m.pattaOpsOrder.includes(cleanOpName)
          ? m.pattaOpsOrder
          : [...m.pattaOpsOrder, cleanOpName];

        return {
          ...m,
          operations: updatedOps,
          pattaOpsOrder: updatedPattaOrder
        };
      }
      return m;
    });

    const updatedModel = updatedModels.find((model) => model.id === modelId);
    const sync = updatedModel
      ? await tryModelMutation(state, get, set, 'UpsertModel', modelId, modelCommandPayload(updatedModel))
      : null;
    if (sync?.handled) {
      if (sync.success) state.addNotification('success', "Qo'shildi", `'${cleanOpName}'  modeliga qo'shildi.`);
      return;
    }

    set({ models: updatedModels });
    if (!(await get().saveToDisk({ models: updatedModels, companyId: state.licenseStatus?.companyId }))) return;
    state.addNotification('success', "Qo'shildi", `'${cleanOpName}' bazaga va Excelga qo'shildi!`);
  },

  syncDeleteOperation: async (modelId: string, opName: string) => {
    const state = get();
    const cleanOpName = opName.trim();
    if (!cleanOpName) return;

    const targetOpLower = cleanOpName.toLowerCase();

    const updatedModels = state.models.map((m) => {
      if (m.id === modelId) {
        const filteredOps = m.operations.filter(
          (op) => op.name.trim().toLowerCase() !== targetOpLower
        );
        const updatedOps = filteredOps.map((op, idx) => ({
          ...op,
          col: 3 + idx * 2,
          id: op.id || `op_${3 + idx * 2}`
        }));

        const updatedPattaOrder = m.pattaOpsOrder.filter(
          (op) => op.trim().toLowerCase() !== targetOpLower
        );

        const updatedHisobQuantities: Record<number, Record<string, number>> = {};
        for (const [wIdStr, opMap] of Object.entries(m.hisobQuantities || {})) {
          const wId = Number(wIdStr);
          const newOpMap: Record<string, number> = {};
          for (const [k, v] of Object.entries(opMap)) {
            if (k.trim().toLowerCase() !== targetOpLower) {
              newOpMap[k] = v;
            }
          }
          updatedHisobQuantities[wId] = newOpMap;
        }

        return {
          ...m,
          operations: updatedOps,
          pattaOpsOrder: updatedPattaOrder,
          hisobQuantities: updatedHisobQuantities
        };
      }
      return m;
    });

    // Also clean up form entry atomically
    const currentForm = state.ticketForms[modelId];
    let updatedForms = state.ticketForms;
    if (currentForm && currentForm.entries) {
      const newEntries = { ...currentForm.entries };
      for (const k of Object.keys(newEntries)) {
        if (k.trim().toLowerCase() === targetOpLower) {
          delete newEntries[k];
        }
      }
      updatedForms = {
        ...state.ticketForms,
        [modelId]: {
          ...currentForm,
          entries: newEntries
        }
      };
    }

    const updatedModel = updatedModels.find((model) => model.id === modelId);
    const sync = updatedModel
      ? await tryModelMutation(state, get, set, 'UpsertModel', modelId, modelCommandPayload(updatedModel))
      : null;
    if (sync?.handled) {
      if (sync.success) {
        const companyId = state.licenseStatus?.companyId;
        const eAPI = getElectronApi();
        if (companyId && eAPI?.TicketDraftSave && updatedForms[modelId]) {
          const saved = await eAPI.TicketDraftSave({ companyId, modelId, form: updatedForms[modelId] });
          if (!saved?.success) state.addNotification('warning', '_TICKET_DRAFT_SAVE_FAILED', saved?.error || 'The updated ticket draft could not be saved.');
        }
        state.addNotification('info', "O'chirildi", `"${cleanOpName}"  modelidan o'chirildi.`);
      }
      return;
    }

    set({
      models: updatedModels,
      ticketForms: updatedForms
    });

    if (!(await get().saveToDisk({ models: updatedModels, ticketForms: updatedForms, companyId: state.licenseStatus?.companyId }))) return;
    state.addNotification('info', "O'chirildi", `"${cleanOpName}" operatsiyasi muvaffaqiyatli o'chirildi.`);
  },

  updateOperationRate: async (modelId: string, opName: string, rate: number) => {
    const state = get();
    const updatedModels = state.models.map((m) => {
      if (m.id === modelId) {
        const updatedOps = m.operations.map((op) => {
          if (op.name === opName) {
            return { ...op, rate: Number(rate) || 0 };
          }
          return op;
        });
        return { ...m, operations: updatedOps };
      }
      return m;
    });

    const updatedModel = updatedModels.find((model) => model.id === modelId);
    const sync = updatedModel
      ? await tryModelMutation(state, get, set, 'UpsertModel', modelId, modelCommandPayload(updatedModel))
      : null;
    if (sync?.handled) {
      if (sync.success) state.addNotification('success', 'Stavka yangilandi', `"${opName}" stavkasi  da saqlandi.`);
      return;
    }

    set({ models: updatedModels });
    triggerDebouncedSave(() => {
      get().saveToDisk({ models: updatedModels, companyId: state.licenseStatus?.companyId });
      }, 1200, 'model', () => get().licenseStatus === state.licenseStatus);
  },

  updateOperationName: async (modelId: string, oldOpName: string, newOpName: string) => {
    const state = get();
    const cleanNewName = newOpName.trim();
    if (!cleanNewName || cleanNewName === oldOpName) return;

    const updatedModels = state.models.map((m) => {
      if (m.id === modelId) {
        const updatedOps = m.operations.map((op) => {
          if (op.name === oldOpName) {
            return { ...op, name: cleanNewName };
          }
          return op;
        });

        const updatedPattaOrder = m.pattaOpsOrder.map((name) =>
          name === oldOpName ? cleanNewName : name
        );

        const updatedHisobQuantities: Record<number, Record<string, number>> = {};
        for (const [wIdStr, opMap] of Object.entries(m.hisobQuantities || {})) {
          const wId = Number(wIdStr);
          const newOpMap: Record<string, number> = {};
          for (const [k, v] of Object.entries(opMap)) {
            if (k === oldOpName) {
              newOpMap[cleanNewName] = v;
            } else {
              newOpMap[k] = v;
            }
          }
          updatedHisobQuantities[wId] = newOpMap;
        }

        return {
          ...m,
          operations: updatedOps,
          pattaOpsOrder: updatedPattaOrder,
          hisobQuantities: updatedHisobQuantities
        };
      }
      return m;
    });

    const updatedTicketForms = { ...state.ticketForms };
    const pendingForm = updatedTicketForms[modelId];
    if (pendingForm?.entries) {
      const migratedEntries = { ...pendingForm.entries };
      if (Object.prototype.hasOwnProperty.call(migratedEntries, oldOpName)) {
        migratedEntries[cleanNewName] = migratedEntries[oldOpName];
        if (oldOpName !== cleanNewName) delete migratedEntries[oldOpName];
      }
      updatedTicketForms[modelId] = { ...pendingForm, entries: migratedEntries };
    }

    const updatedModel = updatedModels.find((model) => model.id === modelId);
    const sync = updatedModel
      ? await tryModelMutation(state, get, set, 'UpsertModel', modelId, modelCommandPayload(updatedModel, [{ fromName: oldOpName, toName: cleanNewName }]))
      : null;
    if (sync?.handled) {
      if (sync.success) {
        const companyId = state.licenseStatus?.companyId;
        const eAPI = getElectronApi();
        if (companyId && eAPI?.TicketDraftSave && updatedTicketForms[modelId]) {
          const saved = await eAPI.TicketDraftSave({ companyId, modelId, form: updatedTicketForms[modelId] });
          if (!saved?.success) state.addNotification('warning', '_TICKET_DRAFT_SAVE_FAILED', saved?.error || 'The updated ticket draft could not be saved.');
        }
        state.addNotification('success', 'Nom yangilandi', `"${oldOpName}" nomi  modelida yangilandi.`);
      }
      return;
    }

    set({ models: updatedModels, ticketForms: updatedTicketForms });
    if (!(await get().saveToDisk({ models: updatedModels, ticketForms: updatedTicketForms, companyId: state.licenseStatus?.companyId }))) return;
    state.addNotification('success', 'Nom yangilandi', `"${oldOpName}" nomi "${cleanNewName}" ga o'zgartirildi.`);
  },

  // LEGACY_COMPATIBILITY: Direct hisob aggregate mutation retained temporarily for UI parity.
  // In Step 3, direct edits transition to transactional RecordProductionAdjustmentCommand facts.
  updateHisobQuantity: async (modelId: string, workerId: number, opName: string, qty: number) => {
    const state = get();
    const sync = await tryHisobAdjustment(state, get, set, modelId, workerId, opName, qty);
    if (sync?.handled) return;
    const updatedModels = state.models.map((m) => {
      if (m.id === modelId) {
        const hq = m.hisobQuantities || {};
        const currentWorkerOps = { ...(hq[workerId] || {}) };
        if (qty <= 0) {
          delete currentWorkerOps[opName];
        } else {
          currentWorkerOps[opName] = qty;
        }
        return {
          ...m,
          hisobQuantities: {
            ...hq,
            [workerId]: currentWorkerOps
          }
        };
      }
      return m;
    });

    set({ models: updatedModels });
    triggerDebouncedSave(() => {
      get().saveToDisk({ models: updatedModels, companyId: state.licenseStatus?.companyId }, { skipReconcile: true });
      }, 1200, 'model', () => get().licenseStatus === state.licenseStatus);
  },

  reorderOperations: async (modelId: string, newOrder: string[]) => {
    const state = get();
    const model = state.models.find((m) => m.id === modelId);
    if (!model) return;

    const currentOpsMap = new Map<string, typeof model.operations[0]>();
    for (const op of model.operations) {
      currentOpsMap.set(op.name, op);
    }

    const reorderedOps: typeof model.operations = [];
    for (let i = 0; i < newOrder.length; i++) {
      const opName = newOrder[i];
      const existing = currentOpsMap.get(opName);
      if (existing) {
        reorderedOps.push({
          ...existing,
          col: 3 + i * 2,
          id: `op_${3 + i * 2}`
        });
      }
    }

    for (const op of model.operations) {
      if (!newOrder.includes(op.name)) {
        const col = 3 + reorderedOps.length * 2;
        reorderedOps.push({ ...op, col, id: `op_${col}` });
      }
    }

    const finalOrder = reorderedOps.map((o) => o.name);

    const updatedModels = state.models.map((m) => {
      if (m.id === modelId) {
        return {
          ...m,
          operations: reorderedOps,
          pattaOpsOrder: finalOrder
        };
      }
      return m;
    });

    const updatedModel = updatedModels.find((item) => item.id === modelId);
    const sync = updatedModel
      ? await tryModelMutation(state, get, set, 'UpsertModel', modelId, modelCommandPayload(updatedModel))
      : null;
    if (sync?.handled) {
      if (sync.success) state.addNotification('success', 'Tartib saqlandi', 'Operatsiyalar tartibi  modelida saqlandi.');
      return;
    }

    set({ models: updatedModels });
    triggerDebouncedSave(() => {
      get().saveToDisk({ models: updatedModels, companyId: state.licenseStatus?.companyId });
      }, 1200, 'model', () => get().licenseStatus === state.licenseStatus);
  }
});
