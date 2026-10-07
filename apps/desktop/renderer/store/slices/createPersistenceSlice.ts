import { StateCreator } from 'zustand';
import { WorkbookStore, PersistenceSlice } from '../types';
import { Worker, ModelConfig } from '../../types/workbook';
import { DEFAULT_BATCH_SIZES } from '../../constants/batchConstants';
import { STORAGE_KEY } from '../../constants/sheetConstants';
import { exportWorkbookToExcel, exportWorkersListToExcel } from '../../engine/excelSync';
import {
  sanitizeWorkers,
  reconcileModelHisobQuantities
} from '../helpers/storeSanitizers';
import { formatDateIso, formatTashkentTimestampForFilename, getUzbekMonthName } from '../../utils/formatters';
import { useAuthStore } from '../authStore';
import { hydrateWorkbookData, isPayloadOwnedByCompany, isValidCompanyId } from '../helpers/hydration';
import { captureSessionIdentity, isSessionCurrent } from '../sessionGuard';
import { getElectronApi, resolveElectronRuntimeMode } from '../runtimeMode';
import { hasFocusedEditableControl, preserveWorkbookProjectionDrafts, runReconnect } from '../businessMutations';
import { findNextPartyNumber } from '../pattaBatch';

function notifyRejection(state: Pick<WorkbookStore, 'addNotification'>, code = '_COMMAND_REQUIRED', message?: string) {
  state.addNotification(
    'error',
    code,
    message || ' rejimi faol: bu o\'zgarish kanonik buyruq orqali bajarilishi kerak.'
  );
}

function hydrateSqliteProjection(companyData: any, currentCompanyId: string) {
  const hydrated = hydrateWorkbookData(companyData);
  const sourceModels = new Map<string, any>(
    (Array.isArray(companyData?.models) ? companyData.models : []).map((model: any) => [model.id, model])
  );
  return {
    ...hydrated,
    models: hydrated.models.map((model) => ({
      ...model,
      hisobQuantities: sourceModels.get(model.id)?.hisobQuantities || model.hisobQuantities
    })),
    companyId: currentCompanyId
  };
}

