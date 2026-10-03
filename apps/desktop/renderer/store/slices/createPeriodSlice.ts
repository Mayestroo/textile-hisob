import { StateCreator } from 'zustand';
import { WorkbookStore, PeriodSlice } from '../types';
import { createInitialTicketForms } from '../helpers/storeSanitizers';
import { buildPartyTicketsList } from '../../domain/partyAnalytics';
import { DEFAULT_BATCH_SIZES } from '../../constants/batchConstants';
import { PrintedPartyRecord, SubmittedTicketRecord } from '../../types/workbook';
import { formatDateIso, getUzbekMonthName } from '../../utils/formatters';
import { getElectronApi, resolveElectronRuntimeMode } from '../runtimeMode';
import { createWorkbookCommand, localCommitSyncNotice, submitWorkbookCommand } from '../businessMutations';

const defaultStartDate = `${formatDateIso().slice(0, 7)}-01`;
const defaultPeriodName = getUzbekMonthName(defaultStartDate);

async function submitPeriodMutation(
  state: Pick<WorkbookStore, 'addNotification' | 'licenseStatus'>,
  get: () => WorkbookStore,
  set: (partial: Partial<WorkbookStore>) => void,
  commandType: 'CreatePeriod' | 'UpdatePeriod' | 'ClosePeriod',
  periodId: string,
  payload: Record<string, any>,
  localArchive?: unknown
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
    state.addNotification('error', '_RUNTIME_NOT_READY', 'A company binding is required for  period changes.');
    return { handled: true, success: false };
  }
  const result = await submitWorkbookCommand(
    createWorkbookCommand(commandType, companyId, periodId, payload, localArchive),
    get,
    set
  );
  if (!result.success) {
    state.addNotification('error', result.code || '_COMMAND_REJECTED', result.error || ' period change was rejected.');
    return { handled: true, success: false };
  }
  return { handled: true, success: true };
}

