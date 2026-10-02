import { StateCreator } from 'zustand';
import { WorkbookStore, TicketSlice } from '../types';
import { TicketFormState, SubmittedTicketRecord } from '../../types/workbook';
import { validateTicketForSubmission } from '../../domain/ticketValidation';
import { cancelDebouncedSave, triggerDebouncedSave } from '../helpers/debounceSave';
import { formatTicketTimestamp } from '../../utils/formatters';
import { hydrateWorkbookData } from '../helpers/hydration';
import { getElectronApi, resolveElectronRuntimeMode } from '../runtimeMode';
import { requestReconnect } from '../businessMutations';
import { useAuthStore } from '../authStore';
import { captureSessionIdentity, isSessionCurrent } from '../sessionGuard';
import { createWorkbookCommand, submitWorkbookCommand } from '../businessMutations';

type MutationResult = {
  success: false;
  code: '_COMMAND_UNSUPPORTED' | '_COMMAND_REQUIRED' | string;
  error: string;
};

function makeMutationResult(code: MutationResult['code'], error: string): MutationResult {
  return { success: false, code, error };
}

function createCanonicalUuid(): string {
  const randomUUID = (globalThis.crypto as Crypto & { randomUUID?: () => string } | undefined)?.randomUUID;
  if (typeof randomUUID !== 'function') {
    throw new Error('_COMMAND_REQUIRED: UUID generation is unavailable');
  }
  return randomUUID.call(globalThis.crypto);
}

async function reloadProjection(eAPI: any, companyId: string) {
  if (typeof eAPI?.dbRead !== 'function') {
    throw Object.assign(new Error('_PROJECTION_READ_FAILED: SQLite projection bridge is unavailable'), {
      code: '_PROJECTION_READ_FAILED'
    });
  }
  const result = await eAPI.dbRead(companyId);
  if (!result?.success || !result.data) {
    throw Object.assign(new Error(result?.error || '_PROJECTION_READ_FAILED: SQLite projection could not be loaded'), {
      code: result?.code || '_PROJECTION_READ_FAILED'
    });
  }

  const hydrated = hydrateWorkbookData(result.data);
  const sourceModels = new Map<string, any>(
    (Array.isArray(result.data.models) ? result.data.models : []).map((model: any) => [model.id, model])
  );
  return {
    workers: hydrated.workers,
    models: hydrated.models.map((model) => ({
      ...model,
      hisobQuantities: sourceModels.get(model.id)?.hisobQuantities || model.hisobQuantities
    })),
    availableSizes: hydrated.availableSizes,
    nextPartyNumber: hydrated.nextPartyNumber,
    printedPartyHistory: hydrated.printedPartyHistory,
    submittedTickets: hydrated.submittedTickets,
    currentPeriod: hydrated.currentPeriod,
    periods: hydrated.periods,
    ticketForms: hydrated.ticketForms,
    pattaBatchConfigs: hydrated.pattaBatchConfigs,
    deletedTicketIds: hydrated.deletedTicketIds,
    deletedPartyIds: hydrated.deletedPartyIds,
    deletedWorkerIds: hydrated.deletedWorkerIds,
    deletedModelIds: hydrated.deletedModelIds
  };
}

function notifyMutation(state: Pick<WorkbookStore, 'addNotification'>, result: MutationResult) {
  state.addNotification('error', result.code, result.error);
}

function scheduleTicketFormPersistence(
  get: () => WorkbookStore,
  initialLicenseStatus: WorkbookStore['licenseStatus'],
  modelId: string,
  forms: Record<string, TicketFormState>
) {
  const companyId = initialLicenseStatus?.companyId;
  if (!companyId) return;
  triggerDebouncedSave(() => {
    void (async () => {
      if (get().licenseStatus !== initialLicenseStatus) return;
      const eAPI = getElectronApi();
      const runtime = await resolveElectronRuntimeMode(eAPI);
      if (get().licenseStatus !== initialLicenseStatus) return;
      if (runtime.mode === 'sync') {
        if (!runtime.success || typeof eAPI?.TicketDraftSave !== 'function') {
          get().addNotification('error', runtime.code || '_TICKET_DRAFT_UNAVAILABLE', runtime.error || ' ticket draft storage is unavailable.');
          return;
        }
        const result = await eAPI.TicketDraftSave({ companyId, modelId, form: forms[modelId] });
        if (!result?.success) get().addNotification('error', result?.code || '_TICKET_DRAFT_SAVE_FAILED', result?.error || 'Ticket draft could not be saved to SQLite.');
        return;
      }
      await get().saveToDisk({ ticketForms: forms, companyId });
    })().catch((error) => {
      if (get().licenseStatus !== initialLicenseStatus) return;
      get().addNotification('error', 'TICKET_DRAFT_SAVE_FAILED', error instanceof Error ? error.message : 'Ticket draft could not be saved.');
    });
  }, 1200, 'ticket_form', () => get().licenseStatus === initialLicenseStatus);
}