export const createPersistenceSlice: StateCreator<WorkbookStore, [], [], PersistenceSlice> = (set, get) => ({
  isSaving: false,
  isServerConnected: false,

  initStore: async (forcedCompanyId?: string) => {
    // App startup checks activation first, then invokes this once a company
    // activation exists. Keep the fallback for callers without loaded status.
    if (!get().licenseStatus) await get().checkLicense();
    const currentCompanyId = forcedCompanyId || get().licenseStatus?.companyId || useAuthStore.getState().companyId;
    if (!isValidCompanyId(currentCompanyId)) {
      get().addNotification('error', 'Korxona yo\'q', 'Yaroqli korxona konteksti topilmadi.');
      return;
    }
    const session = captureSessionIdentity(currentCompanyId);
    if (!session) return;
    const initialLicenseStatus = get().licenseStatus;
    const isCurrentCompany = () => {
      const currentLicenseStatus = get().licenseStatus;
      const licenseCompanyId = currentLicenseStatus?.companyId;
      const authCompanyId = useAuthStore.getState().companyId;
      return currentLicenseStatus?.activationId === initialLicenseStatus?.activationId
        && currentLicenseStatus?.machineId === initialLicenseStatus?.machineId
        && isSessionCurrent(session, licenseCompanyId || authCompanyId)
        && licenseCompanyId === currentCompanyId
        && (!authCompanyId || authCompanyId === currentCompanyId);
    };

    const eAPI = (window as any).electronAPI;

    // Electron IPC mode
    if (eAPI) {
      const runtime = await resolveElectronRuntimeMode(eAPI);
      if (runtime.mode === 'sync') {
        if (!runtime.success) {
          notifyRejection(get(), runtime.code || '_RUNTIME_NOT_READY', runtime.error);
          return;
        }
        if (typeof eAPI.dbRead !== 'function') {
          notifyRejection(get(), '_RUNTIME_NOT_READY', ' SQLite projection bridge is unavailable.');
          return;
        }
        try {
          if (typeof eAPI.SyncBootstrap !== 'function') {
            notifyRejection(get(), '_BOOTSTRAP_UNAVAILABLE', 'The authenticated  bootstrap bridge is unavailable.');
            return;
          }
          const bootstrap = await eAPI.SyncBootstrap(currentCompanyId);
          if (!bootstrap?.success) {
            notifyRejection(
              get(),
              bootstrap?.code || '_BOOTSTRAP_FAILED',
              bootstrap?.error || 'PostgreSQL authoritative bootstrap could not be completed.'
            );
            return;
          }
          const result = await eAPI.dbRead(currentCompanyId);
          if (!result?.success || !result.data || !isPayloadOwnedByCompany(result.data, currentCompanyId)) {
            notifyRejection(get(), result?.code || '_PROJECTION_READ_FAILED', result?.error || ' SQLite projection could not be loaded.');
            return;
          }
          if (!isCurrentCompany()) return;
          const hydrated = hydrateSqliteProjection(result.data, currentCompanyId);
          set({
            workers: hydrated.workers,
            models: hydrated.models,
            availableSizes: hydrated.availableSizes,
            nextPartyNumber: hydrated.nextPartyNumber,
            nextPattaNumber: hydrated.nextPattaNumber,
            reusablePattaRanges: hydrated.reusablePattaRanges,
            printedPartyHistory: hydrated.printedPartyHistory,
            submittedTickets: hydrated.submittedTickets,
            currentPeriod: hydrated.currentPeriod,
            periods: hydrated.periods,
            ticketForms: hydrated.ticketForms,
            pattaBatchConfigs: hydrated.pattaBatchConfigs,
            deletedTicketIds: hydrated.deletedTicketIds,
            deletedPartyIds: hydrated.deletedPartyIds,
            deletedWorkerIds: hydrated.deletedWorkerIds,
            deletedModelIds: hydrated.deletedModelIds,
            isServerConnected: false
          });
          if (typeof eAPI.SyncReconnect === 'function') {
            void runReconnect(eAPI, currentCompanyId).then(async (syncResult: any) => {
              if (!isCurrentCompany()) return;
              if (!syncResult?.success) {
                set({ isServerConnected: false });
                return;
              }
              const refreshed = await eAPI.dbRead(currentCompanyId);
              if (!isCurrentCompany() || !refreshed?.success || !refreshed.data || !isPayloadOwnedByCompany(refreshed.data, currentCompanyId)) return;
              const latest = preserveWorkbookProjectionDrafts(
                hydrateSqliteProjection(refreshed.data, currentCompanyId),
                get(),
                hasFocusedEditableControl()
              );
              set({
                workers: latest.workers,
                models: latest.models,
                availableSizes: latest.availableSizes,
                nextPartyNumber: latest.nextPartyNumber,
                nextPattaNumber: latest.nextPattaNumber,
                reusablePattaRanges: latest.reusablePattaRanges,
                printedPartyHistory: latest.printedPartyHistory,
                submittedTickets: latest.submittedTickets,
                currentPeriod: latest.currentPeriod,
                periods: latest.periods,
                ticketForms: latest.ticketForms,
                pattaBatchConfigs: latest.pattaBatchConfigs,
                deletedTicketIds: latest.deletedTicketIds,
                deletedPartyIds: latest.deletedPartyIds,
                deletedWorkerIds: latest.deletedWorkerIds,
                deletedModelIds: latest.deletedModelIds,
                isServerConnected: true
              });
            }).catch(() => {
              if (isCurrentCompany()) set({ isServerConnected: false });
            });
          }
        } catch (error) {
          notifyRejection(
            get(),
            '_PROJECTION_READ_FAILED',
            error instanceof Error ? error.message : ' SQLite projection could not be loaded.'
          );
        }
        return;
      }

      try {
        const result = await eAPI.dbRead(currentCompanyId);
        if (!isCurrentCompany()) return;
        let companyData = result?.success && result.data ? result.data : null;

        // Local data truly belongs to this company
        if (companyData && !isPayloadOwnedByCompany(companyData, currentCompanyId)) {
          companyData = null;
        }

        const isLocalEmpty =
          !companyData ||
          ((!companyData.models || companyData.models.length === 0) &&
           (!companyData.submittedTickets || companyData.submittedTickets.length === 0) &&
           (!companyData.printedPartyHistory || companyData.printedPartyHistory.length === 0));

        if (isLocalEmpty && currentCompanyId && currentCompanyId !== 'unassigned') {
          // A new company with no local projection starts with an empty local state.
          console.log(`[Store] Yangi korxona (${currentCompanyId}) uchun toza, bo'sh baza ochilmoqda...`);
          const cleanModels: ModelConfig[] = [];
          const cleanWorkers: Worker[] = [];
          const nextParty = 1;
          const customSizes = [...DEFAULT_BATCH_SIZES];
          const freshPeriod = {
            id: 'period_default',
            name: getUzbekMonthName(),
            startDate: `${formatDateIso().slice(0, 7)}-01`,
            isClosed: false
          };

          const freshState: Partial<WorkbookStore> = {
            workers: cleanWorkers,
            models: cleanModels,
            availableSizes: customSizes,
            nextPartyNumber: nextParty,
            nextPattaNumber: 1,
            reusablePattaRanges: [],
            printedPartyHistory: [],
            submittedTickets: [],
            currentPeriod: freshPeriod,
            periods: [],
            ticketForms: {},
            pattaBatchConfigs: {},
            activeSheet: 'Patta-Hisob',
            isServerConnected: true
          };

           if (!isCurrentCompany()) return;
           set(freshState);

           if (eAPI.dbWrite) {
             await eAPI.dbWrite({ ...freshState, companyId: currentCompanyId }, { companyId: currentCompanyId });
           }
          return;
        }

        if (companyData) {
          const hydrated = hydrateWorkbookData(companyData);
          const cleanModels = hydrated.models;
          const subTickets = hydrated.submittedTickets;
          const cleanHistory = hydrated.printedPartyHistory;
          const nextParty = findNextPartyNumber(cleanHistory);
          const customSizes = hydrated.availableSizes;

          set({
            workers: hydrated.workers,
            models: cleanModels,
            availableSizes: customSizes,
            nextPartyNumber: nextParty,
            nextPattaNumber: hydrated.nextPattaNumber,
            reusablePattaRanges: hydrated.reusablePattaRanges,
            printedPartyHistory: cleanHistory,
            submittedTickets: subTickets,
            currentPeriod: hydrated.currentPeriod,
            periods: hydrated.periods,
            ticketForms: hydrated.ticketForms,
            pattaBatchConfigs: hydrated.pattaBatchConfigs,
            deletedTicketIds: hydrated.deletedTicketIds,
            deletedPartyIds: hydrated.deletedPartyIds,
            deletedWorkerIds: hydrated.deletedWorkerIds,
            deletedModelIds: hydrated.deletedModelIds,
            isServerConnected: true
          });
          console.log(`[Store] Loaded via Electron IPC for [${currentCompanyId}].`);

          return;
        }
      } catch (e) {
        console.warn('[Store] Electron IPC read failed', e);
      }
      return;
    }

    // Web / HTTP mode uses the same normalization rules as Electron mode.
    try {
      const res = await fetch('/api/data');
      if (res.ok) {
        const json = await res.json();
         if (isCurrentCompany() && json.success && json.data && isPayloadOwnedByCompany(json.data, currentCompanyId)) {
          const hydrated = hydrateWorkbookData(json.data);
          set({
            ...hydrated,
            isServerConnected: true
          });
          return;
        }
      }
    } catch (e) {
      console.warn('[Store] HTTP API not reachable, falling back to localStorage.', e);
    }

    // Fallback to local storage
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
          if (isCurrentCompany() && isPayloadOwnedByCompany(parsed, currentCompanyId)) {
           const hydrated = hydrateWorkbookData(parsed);
           set({
             ...hydrated,
             isServerConnected: false
           });
         } else {
           console.warn('[Store] Local persisted data ownership mismatch or unknown legacy ownership; hydration skipped.');
         }
      }
    } catch (e) {
      console.error('Error reading localStorage', e);
    }
  },

  saveToDisk: async (overrideState, options) => {
    const state = get();
    const activeCompanyId = overrideState?.companyId || options?.companyId || state.licenseStatus?.companyId || useAuthStore.getState().companyId;
    const session = captureSessionIdentity(activeCompanyId);
    const isSaveCurrent = () => isSessionCurrent(
      session,
      get().licenseStatus?.companyId || useAuthStore.getState().companyId
    );
    if (!session || !isSaveCurrent()) return false;
    const rawTickets = overrideState?.submittedTickets || state.submittedTickets || [];
    let rawModels = overrideState?.models || state.models;
    if (!options?.skipReconcile) {
      rawModels = reconcileModelHisobQuantities(rawModels, rawTickets);
    }

    const payload = {
      companyId: activeCompanyId,
      workers: sanitizeWorkers(overrideState?.workers || state.workers),
      models: rawModels,
      availableSizes: overrideState?.availableSizes || state.availableSizes || [...DEFAULT_BATCH_SIZES],
      ticketForms: overrideState?.ticketForms || state.ticketForms,
      pattaBatchConfigs: overrideState?.pattaBatchConfigs || state.pattaBatchConfigs,
      nextPartyNumber:
        overrideState?.nextPartyNumber !== undefined
          ? overrideState.nextPartyNumber
          : state.nextPartyNumber || 1,
      nextPattaNumber:
        overrideState?.nextPattaNumber !== undefined
          ? overrideState.nextPattaNumber
          : state.nextPattaNumber || 1,
      reusablePattaRanges: overrideState?.reusablePattaRanges || state.reusablePattaRanges || [],
      printedPartyHistory: overrideState?.printedPartyHistory || state.printedPartyHistory || [],
      submittedTickets: rawTickets,
      currentPeriod: overrideState?.currentPeriod || state.currentPeriod,
      periods: overrideState?.periods || state.periods,
      deletedTicketIds: overrideState?.deletedTicketIds || state.deletedTicketIds || [],
      deletedPartyIds: overrideState?.deletedPartyIds || state.deletedPartyIds || [],
      deletedWorkerIds: overrideState?.deletedWorkerIds || state.deletedWorkerIds || [],
      deletedModelIds: overrideState?.deletedModelIds || state.deletedModelIds || []
    };

    const eAPI = (window as any).electronAPI;
    const runtime = await resolveElectronRuntimeMode(eAPI);

    if (runtime.mode === 'sync') {
      notifyRejection(get(), runtime.code || '_COMMAND_REQUIRED', runtime.success ? undefined : runtime.error);
      return false;
    }

    // Electron IPC mode - asynchronous serialized disk persistence
    if (eAPI) {
      let result: any;
      try {
        const companyId = activeCompanyId;
        if (!isValidCompanyId(companyId)) throw new Error('Local persistence company context is invalid');
        if (!isSaveCurrent()) return false;
        const writeOpts = { ...options, companyId };
        if (overrideState && !options?.forceBackup && eAPI.dbPatch) {
          result = await eAPI.dbPatch({ ...overrideState, companyId }, writeOpts);
        } else {
          result = await eAPI.dbWrite({ ...payload, companyId }, writeOpts);
        }
        if (!isSaveCurrent()) return false;
        if (result?.success) {
          if (!state.isServerConnected) {
            set({ isServerConnected: true });
          }
        } else {
          console.error('[Store] Electron IPC write failed:', result?.error);
          state.addNotification('error', 'Saqlash xatosi', result?.error || "Mahalliy diskka saqlab bo'lmadi");
        }
      } catch (e: any) {
        if (!isSaveCurrent()) return false;
        console.warn('[Store] Electron IPC write exception:', e);
        state.addNotification('error', 'Disk xatosi', e?.message || "Mahalliy diskka yozishda uzilish yuz berdi");
        return false;
      }
      return Boolean(result?.success);
    }

    // Web / HTTP mode
    try {
      if (!isSaveCurrent()) return false;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      if (!isSaveCurrent()) return false;
      const response = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`HTTP persistence failed: ${response.status}`);
      if (!isSaveCurrent()) return false;
      if (!state.isServerConnected) set({ isServerConnected: true });
      return true;
    } catch (e) {
      if (!isSaveCurrent()) return false;
      console.warn('[Store] Web fallback save failed', e);
      state.addNotification('error', 'Saqlash xatosi', e instanceof Error ? e.message : 'Web bazaga saqlab bo\'lmadi');
      return false;
    }
  },

  exportExcel: () => {
    const { models, workers } = get();
    exportWorkbookToExcel(models, workers);
    get().addNotification('success', 'Yuklab olindi', 'Excel (.xlsx) fayli muvaffaqiyatli saqlandi!');
  },

  exportWorkersExcel: () => {
    const { workers } = get();
    exportWorkersListToExcel(workers);
    get().addNotification('success', 'Yuklab olindi', "Ishchilar ro'yxati Excel (.xlsx) fayli muvaffaqiyatli saqlandi!");
  },

  resetToOriginal: async () => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const companyId = state.licenseStatus?.companyId || useAuthStore.getState().companyId || undefined;
    const isCurrentResetSession = () => get().licenseStatus === initialLicenseStatus
      && get().licenseStatus?.companyId === companyId
      && (!useAuthStore.getState().companyId || useAuthStore.getState().companyId === companyId);
    const eAPI = getElectronApi();
    const runtime = await resolveElectronRuntimeMode(eAPI);
    if (runtime.mode === 'sync') {
      notifyRejection(get(), runtime.code || '_COMMAND_UNSUPPORTED', runtime.success ? undefined : runtime.error);
      return false;
    }
    if (!isCurrentResetSession()) return false;
    const ok = await state.confirmAction({
      title: "Dastlabki holatga qaytarish",
      message: "Haqiqatan ham barcha hisob-kitoblarni dastlabki (toza) holatga qaytarmoqchimisiz?\n\nESLATMA: Barcha mavjud modellar va ishchilar to'liq saqlanadi, faqat kiritilgan sonlar va hisob-kitoblar nollanadi.\nJoriy barcha ma'lumotlaringiz xavfsizlik uchun avtomatik 'Zaxiralar' ro'yxatiga to'liq saqlanadi.",
      confirmText: "Ha, tozalansin",
      isDanger: true
    });

    if (!ok) {
      return false;
    }

    set({ loadingMessage: 'Dastlabki holatga keltirilmoqda...' });

    try {
      // 1. Automatically create pre-reset backup
      const ts = formatTashkentTimestampForFilename();
      const backupFilename = `backup_before_reset_${ts}.json`;

      const currentDb = {
        workers: state.workers,
        models: state.models,
        ticketForms: state.ticketForms,
        pattaBatchConfigs: state.pattaBatchConfigs,
        submittedTickets: state.submittedTickets,
        printedPartyHistory: state.printedPartyHistory,
        currentPeriod: state.currentPeriod,
        periods: state.periods
      };

      if (eAPI && eAPI.archiveSave) {
        const backupResult = await eAPI.archiveSave(backupFilename, currentDb, companyId);
        if (!backupResult?.success) {
          state.addNotification('error', 'Zaxira xatosi', backupResult?.error || 'Resetdan oldingi zaxira yaratilmadi.');
          return false;
        }
      }
      if (!isCurrentResetSession()) return false;

      // 2. Perform clean reset PRESERVING ALL user-created models, operations and workers
      const cleanModels = state.models.map((m) => ({
        ...m,
        hisobQuantities: {}
      }));

      const cleanWorkers = state.workers.map((w) => ({
        ...w,
        avans: 0,
        jarima: 0
      }));

      const cleanForms: Record<string, any> = {};
      for (const m of cleanModels) {
        cleanForms[m.id] = {
          date: formatDateIso(),
          party: '',
          color: m.color || 'Кора',
          size: m.size || 'M',
          qty: '',
          patta: '1',
          entries: {}
        };
      }

      const cleanBatches: Record<string, any> = {};
      for (const m of cleanModels) {
        cleanBatches[m.id] = {
          partyNumber: '1',
          totalIshSoni: '',
          color: m.color || 'Кора',
          sizes: {}
        };
      }

      const firstSheetName = cleanModels[0]?.name || 'Umumiy';
      const newState = {
        workers: cleanWorkers,
        models: cleanModels,
        ticketForms: cleanForms,
        pattaBatchConfigs: state.pattaBatchConfigs || cleanBatches,
        submittedTickets: state.submittedTickets || [],
        printedPartyHistory: state.printedPartyHistory || [],
        nextPartyNumber: state.nextPartyNumber || 1,
        nextPattaNumber: state.nextPattaNumber || 1,
        reusablePattaRanges: state.reusablePattaRanges || [],
        activeSheet: firstSheetName,
        companyId,
        activeCell: {
          cellId: 'A3',
          sheetName: firstSheetName,
          value: '',
          formula: ''
        }
      };

      if (!isCurrentResetSession()) return false;
      set(newState);
      if (!(await get().saveToDisk(newState)) || !isCurrentResetSession()) return false;
      get().addNotification(
        'success',
        'Tozalandi',
        "Hisob-kitoblar dastlabki holatga keltirildi. Barcha modellar, ishchilar va Pattalar monitoringi to'liq saqlab qolindi."
      );
      return true;
    } catch (err) {
      console.error('Reset error:', err);
      return false;
    } finally {
      setTimeout(() => {
        set({ loadingMessage: null });
      }, 400);
    }
  },

  restoreFromVps: async (targetCompanyId?: string) => {
    const licensedCompanyId = get().licenseStatus?.companyId || useAuthStore.getState().companyId;
    const compId = targetCompanyId || licensedCompanyId;
    if (!isValidCompanyId(compId) || (targetCompanyId !== undefined && targetCompanyId !== licensedCompanyId)) {
      get().addNotification('warning', 'Korxona yo\'q', 'Ushbu kompyuterga korxona biriktirilmagan!');
      return { success: false, message: 'Korxona biriktirilmagan' };
    }
    const session = captureSessionIdentity(compId);
    if (!session) return { success: false, message: 'Company session unavailable' };

    const eAPI = getElectronApi();
    try {
      get().setLoadingMessage(`${compId} serverdan ma'lumotlar tiklanmoqda...`);
      const runtime = await resolveElectronRuntimeMode(eAPI);
      if (runtime.mode !== 'sync' || !runtime.success) {
        throw new Error(runtime.error || runtime.code || 'Authenticated VPS runtime is unavailable');
      }
      if (typeof eAPI?.SyncBootstrap !== 'function' || typeof eAPI?.dbRead !== 'function') {
        throw new Error('Authenticated VPS restore bridge is unavailable');
      }
      const bootstrap = await eAPI.SyncBootstrap(compId);
      const currentLicensedCompany = get().licenseStatus?.companyId;
      const currentAuthCompany = useAuthStore.getState().companyId;
      if (
        !isSessionCurrent(session, currentLicensedCompany || currentAuthCompany)
        || currentLicensedCompany !== compId
        || (currentAuthCompany && currentAuthCompany !== compId)
      ) {
        return { success: false, message: 'Company changed while server restore was in flight' };
      }
      if (!bootstrap?.success) {
        throw new Error(bootstrap?.error || bootstrap?.code || 'The VPS bootstrap could not be completed');
      }
      if (typeof eAPI.SyncReconnect !== 'function') {
        throw new Error('Authenticated VPS reconnect bridge is unavailable');
      }
      const reconnect = await eAPI.SyncReconnect(compId);
      if (!reconnect?.success) {
        throw new Error(reconnect?.error || reconnect?.code || 'The VPS change feed could not be applied');
      }
      const result = await eAPI.dbRead(compId);
      if (!result?.success || !isPayloadOwnedByCompany(result.data, compId)) {
        throw new Error(result?.error || result?.code || 'The VPS projection is unavailable or belongs to another company');
      }
      const latestCompany = get().licenseStatus?.companyId;
      if (!isSessionCurrent(session, latestCompany || useAuthStore.getState().companyId)) {
        return { success: false, message: 'Company changed before server restore was applied' };
      }
      const hydrated = hydrateSqliteProjection(result.data, compId);
      set({ ...hydrated, isServerConnected: true });
      get().addNotification('success', 'Serverdan tiklandi', `[${compId}] korxonasining VPS ma'lumotlari tiklandi.`);
      return { success: true };
    } catch (err: any) {
      console.error('[Store] Serverdan tiklash xatosi:', err);
      get().addNotification('error', 'Xatolik', err.message || 'VPS ma\'lumotlarini tiklashda xatolik yuz berdi');
      return { success: false, message: err.message };
    } finally {
      get().setLoadingMessage(null);
    }
  }
});
