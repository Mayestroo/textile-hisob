import { create } from 'zustand';
import { WorkbookStore } from './types';
import { createUiSlice } from './slices/createUiSlice';
import { createLicenseSlice } from './slices/createLicenseSlice';
import { createWorkerSlice } from './slices/createWorkerSlice';
import { createPeriodSlice } from './slices/createPeriodSlice';
import { createModelSlice } from './slices/createModelSlice';
import { createPattaBatchSlice } from './slices/createPattaBatchSlice';
import { createTicketSlice } from './slices/createTicketSlice';
import { createPersistenceSlice } from './slices/createPersistenceSlice';
import { getElectronApi, resolveElectronRuntimeMode } from './runtimeMode';
import { cancelDebouncedSave, triggerDebouncedSave } from './helpers/debounceSave';
import { DEFAULT_BATCH_SIZES } from '../constants/batchConstants';
import { buildBatchSettingsPayload, buildBatchPrintMutation, buildPartySummary } from './pattaBatch';
import { createWorkbookCommand, submitWorkbookCommand } from './businessMutations';
import { normalizePattaSizeCounts } from '../domain/pattaQuantity';

export const useWorkbookStore = create<WorkbookStore>((...args) => {
  const [set, get] = args;
  const slices = {
    ...createUiSlice(...args),
    ...createLicenseSlice(...args),
    ...createWorkerSlice(...args),
    ...createPeriodSlice(...args),
    ...createModelSlice(...args),
    ...createPattaBatchSlice(...args),
    ...createTicketSlice(...args),
    ...createPersistenceSlice(...args)
  } as WorkbookStore;

  const getContext = async () => {
    const state = get();
    const runtime = await resolveElectronRuntimeMode(getElectronApi());
    if (runtime.mode === 'legacy') return null;
    if (!runtime.success) {
      state.addNotification('error', runtime.code || '_RUNTIME_NOT_READY', runtime.error || ' runtime readiness failed.');
      return { companyId: '', licenseStatus: state.licenseStatus, success: false as const };
    }
    const companyId = state.licenseStatus?.companyId;
    if (!companyId) {
      state.addNotification('error', '_RUNTIME_NOT_READY', 'A company binding is required for  party and batch changes.');
      return { companyId: '', licenseStatus: state.licenseStatus, success: false as const };
    }
    return { companyId, licenseStatus: state.licenseStatus, success: true as const };
  };

  const submit = async (context: { companyId: string; licenseStatus: WorkbookStore['licenseStatus']; success: true }, commandType: any, entityId: string, payload: Record<string, any>) => {
    const result = await submitWorkbookCommand(
      createWorkbookCommand(commandType, context.companyId, entityId, payload),
      get,
      set
    );
    if (!result.success) slices.addNotification('error', result.code || '_COMMAND_REJECTED', result.error || ' party or batch command was rejected.');
    return result.success;
  };

  const batchTimerKey = (companyId: string) => `_batch_settings_${companyId}`;
  const scheduleBatchSettings = (context: { companyId: string; licenseStatus: WorkbookStore['licenseStatus']; success: true }) => {
    triggerDebouncedSave(() => {
      const current = get();
      if (current.licenseStatus !== context.licenseStatus) return;
      const command = createWorkbookCommand(
        'UpdateBatchSettings',
        context.companyId,
        context.companyId,
        buildBatchSettingsPayload(current)
      );
      void submitWorkbookCommand(command, get, set).then((result) => {
        if (!result.success && get().licenseStatus === context.licenseStatus) {
          get().addNotification('error', result.code || '_BATCH_SETTINGS_FAILED', result.error || 'Batch settings were not saved.');
        }
      }).catch((error) => {
        if (get().licenseStatus === context.licenseStatus) get().addNotification('error', '_BATCH_SETTINGS_FAILED', error instanceof Error ? error.message : 'Batch settings were not saved.');
      });
    }, 1200, batchTimerKey(context.companyId), () => get().licenseStatus === context.licenseStatus);
  };

  return {
    ...slices,
    addCustomSize: async (sizeName: string) => {
      const context = await getContext();
      if (!context) return slices.addCustomSize(sizeName);
      if (!context.success) return;
      const clean = sizeName.trim().toUpperCase();
      const current = get().availableSizes || DEFAULT_BATCH_SIZES;
      if (!clean) return;
      if (current.some((size) => size.toLowerCase() === clean.toLowerCase())) {
        get().addNotification('warning', 'Mavjud razmer', `«${clean}» razmeri allaqachon mavjud.`);
        return;
      }
      set({ availableSizes: [...current, clean] });
      scheduleBatchSettings(context);
    },
    deleteCustomSize: async (sizeName: string) => {
      const context = await getContext();
      if (!context) return slices.deleteCustomSize(sizeName);
      if (!context.success) return;
      const clean = sizeName.trim().toUpperCase();
      const updated = (get().availableSizes || DEFAULT_BATCH_SIZES).filter((size) => size.toUpperCase() !== clean);
      set({ availableSizes: updated });
      scheduleBatchSettings(context);
    },
    incrementPartyNumber: async (modelId: string, printedPartyStr: string) => {
      const context = await getContext();
      if (!context) return slices.incrementPartyNumber(modelId, printedPartyStr);
      if (!context.success) return;
      const state = get();
      const nextPartyNumber = (Number.parseInt(printedPartyStr, 10) || 1) + 1;
      const configs: Record<string, any> = {};
      for (const model of state.models) {
        const current = state.pattaBatchConfigs[model.id];
        const target = model.id === modelId;
        const sizes: Record<string, string> = {};
        for (const size of state.availableSizes || DEFAULT_BATCH_SIZES) sizes[size] = target ? '' : current?.sizes?.[size] || '';
        configs[model.id] = {
          partyNumber: target ? '' : (current?.isCustomParty ? current.partyNumber : ''),
          isCustomParty: target ? false : Boolean(current?.isCustomParty),
          totalIshSoni: target ? '' : current?.totalIshSoni || '',
          color: current?.color || model.color || 'Кора',
          sizes
        };
      }
      set({ nextPartyNumber, pattaBatchConfigs: configs });
      scheduleBatchSettings(context);
    },
    updatePattaBatchConfig: async (modelId: string, updates: any) => {
      const context = await getContext();
      if (!context) return slices.updatePattaBatchConfig(modelId, updates);
      if (!context.success) return;
      const state = get();
      const model = state.models.find((item) => item.id === modelId);
      if (!model) {
        get().addNotification('error', 'MODEL_NOT_FOUND', `Model "${modelId}" was not found.`);
        return;
      }
      const current = state.pattaBatchConfigs[modelId] || { partyNumber: '', totalIshSoni: '', color: model.color || 'Кора', sizes: {} };
      set({ pattaBatchConfigs: { ...state.pattaBatchConfigs, [modelId]: { ...current, ...updates } } });
      scheduleBatchSettings(context);
    },
    updatePattaBatchSize: async (modelId: string, size: string, count: string) => {
      // Keep the controlled input responsive while the sync context is being
      // resolved. Multiple keystrokes can otherwise complete out of order and
      // overwrite newer values with an older snapshot.
      const immediateState = get();
      const immediateModel = immediateState.models.find((item) => item.id === modelId);
      if (immediateModel) {
        const current = immediateState.pattaBatchConfigs[modelId] || { partyNumber: '', totalIshSoni: '', color: immediateModel.color || 'Кора', sizes: {} };
        set({ pattaBatchConfigs: { ...immediateState.pattaBatchConfigs, [modelId]: { ...current, sizes: { ...(current.sizes || {}), [size]: count } } } });
      }
      const context = await getContext();
      if (!context) return slices.updatePattaBatchSize(modelId, size, count);
      if (!context.success) return;
      scheduleBatchSettings(context);
    },
    addPrintedPartyRecord: async (item: Parameters<WorkbookStore['addPrintedPartyRecord']>[0]) => {
      const context = await getContext();
      if (!context) return slices.addPrintedPartyRecord(item);
      if (!context.success) return;
      const state = get();
      const party = buildPartySummary(state, item);
      const existing = state.printedPartyHistory.some((row) => row.id === party.id);
      const commandType = existing ? 'UpdateParty' : 'CreateParty';
      const payload = {
        partyRecordId: party.id,
        partyNumber: party.partyNumber,
        physicalPartyNumber: party.partyNumber,
        modelId: party.modelId,
        modelName: party.modelName,
        color: party.color,
        pattaCount: party.pattaCount,
        cumulativePattaCount: party.cumulativePattaCount,
        ishSoniPerPatta: party.ishSoniPerPatta || 0,
        totalIshSoni: party.totalIshSoni || party.ishSoni,
        ishSoni: party.ishSoni,
        cumulativeIshSoni: party.cumulativeIshSoni,
        sizes: {},
        printedAt: party.printedAt
      };
      const success = await submit(context, commandType, party.id, payload);
      if (success) get().addNotification('success', 'Partiya saqlandi', `Partiya ${party.partyNumber}  bazasida saqlandi.`);
    },
    batchPrintCompleted: async (printedItems: Parameters<WorkbookStore['batchPrintCompleted']>[0]) => {
      const context = await getContext();
      if (!context) return slices.batchPrintCompleted(printedItems);
      if (!context.success) return;
      cancelDebouncedSave(batchTimerKey(context.companyId));
      try {
        const mutation = buildBatchPrintMutation(get(), printedItems);
        const parties = mutation.parties.map((party) => {
          const normalizedSizes = normalizePattaSizeCounts(party.sizes);
          if (normalizedSizes.pattaCount !== party.pattaCount) {
            throw new Error('INVALID_PATTA_SIZE_TOTAL');
          }
          return { ...party, sizes: normalizedSizes.sizes };
        });
        const success = await submit(context, 'CompletePattaBatch', mutation.batchId, {
          batchId: mutation.batchId,
          parties,
          availableSizes: mutation.settings.availableSizes,
          configs: mutation.settings.configs
        });
        if (success) {
          set({ nextPartyNumber: mutation.nextPartyNumber, deletedPartyIds: mutation.deletedPartyIds });
          get().addNotification('success', 'Pattalar saqlandi', `${mutation.parties.length} ta partiya  bazasiga saqlandi.`);
        }
      } catch (error) {
        get().addNotification('error', '_BATCH_INVALID', error instanceof Error ? error.message : 'Patta batch was invalid.');
      }
    },
    deletePrintedPartyRecord: async (id: string) => {
      const context = await getContext();
      if (!context) return slices.deletePrintedPartyRecord(id);
      if (!context.success) return;
      const success = await submit(context, 'ArchivePartyHistory', context.companyId, { partyRecordIds: [id] });
      if (success) get().addNotification('info', "Partiya arxivlandi", 'Partiya tarixdan yashirildi; kanonik yozuv saqlanib qoldi.');
    },
    clearPrintedPartyHistory: async () => {
      const context = await getContext();
      if (!context) return slices.clearPrintedPartyHistory();
      if (!context.success) return;
      const ids = get().printedPartyHistory.map((party) => party.id);
      if (!ids.length) return;
      const confirmed = await get().confirmAction({
        title: "Chop etish tarixini arxivlash",
        message: 'Barcha ko‘rinadigan partiya yozuvlarini arxivlab yashirmoqchimisiz? Kanonik ma’lumotlar saqlanadi.',
        confirmText: 'Ha, arxivlansin',
        isDanger: true
      });
      if (!confirmed) return;
      const success = await submit(context, 'ArchivePartyHistory', context.companyId, { partyRecordIds: ids });
      if (success) get().addNotification('success', 'Tarix arxivlandi', 'Partiya yozuvlari saqlandi va ko‘rinadigan ro‘yxatdan olindi.');
    },
    confirmPartyActualQuantities: async (partyRecordId: string) => {
      const context = await getContext();
      if (!context) return slices.confirmPartyActualQuantities(partyRecordId);
      if (!context.success) return;
      const state = get();
      const party = state.printedPartyHistory.find((row) => row.id === partyRecordId);
      if (!party) {
        get().addNotification('error', 'PARTY_NOT_FOUND', `Party "${partyRecordId}" was not found.`);
        return;
      }
      const related = state.submittedTickets.filter((ticket) => ticket.modelId === party.modelId && String(ticket.partyNumber) === String(party.partyNumber));
      if (!related.length) {
        get().addNotification('warning', "Pattalar yo'q", 'Ushbu partiya uchun hali birorta ham patta kiritilmagan.');
        return;
      }
      const total = related.reduce((sum, ticket) => sum + Number(ticket.qty || 0), 0);
      const perPatta = party.pattaCount > 0 ? Math.round(total / party.pattaCount) : total;
      const success = await submit(context, 'UpdateParty', party.id, {
        partyRecordId: party.id,
        partyNumber: party.partyNumber,
        physicalPartyNumber: party.partyNumber,
        modelId: party.modelId,
        modelName: party.modelName,
        color: party.color,
        pattaCount: party.pattaCount,
        cumulativePattaCount: party.cumulativePattaCount,
        ishSoniPerPatta: perPatta,
        totalIshSoni: total,
        ishSoni: total,
        cumulativeIshSoni: party.cumulativeIshSoni,
        sizes: party.sizes || {},
        printedAt: party.printedAt
      });
      if (success) get().addNotification('success', 'Tasdiqlandi!', `Partiya ${party.partyNumber} haqiqiy ish soni  bazasida yangilandi.`);
    },
    completePartySeries: async () => {
      const context = await getContext();
      if (!context) return slices.completePartySeries();
      if (!context.success) return;
      const periodId = get().periods.find((period) => !period.isClosed)?.id;
      if (!periodId) {
        get().addNotification('error', 'PERIOD_NOT_FOUND', 'Ochiq davr topilmadi; partiya seriyasini yakunlab bo‘lmadi.');
        return;
      }
      const success = await submit(context, 'CompletePartySeries', periodId, { periodId, endDate: new Date().toISOString().slice(0, 10) });
      if (success) get().addNotification('success', 'Partiya yakunlandi', 'Faol partiya va pattalar  bazasida yakunlandi.');
    }
  } as WorkbookStore;
});

// Re-export constants and types for complete backward compatibility
export { DEFAULT_BATCH_SIZES } from '../constants/batchConstants';
export type { WorkbookStore, ActiveCellInfo, ModalState } from './types';
export default useWorkbookStore;