export const createTicketSlice: StateCreator<WorkbookStore, [], [], TicketSlice> = (set, get) => {
  const inFlightSubmissions = new Map<string, Promise<boolean>>();

  return ({
  ticketForms: {},
  submittedTickets: [],

  updateTicketField: (modelId: string, field: keyof TicketFormState, value: any) => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const currentForm = state.ticketForms[modelId] || {
      date: '',
      party: '',
      color: '',
      size: '',
      qty: '',
      entries: {}
    };
    const updatedForms = {
      ...state.ticketForms,
      [modelId]: {
        ...currentForm,
        [field]: value
      }
    };
    set({ ticketForms: updatedForms });
    scheduleTicketFormPersistence(get, initialLicenseStatus, modelId, updatedForms);
  },

  setTicketWorker: (modelId: string, opName: string, workerId: string | number) => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const currentForm = state.ticketForms[modelId] || {
      date: '',
      party: '',
      color: '',
      size: '',
      qty: '',
      entries: {}
    };
    const updatedEntries = {
      ...(currentForm.entries || {}),
      [opName]: workerId
    };
    const updatedForms = {
      ...state.ticketForms,
      [modelId]: {
        ...currentForm,
        entries: updatedEntries
      }
    };
    set({ ticketForms: updatedForms });
    scheduleTicketFormPersistence(get, initialLicenseStatus, modelId, updatedForms);
  },

  clearTicketForm: (modelId: string) => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const currentForm = state.ticketForms[modelId];
    if (!currentForm) return;
    const updatedForms = {
      ...state.ticketForms,
      [modelId]: {
        ...currentForm,
        konveyer: currentForm.konveyer || '',
        party: currentForm.party || '',
        patta: currentForm.patta || '',
        qty: '',
        entries: {}
      }
    };
    set({ ticketForms: updatedForms });
    scheduleTicketFormPersistence(get, initialLicenseStatus, modelId, updatedForms);
  },

  jonatish: (modelId: string): Promise<boolean> => {
    const state = get();
    const model = state.models.find((m) => m.id === modelId || m.name === modelId);
    if (!model) {
      state.addNotification('error', 'Xatolik', `Model topilmadi: ${modelId}`);
      return Promise.resolve(false);
    }

    const form = state.ticketForms[model.id] || state.ticketForms[model.name];
    if (!form) {
      state.addNotification('error', 'Xatolik', 'Patta formasi topilmadi');
      return Promise.resolve(false);
    }

    const defaultStrictValidation = state.licenseStatus?.requireTicketValidation !== false;
    const strictParty = form.strictParty ?? defaultStrictValidation;
    const strictPatta = form.strictPatta ?? defaultStrictValidation;
    const validation = validateTicketForSubmission(
      form,
      model,
      state.workers,
      state.printedPartyHistory,
      state.submittedTickets,
      { strictParty, strictPatta }
    );

    if (!validation.isValid) {
      state.addNotification(
        validation.errorType || 'error',
        validation.title || 'Xatolik',
        validation.message || 'Xatolik yuz berdi'
      );
      return Promise.resolve(false);
    }

    const filledEntries = validation.filledEntries!;
    const actualPattaNum = validation.actualPattaNum!;
    const qty = Number(form.qty);
    const currentPartyStr = String(form.party || '').trim() || (strictParty ? '1' : "No'malum Partiya");
    const currentPattaNum = actualPattaNum;

    // Apply additions to hisobQuantities
    const updatedHisobQuantities = { ...(model.hisobQuantities || {}) };

    for (const entry of filledEntries) {
      const currentWorkerOps = { ...(updatedHisobQuantities[entry.workerId] || {}) };
      const currentQty = currentWorkerOps[entry.opName] || 0;
      currentWorkerOps[entry.opName] = currentQty + qty;
      updatedHisobQuantities[entry.workerId] = currentWorkerOps;
    }

    const updatedModels = state.models.map((m) => {
      if (m.id === modelId) {
        return {
          ...m,
          hisobQuantities: updatedHisobQuantities
        };
      }
      return m;
    });

    const submittedRecord: SubmittedTicketRecord = {
      id: `sub_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      modelId,
      partyNumber: currentPartyStr,
      partyRecordId: validation.partyOwner?.id ?? null,
      isClosed: false,
      konveyer: form.konveyer || '',
      pattaNumber: actualPattaNum,
      size: form.size || '',
      color: form.color || '',
      qty,
      entries: filledEntries,
      submittedAt: formatTicketTimestamp(new Date())
    };
    const updatedSubmittedTickets = [...(state.submittedTickets || []), submittedRecord];

    // Check if current party reached its max printed pattas
    const matchingPrintedParty = (state.printedPartyHistory || []).find(
      (h) => !h.isClosed && h.modelId === modelId && String(h.partyNumber) === currentPartyStr
    ) || validation.partyOwner;
    const maxPattasInParty = matchingPrintedParty ? matchingPrintedParty.pattaCount : 0;

    let nextPartyStr = currentPartyStr;
    let nextPattaNum = (actualPattaNum || currentPattaNum) + 1;

    if (maxPattasInParty > 0 && currentPattaNum >= maxPattasInParty) {
      // Find subsequent printed parties for this model if any
      const modelPrintedParties = (state.printedPartyHistory || [])
        .filter((h) => h.modelId === modelId)
        .map((h) => parseInt(h.partyNumber, 10))
        .filter((num) => !isNaN(num))
        .sort((a, b) => a - b);

      const currentPartyInt = parseInt(currentPartyStr, 10);
      const nextPrinted = modelPrintedParties.find((p) => p > currentPartyInt);

      if (nextPrinted !== undefined) {
        nextPartyStr = String(nextPrinted);
      } else if (!isNaN(currentPartyInt)) {
        nextPartyStr = String(currentPartyInt + 1);
      }
      nextPattaNum = 1;
    }

    const updatedForms = {
      ...state.ticketForms,
      [modelId]: {
        ...form,
        konveyer: form.konveyer || '',
        party: strictParty ? nextPartyStr : (form.party || ''),
        patta: strictPatta ? String(nextPattaNum) : '',
        qty: '',
        entries: {}
      }
    };

    const companyId = state.licenseStatus?.companyId;
    const initialLicenseStatus = state.licenseStatus;
    const partyRecordId = validation.partyOwner?.id ?? null;
    const effectiveDate = form.date || new Date().toISOString().slice(0, 10);
    const fingerprint = JSON.stringify({
      companyId,
      modelId: model.id,
      partyNumber: currentPartyStr,
      partyRecordId,
      pattaNumber: actualPattaNum,
      qty,
      entries: filledEntries
        .map(({ opName, workerId, rateSnapshot }) => ({ opName, workerId, rateSnapshot }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      effectiveDate
    });
    const existingSubmission = inFlightSubmissions.get(fingerprint);
    if (existingSubmission) return existingSubmission;

    const submission = (async (): Promise<boolean> => {
      const eAPI = getElectronApi();
      const runtime = await resolveElectronRuntimeMode(eAPI);
      if (runtime.mode === 'sync') {
        if (!runtime.success) {
          const rejected = makeMutationResult(
            runtime.code || '_RUNTIME_NOT_READY',
            runtime.error || ' runtime readiness failed'
          );
          notifyMutation(state, rejected);
          return false;
        }

        if (!companyId || (strictParty && !partyRecordId) || typeof eAPI?.SubmitTicketCommand !== 'function') {
          const rejected = makeMutationResult(
            '_COMMAND_REQUIRED',
            strictParty
              ? 'Strict-mode  ticket submission requires an active company, printed party, and command bridge.'
              : 'Free-mode  ticket submission requires an active company and command bridge.'
          );
          notifyMutation(state, rejected);
          return false;
        }

        const session = captureSessionIdentity(companyId);
      const isCurrentSession = () => {
          const licenseCompanyId = get().licenseStatus?.companyId;
          const authCompanyId = useAuthStore.getState().companyId;
          return isSessionCurrent(session, licenseCompanyId || authCompanyId)
            && get().licenseStatus === initialLicenseStatus
            && (!licenseCompanyId || licenseCompanyId === companyId)
            && (!authCompanyId || authCompanyId === companyId);
        };
        const rejectStaleSession = () => {
          const rejected = makeMutationResult(
            '_SESSION_CHANGED',
            'The active company changed while the  ticket command was in flight.'
          );
          notifyMutation(state, rejected);
          return false;
      };

      if (runtime.mode === 'sync') cancelDebouncedSave('ticket_form');

      if (!isCurrentSession()) return rejectStaleSession();

        let commandResult: any;
        try {
          commandResult = await eAPI.SubmitTicketCommand({
            commandId: createCanonicalUuid(),
            operationId: createCanonicalUuid(),
            ticketId: createCanonicalUuid(),
            companyId,
            modelId: model.id,
            periodId: state.periods?.find((period) => !period.isClosed)?.id,
            partyNumber: currentPartyStr,
            partyRecordId,
            pattaNumber: actualPattaNum,
            qty,
            size: form.size || '',
            color: form.color || '',
            konveyer: form.konveyer || '',
            entries: filledEntries,
            effectiveDate,
            submittedAt: new Date().toISOString()
          });
        } catch (error) {
          const rejected = makeMutationResult(
            '_COMMAND_REQUIRED',
            error instanceof Error ? error.message : ' ticket command failed'
          );
          notifyMutation(state, rejected);
          return false;
        }

        if (!isCurrentSession()) return rejectStaleSession();

        if (!commandResult?.success) {
          const rejected = makeMutationResult(
            commandResult?.code || '_COMMAND_REQUIRED',
            commandResult?.error || ' ticket command was rejected'
          );
          notifyMutation(state, rejected);
          return false;
        }

        let projection: any;
        try {
          projection = await reloadProjection(eAPI, companyId);
        } catch (error) {
          const rejected = makeMutationResult(
            error && typeof error === 'object' && 'code' in error
              ? String((error as { code?: string }).code || '_PROJECTION_READ_FAILED')
              : '_PROJECTION_READ_FAILED',
            error instanceof Error ? error.message : ' SQLite projection could not be reloaded'
          );
          notifyMutation(state, rejected);
          return false;
        }

        if (!isCurrentSession()) return rejectStaleSession();
        set(projection);
        if (!isCurrentSession()) return rejectStaleSession();
        set({ ticketForms: updatedForms });
        if (typeof eAPI.TicketDraftSave === 'function') {
          void eAPI.TicketDraftSave({ companyId, modelId: model.id, form: updatedForms[model.id] }).catch(() => {});
        }
        requestReconnect(eAPI, companyId);
        state.addNotification(
          'success',
          'Muvaffaqiyatli saqlandi',
          ' kanonik buyrug\'i qabul qilindi va SQLite proyeksiyasi yangilandi.'
        );
        return true;
      }

      if (get().licenseStatus !== initialLicenseStatus) {
        state.addNotification('error', '_SESSION_CHANGED', 'The active company changed while the ticket was in flight.');
        return false;
      }

      set({
        models: updatedModels,
        ticketForms: updatedForms,
        submittedTickets: updatedSubmittedTickets
      });

      // Save to disk & database + update Excel
      if (!(await get().saveToDisk(
        {
          models: updatedModels,
          ticketForms: updatedForms,
          submittedTickets: updatedSubmittedTickets,
          companyId: initialLicenseStatus?.companyId
        },
        { forceBackup: true }
      )) || get().licenseStatus !== initialLicenseStatus) return false;

      // Log transaction to audit file
      try {
        await fetch('/api/log-transaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, qty, entries: filledEntries })
        }).catch((e) => {
          console.warn('Audit transaction log failed:', e);
        });
      } catch (e) {
        console.warn('Audit transaction log failed:', e);
      }

      state.addNotification(
        'success',
        'Muvaffaqiyatli saqlandi',
        "Ma'lumotlar hisob-kitobga va diskdagi bazaga doimiy saqlandi!"
      );
      return true;
    })();

    inFlightSubmissions.set(fingerprint, submission);
    void submission.then(
      () => { if (inFlightSubmissions.get(fingerprint) === submission) inFlightSubmissions.delete(fingerprint); },
      () => { if (inFlightSubmissions.get(fingerprint) === submission) inFlightSubmissions.delete(fingerprint); }
    );
    return submission;
  },

  deleteSubmittedTicket: async (ticketId: string) => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const runtime = await resolveElectronRuntimeMode(getElectronApi());
    if (get().licenseStatus !== initialLicenseStatus) {
      state.addNotification('error', '_SESSION_CHANGED', 'The active company changed while the ticket mutation was in flight.');
      return false;
    }
    if (runtime.mode === 'sync') {
      if (!runtime.success) {
        const rejected = makeMutationResult(runtime.code || '_RUNTIME_NOT_READY', runtime.error || 'Runtime readiness failed');
        notifyMutation(state, rejected);
        return false;
      }
      const companyId = initialLicenseStatus?.companyId;
      if (!companyId) {
        notifyMutation(state, makeMutationResult('_COMMAND_REQUIRED', 'An active company is required to delete a ticket.'));
        return false;
      }
      const ticket = (state.submittedTickets || []).find((item) => item.id === ticketId);
      if (!ticket) return false;
      const result = await submitWorkbookCommand(
        createWorkbookCommand('DeleteTicket', companyId, ticketId, { ticketId }),
        get,
        set
      );
      if (!result.success) {
        notifyMutation(state, makeMutationResult(result.code || '_COMMAND_REQUIRED', result.error || 'Ticket deletion was rejected'));
        return false;
      }
      get().addNotification('success', 'Patta o\'chirildi', `Partiya ${ticket.partyNumber}, Patta ${ticket.pattaNumber} hisobdan qaytarildi.`);
      return true;
    }
    const ticket = (state.submittedTickets || []).find((s) => s.id === ticketId);
    if (!ticket) return;

    // Revert quantities in model
    const model = state.models.find((m) => m.id === ticket.modelId);
    let updatedModels = state.models;

    if (model && ticket.entries && ticket.entries.length > 0) {
      const updatedHisobQuantities = { ...(model.hisobQuantities || {}) };
      for (const entry of ticket.entries) {
        if (updatedHisobQuantities[entry.workerId]) {
          const currentOps = { ...updatedHisobQuantities[entry.workerId] };
          if (currentOps[entry.opName] !== undefined) {
            currentOps[entry.opName] = Math.max(0, currentOps[entry.opName] - ticket.qty);
            updatedHisobQuantities[entry.workerId] = currentOps;
          }
        }
      }

      updatedModels = state.models.map((m) => {
        if (m.id === ticket.modelId) {
          return {
            ...m,
            hisobQuantities: updatedHisobQuantities
          };
        }
        return m;
      });
    }

    const updatedSubmittedTickets = (state.submittedTickets || []).filter((s) => s.id !== ticketId);
    const updatedDeletedTicketIds = Array.from(new Set([...(state.deletedTicketIds || []), ticketId]));

    set({
      models: updatedModels,
      submittedTickets: updatedSubmittedTickets,
      deletedTicketIds: updatedDeletedTicketIds
    });

    if (!(await get().saveToDisk({
      models: updatedModels,
      submittedTickets: updatedSubmittedTickets,
      deletedTicketIds: updatedDeletedTicketIds,
      companyId: initialLicenseStatus?.companyId || undefined
    })) || get().licenseStatus !== initialLicenseStatus) return false;

    state.addNotification(
      'success',
      'Patta bekor qilindi',
      `Partiya ${ticket.partyNumber}, Patta ${ticket.pattaNumber} (${ticket.qty} dona) hisobdan qaytarildi va o'chirildi.`
    );
  },

  updateSubmittedTicket: async (
    ticketId: string,
    updatedEntries: Array<{ opName: string; workerId: number; rateSnapshot?: number }>
  ): Promise<boolean> => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const runtime = await resolveElectronRuntimeMode(getElectronApi());
    if (get().licenseStatus !== initialLicenseStatus) {
      state.addNotification('error', '_SESSION_CHANGED', 'The active company changed while the ticket mutation was in flight.');
      return false;
    }
    if (runtime.mode === 'sync') {
      const rejected = makeMutationResult(
        runtime.code || '_COMMAND_UNSUPPORTED',
        runtime.error || ' ticket-edit mutation is not supported; use a canonical command.'
      );
      notifyMutation(state, rejected);
      return false;
    }
    const ticket = (state.submittedTickets || []).find((s) => s.id === ticketId);
    if (!ticket) {
      state.addNotification('error', 'Xatolik', 'Tahrirlanayotgan patta topilmadi');
      return false;
    }

    const model = state.models.find((m) => m.id === ticket.modelId);
    if (!model) {
      state.addNotification('error', 'Xatolik', `Model topilmadi: ${ticket.modelId}`);
      return false;
    }

    // Build worker lookup map
    const workerMap = new Map<number, string>();
    for (const w of state.workers) {
      workerMap.set(w.id, w.name);
    }

    // Validate entries: filter valid worker IDs that exist in workers
    const validEntries: Array<{
      opName: string;
      workerId: number;
      workerNameSnapshot: string;
      rateSnapshot: number;
    }> = [];

    for (const e of updatedEntries) {
      if (typeof e.workerId === 'number' && Number.isSafeInteger(e.workerId) && e.workerId > 0) {
        if (!workerMap.has(e.workerId)) {
          state.addNotification('error', 'Ishchi topilmadi', `Bazada #${e.workerId} ID ga ega ishchi mavjud emas!`);
          return false;
        }
        const op = model.operations.find((o) => o.name === e.opName);
        if (!op) {
          state.addNotification('error', "Noto'g'ri operatsiya", `«${e.opName}» ushbu model operatsiyalari ro'yxatida yo'q.`);
          return false;
        }
        const rate = e.rateSnapshot !== undefined && e.rateSnapshot > 0 ? e.rateSnapshot : (op?.rate || 0);
        validEntries.push({
          opName: e.opName,
          workerId: e.workerId,
          workerNameSnapshot: workerMap.get(e.workerId) || `#${e.workerId}`,
          rateSnapshot: rate
        });
      }
    }

    if (validEntries.length === 0) {
      state.addNotification('warning', 'Ishchilar kiritilmadi', "Hech bo'lmaganda bitta operatsiyaga ishchi ID sini kiriting.");
      return false;
    }

    // Adjust hisobQuantities:
    // Step 1: Revert old entries of this ticket
    const updatedHisobQuantities = { ...(model.hisobQuantities || {}) };
    for (const oldEntry of ticket.entries || []) {
      if (updatedHisobQuantities[oldEntry.workerId]) {
        const currentOps = { ...updatedHisobQuantities[oldEntry.workerId] };
        if (currentOps[oldEntry.opName] !== undefined) {
          currentOps[oldEntry.opName] = Math.max(0, currentOps[oldEntry.opName] - ticket.qty);
          if (currentOps[oldEntry.opName] === 0) {
            delete currentOps[oldEntry.opName];
          }
          if (Object.keys(currentOps).length === 0) {
            delete updatedHisobQuantities[oldEntry.workerId];
          } else {
            updatedHisobQuantities[oldEntry.workerId] = currentOps;
          }
        }
      }
    }

    // Step 2: Add new entries of this ticket
    for (const newEntry of validEntries) {
      const currentOps = { ...(updatedHisobQuantities[newEntry.workerId] || {}) };
      const curQty = currentOps[newEntry.opName] || 0;
      currentOps[newEntry.opName] = curQty + ticket.qty;
      updatedHisobQuantities[newEntry.workerId] = currentOps;
    }

    const updatedModels = state.models.map((m) => {
      if (m.id === ticket.modelId) {
        return {
          ...m,
          hisobQuantities: updatedHisobQuantities
        };
      }
      return m;
    });

    const updatedSubmittedTickets = (state.submittedTickets || []).map((s) => {
      if (s.id === ticketId) {
        return {
          ...s,
          entries: validEntries
        };
      }
      return s;
    });

    set({
      models: updatedModels,
      submittedTickets: updatedSubmittedTickets
    });

    if (!(await get().saveToDisk({
      models: updatedModels,
      submittedTickets: updatedSubmittedTickets,
      companyId: initialLicenseStatus?.companyId || undefined
    })) || get().licenseStatus !== initialLicenseStatus) return false;

    state.addNotification(
      'success',
      'Patta yangilandi',
      `Partiya ${ticket.partyNumber}, Patta #${ticket.pattaNumber} (${ticket.qty} dona) operatsiyalari va hisob-kitob summalari muvaffaqiyatli yangilandi!`
    );
    return true;
  }
  });
};