export const createPeriodSlice: StateCreator<WorkbookStore, [], [], PeriodSlice> = (set, get) => ({
  currentPeriod: {
    id: 'period_default',
    name: defaultPeriodName,
    startDate: defaultStartDate,
    isClosed: false
  },
  periods: [],
  selectedArchiveFilename: null,
  selectedArchiveData: null,

  startNewPeriod: async (name: string, startDate: string) => {
    const state = get();
    const newPeriod = {
      id: `period_${Date.now()}`,
      name: name.trim() || getUzbekMonthName(startDate),
      startDate: startDate || formatDateIso(),
      isClosed: false
    };

    const sync = await submitPeriodMutation(state, get, set, 'CreatePeriod', newPeriod.id, {
      periodId: newPeriod.id,
      name: newPeriod.name,
      startDate: newPeriod.startDate
    });
    if (sync?.handled) {
      if (sync.success) state.addNotification('info', 'Sinxronlash navbatda', localCommitSyncNotice(`"${newPeriod.name}" davri yaratildi (${newPeriod.startDate}).`));
      return sync.success;
    }

    set({
      currentPeriod: newPeriod,
      selectedArchiveFilename: null,
      selectedArchiveData: null
    });
    if (!(await state.saveToDisk({ currentPeriod: newPeriod, companyId: state.licenseStatus?.companyId }))) return false;
    state.addNotification('success', 'Yangi davr boshlandi', `"${newPeriod.name}" davri ochildi (${newPeriod.startDate}).`);
    return true;
  },

  updateCurrentPeriod: async (name: string, startDate: string) => {
    const state = get();
    const cleanDate = startDate || state.currentPeriod.startDate;
    const cleanName = name.trim() || state.currentPeriod.name || getUzbekMonthName(cleanDate);
    const updated = {
      ...state.currentPeriod,
      name: cleanName,
      startDate: cleanDate
    };
    const sync = await submitPeriodMutation(state, get, set, 'UpdatePeriod', updated.id, {
      periodId: updated.id,
      name: cleanName,
      startDate: cleanDate
    });
    if (sync?.handled) {
      if (sync.success) state.addNotification('info', 'Sinxronlash navbatda', localCommitSyncNotice(`Joriy davr "${updated.name}" deb yangilandi.`));
      return sync.success;
    }
    set({ currentPeriod: updated });
    if (!(await state.saveToDisk({ currentPeriod: updated, companyId: state.licenseStatus?.companyId }))) return false;
    state.addNotification('success', 'Davr yangilandi', `Joriy oylik "${updated.name}" deb saqlandi (${updated.startDate}).`);
    return true;
  },

  loadArchivedPeriod: async (filename: string | null) => {
    const state = get();
    if (!filename) {
      set({ selectedArchiveFilename: null, selectedArchiveData: null });
      return;
    }
    const eAPI = getElectronApi();
    const companyId = state.licenseStatus?.companyId;
    const runtime = await resolveElectronRuntimeMode(eAPI);
    if (runtime.mode === 'sync') {
      if (!runtime.success) {
        state.addNotification('error', runtime.code || '_RUNTIME_NOT_READY', runtime.error || ' runtime readiness failed.');
        return;
      }
      if (!companyId || typeof eAPI?.PeriodArchiveRead !== 'function') {
        state.addNotification('error', '_LEGACY_STORAGE_FORBIDDEN', ' archives must be read from the  period archive endpoint.');
        return;
      }
      try {
        const result = await eAPI.PeriodArchiveRead({ companyId, filename });
        if (!result?.success || !result.data) {
          state.addNotification('error', result?.code || 'PERIOD_ARCHIVE_READ_FAILED', result?.error || ' period archive could not be loaded.');
          return;
        }
        set({ selectedArchiveFilename: filename, selectedArchiveData: result.data });
        state.addNotification('info', 'Arxiv yuklandi', `"${result.data.period?.name || filename}"  arxivi ochildi.`);
      } catch (error) {
        state.addNotification('error', 'PERIOD_ARCHIVE_READ_FAILED', error instanceof Error ? error.message : ' period archive could not be loaded.');
      }
      return;
    }

    if (eAPI && eAPI.archiveRead) {
      try {
        const res = await eAPI.archiveRead(filename, companyId);
        if (res.success && res.data) {
          set({ selectedArchiveFilename: filename, selectedArchiveData: res.data });
          state.addNotification('info', 'Arxiv yuklandi', `"${res.data.period?.name || filename}" arxivi ko'rish uchun ochildi.`);
          return;
        }
      } catch (err) {
        console.warn('Electron archiveRead error:', err);
      }
    }

    try {
      const res = await fetch(`/api/archive/${filename}`);
      if (res.ok) {
        const data = await res.json();
        set({ selectedArchiveFilename: filename, selectedArchiveData: data });
        state.addNotification('info', 'Arxiv yuklandi', `"${data.period?.name || filename}" arxivi ko'rish uchun ochildi.`);
      }
    } catch (e) {
      console.warn('Failed to load archive data', e);
      state.addNotification('error', 'Arxiv yuklanmadi', 'Arxiv faylini o\'qishda xatolik yuz berdi.');
    }
  },

  closeCurrentPeriod: async (endDate: string, nextPeriodName?: string, nextStartDate?: string) => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const isCurrentPeriodSession = () => get().licenseStatus === initialLicenseStatus;
    const rejectStalePeriodSession = () => {
      state.addNotification('error', '_SESSION_CHANGED', 'The active company changed while the period operation was in flight.');
      return false;
    };
    const cleanDate = endDate || formatDateIso();
    const archiveFilename = `archive_${Date.now()}_${state.currentPeriod.name.replace(/[^a-zA-Z0-9_\u0400-\u04FF-]/g, '_')}.json`;
    const finalNextStartDate = nextStartDate || cleanDate;
    const NextStartDate = nextStartDate || (() => {
      const nextDate = new Date(`${cleanDate}T00:00:00.000Z`);
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      return nextDate.toISOString().slice(0, 10);
    })();
    const finalNextPeriodName = nextPeriodName?.trim() || getUzbekMonthName(finalNextStartDate);
    const nextPeriod = {
      id: `period_${Date.now()}`,
      name: finalNextPeriodName,
      startDate: finalNextStartDate,
      isClosed: false
    };

    const closedPeriod = {
      ...state.currentPeriod,
      endDate: cleanDate,
      isClosed: true,
      closedAt: new Date().toISOString(),
      archiveFilename
    };

    const activeSizes = state.availableSizes && state.availableSizes.length > 0 ? state.availableSizes : DEFAULT_BATCH_SIZES;

    // 1. Separate parties into fully completed vs incomplete (unsubmitted pattas remaining)
    const completedParties: PrintedPartyRecord[] = [];
    const incompleteParties: PrintedPartyRecord[] = [];

    for (const record of (state.printedPartyHistory || [])) {
      if (record.isClosed) continue;
      const tickets = buildPartyTicketsList(record, state.submittedTickets || [], activeSizes, true);
      const prevArchived = new Set(record.archivedPattaNumbers || []);
      const newlySubmitted = tickets.filter((t) => t.isSubmitted).map((t) => t.pattaNumber);
      const totalCompleted = new Set([...prevArchived, ...newlySubmitted]);
      const totalPattas = tickets.length;
      const isComplete = totalPattas > 0 && totalCompleted.size >= totalPattas;

      if (isComplete) {
        completedParties.push(record);
      } else {
        incompleteParties.push(record);
      }
    }

    // 2. Prepare full archive payload with ALL current data and statistics
    const archivePayload = {
      period: closedPeriod,
      archivedAt: new Date().toISOString(),
      models: state.models,
      workers: state.workers,
      printedPartyHistory: state.printedPartyHistory,
      submittedTickets: state.submittedTickets,
      pattaBatchConfigs: state.pattaBatchConfigs,
      completedPartiesCount: completedParties.length,
      rolledOverPartiesCount: incompleteParties.length
    };

    const rolloverParties = incompleteParties.map((party) => {
      const tickets = buildPartyTicketsList(party, state.submittedTickets || [], activeSizes, true);
      const newlySubmittedNumbers = tickets.filter((ticket) => ticket.isSubmitted).map((ticket) => ticket.pattaNumber);
      const archivedPattaNumbers = Array.from(new Set([...(party.archivedPattaNumbers || []), ...newlySubmittedNumbers]));
      return { partyRecordId: party.id, archivedPattaNumbers };
    });
    const cleanPartyHistory: PrintedPartyRecord[] = rolloverParties.map((rollover) => ({
      ...incompleteParties.find((party) => party.id === rollover.partyRecordId)!,
      archivedPattaNumbers: rollover.archivedPattaNumbers
    }));

    const sync = await submitPeriodMutation(state, get, set, 'ClosePeriod', state.currentPeriod.id, {
      periodId: state.currentPeriod.id,
      endDate: cleanDate,
      nextPeriod: { id: nextPeriod.id, name: nextPeriod.name, startDate: NextStartDate },
      archiveFilename
    }, archivePayload);
    if (sync?.handled) {
      if (sync.success) {
        set({ selectedArchiveFilename: null, selectedArchiveData: null });
        state.addNotification(
          'info',
          'Sinxronlash navbatda',
          localCommitSyncNotice(`"${closedPeriod.name}" davri yopildi. ${completedParties.length} ta partiya arxivlandi; ${incompleteParties.length} ta partiya ko'chirildi.`)
        );
      }
      return sync.success;
    }

    // Save archive to Electron disk
    const eAPI = (window as any).electronAPI;
    const companyId = state.licenseStatus?.companyId;
    if (eAPI && eAPI.archiveSave) {
      try {
        await eAPI.archiveSave(archiveFilename, archivePayload, companyId);
        if (!isCurrentPeriodSession()) return rejectStalePeriodSession();
      } catch (err) {
        console.warn('Failed to save archive in Electron', err);
      }
    }

    // Post to archive API (for web fallback)
    try {
      await fetch('/api/archive-period', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(archivePayload)
      });
    } catch (e) {
      console.warn('Failed to call archive API', e);
    }

    if (!isCurrentPeriodSession()) return rejectStalePeriodSession();

    // 3. Prepare workspace for the next period:
    // Reset quantities in models, reset avans to 0 (PRESERVE: workers, oklad, staj, operations, rates!)
    const cleanModels = state.models.map((m) => ({
      ...m,
      hisobQuantities: {}
    }));

    const cleanWorkers = state.workers.map((w) => ({
      ...w,
      avans: 0,
      jarima: 0
    }));

    // Incomplete parties roll over to the new month!
    // Any pattas that were submitted in the closed month are added to archivedPattaNumbers,
    // so they do not show up as entered in the new month, but are prevented from duplicate submission!
    // In the new month, submittedTickets starts completely fresh (0 tickets entered in the new month)!
    // All submitted tickets from the closed month are safely preserved in the archive!
    const cleanSubmittedTickets: SubmittedTicketRecord[] = [];

    const updatedPeriods = [closedPeriod, ...state.periods];

    const cleanForms = createInitialTicketForms(cleanModels);

    set({
      models: cleanModels,
      workers: cleanWorkers,
      currentPeriod: nextPeriod,
      periods: updatedPeriods,
      ticketForms: cleanForms,
      printedPartyHistory: cleanPartyHistory,
      submittedTickets: cleanSubmittedTickets,
      selectedArchiveFilename: null,
      selectedArchiveData: null
    });

    if (!(await state.saveToDisk({
      models: cleanModels,
      workers: cleanWorkers,
      currentPeriod: nextPeriod,
      periods: updatedPeriods,
      ticketForms: cleanForms,
      printedPartyHistory: cleanPartyHistory,
      submittedTickets: cleanSubmittedTickets,
      companyId: initialLicenseStatus?.companyId
    }, { forceBackup: true }))) return false;
    if (!isCurrentPeriodSession()) return rejectStalePeriodSession();

    state.addNotification(
      'success',
      'Davr muvaffaqiyatli arxivlandi',
      `"${closedPeriod.name}" yopildi. To'liq kiritilgan ${completedParties.length} ta partiya arxivga o'tdi. To'ldirilmagan ${incompleteParties.length} ta partiya yangi oyga o'tkazildi!`
    );
    return true;
  }
});
