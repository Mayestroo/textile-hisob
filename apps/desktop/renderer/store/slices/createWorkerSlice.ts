import { StateCreator } from 'zustand';
import { WorkbookStore, WorkerSlice } from '../types';
import { Worker } from '../../types/workbook';
import { triggerDebouncedSave } from '../helpers/debounceSave';
import {
  cleanWorkerName,
  normalizeWorkerName
} from '../helpers/storeSanitizers';
import { getElectronApi, resolveElectronRuntimeMode } from '../runtimeMode';
import { createWorkbookCommand, submitWorkbookCommand } from '../businessMutations';
import { useAuthStore } from '../authStore';

async function tryWorkerMutation(
  state: Pick<WorkbookStore, 'addNotification' | 'licenseStatus'>,
  get: () => WorkbookStore,
  set: (partial: Partial<WorkbookStore>) => void,
  commandType: 'CreateWorker' | 'UpsertWorker' | 'DeactivateWorker',
  entityId: string,
  payload: Record<string, any>,
  expectedPeriodId?: string
): Promise<{ handled: boolean; success: boolean } | null> {
  const initialLicenseStatus = state.licenseStatus;
  const runtime = await resolveElectronRuntimeMode(getElectronApi());
  if (get().licenseStatus !== initialLicenseStatus) {
    state.addNotification('error', '_SESSION_CHANGED', 'The active company changed while the operation was in flight.');
    return { handled: true, success: false };
  }
  if (expectedPeriodId && get().currentPeriod?.id !== expectedPeriodId) {
    state.addNotification('error', '_SESSION_CHANGED', 'The selected period changed while the worker update was being prepared.');
    return { handled: true, success: false };
  }
  if (runtime.mode !== 'sync') return null;
  if (!runtime.success) {
    state.addNotification('error', runtime.code || '_RUNTIME_NOT_READY', runtime.error || ' runtime readiness failed.');
    return { handled: true, success: false };
  }
  const companyId = state.licenseStatus?.companyId;
  if (!companyId) {
    state.addNotification('error', '_RUNTIME_NOT_READY', 'A company binding is required for  worker changes.');
    return { handled: true, success: false };
  }
  const result = await submitWorkbookCommand(
    createWorkbookCommand(commandType, companyId, entityId, payload),
    get,
    set
  );
  if (!result.success) {
    state.addNotification('error', result.code || '_COMMAND_REJECTED', result.error || ' worker change was rejected.');
    return { handled: true, success: false };
  }
  return { handled: true, success: true };
}

function createUuid(): string {
  const randomUUID = (globalThis.crypto as Crypto & { randomUUID?: () => string } | undefined)?.randomUUID;
  if (typeof randomUUID !== 'function') throw new Error('_COMMAND_REQUIRED: UUID generation is unavailable');
  return randomUUID.call(globalThis.crypto);
}

function balanceAdjustments(
  current: Worker | undefined,
  next: { avans?: number; jarima?: number; oklad?: number; magazin?: number },
  periodId?: string
) {
  const result: Array<Record<string, any>> = [];
  for (const [field, type] of [['avans', 'AVANS'], ['jarima', 'JARIMA'], ['oklad', 'OKLAD'], ['magazin', 'MAGAZIN']] as const) {
    if (next[field] === undefined) continue;
    const amountDelta = Number(next[field] || 0) - Number(current?.[field] || 0);
    if (amountDelta === 0) continue;
    if (['OKLAD', 'MAGAZIN'].includes(type) && !Number.isSafeInteger(amountDelta)) {
      throw Object.assign(new Error(`${type} amount delta must be a safe integer`), { code: 'INVALID_WORKER_MONEY' });
    }
    if (!periodId) throw Object.assign(new Error('An explicit open period is required for worker adjustments'), { code: 'OPEN_PERIOD_REQUIRED' });
    result.push({ adjustmentId: createUuid(), type, amountDelta, periodId: periodId || null });
  }
  return result;
}

export const createWorkerSlice: StateCreator<WorkbookStore, [], [], WorkerSlice> = (set, get) => ({
  workers: [],

  updateWorker: async (workerId: number, updates: Partial<Worker>, options?: { immediate?: boolean }) => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const invalidatePayroll = (reason: string) => set({ payrollValuation: {
      companyId: state.licenseStatus?.companyId || '', period: null, workers: [],
      accountingStatus: 'UNAVAILABLE', accountingReasons: [reason], syncStatus: 'UNKNOWN'
    } });
    const sanitized = { ...updates };
    const hasManualMoney = sanitized.oklad !== undefined || sanitized.magazin !== undefined;
    for (const field of ['oklad', 'magazin'] as const) {
      if (sanitized[field] !== undefined && (!Number.isSafeInteger(sanitized[field]) || Number(sanitized[field]) < 0)) {
        state.addNotification('error', 'INVALID_WORKER_MONEY', `${field} must be a non-negative safe integer.`);
        return false;
      }
    }
    if (sanitized.avans !== undefined) sanitized.avans = Math.max(0, Number(sanitized.avans) || 0);
    if (sanitized.jarima !== undefined) sanitized.jarima = Math.max(0, Number(sanitized.jarima) || 0);
    if (sanitized.staj !== undefined) sanitized.staj = Math.max(0, Number(sanitized.staj) || 0);
    if (sanitized.name) sanitized.name = cleanWorkerName(sanitized.name);

    const now = Date.now();
    const updatedWorkers = state.workers.map((w) => {
      if (w.id === workerId) {
        return { ...w, ...sanitized, updatedAt: now };
      }
      return w;
    });

    let currentWorker = state.workers.find((worker) => worker.id === workerId);
    const selectedPeriodId = state.currentPeriod?.id;
    const selectedPeriod = state.periods?.find((period) => period.id === selectedPeriodId);
    if (hasManualMoney) {
      if (!selectedPeriodId || !selectedPeriod || selectedPeriod.isClosed || state.currentPeriod.isClosed) {
        state.addNotification('error', 'OPEN_PERIOD_REQUIRED', 'Oklad/Magazin require the selected open period.');
        return false;
      }
      const auth = useAuthStore.getState();
      if (!auth.companyId || auth.companyId !== state.licenseStatus?.companyId
        || !auth.permissions.includes('edit:workers') || !auth.permissions.includes('edit:avans')) {
        state.addNotification('error', 'FORBIDDEN', 'The active role cannot edit worker payroll amounts.');
        return false;
      }
      const runtime = await resolveElectronRuntimeMode(getElectronApi());
      const api = getElectronApi();
      if (runtime.mode !== 'sync' || !runtime.success || typeof api?.dbRead !== 'function') {
        invalidatePayroll('WORKER_MONEY_PERSISTENCE_REQUIRED');
        state.addNotification('error', 'WORKER_MONEY_PERSISTENCE_REQUIRED', 'Oklad/Magazin require the canonical company-bound database command path.');
        return false;
      }
      const read = await api.dbRead(state.licenseStatus.companyId);
      if (get().licenseStatus !== initialLicenseStatus || get().currentPeriod?.id !== selectedPeriodId) {
        state.addNotification('error', '_SESSION_CHANGED', 'Company or period changed while worker payroll was being loaded.');
        return false;
      }
      if (!read?.success || !read.data || read.data.companyId !== state.licenseStatus.companyId
        || read.data.currentPeriod?.id !== selectedPeriodId || read.data.currentPeriod?.isClosed) {
        state.addNotification('error', '_PROJECTION_READ_FAILED', 'Persisted worker payroll balance is unavailable for the selected period.');
        set({ payrollValuation: { companyId: state.licenseStatus.companyId, period: null, workers: [],
          accountingStatus: 'UNAVAILABLE', accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN' } });
        return false;
      }
      currentWorker = read.data.workers?.find((worker: Worker) => Number(worker.id) === Number(workerId));
      if (!currentWorker || ['oklad', 'magazin'].some((field) => {
        const value = Number((currentWorker as any)[field] ?? 0);
        return !Number.isSafeInteger(value) || value < 0;
      })) {
        invalidatePayroll('PAYROLL_VALUATION_UNAVAILABLE');
        state.addNotification('error', '_PROJECTION_READ_FAILED', 'Persisted worker payroll balance is unavailable or invalid.');
        return false;
      }
      const payrollRow = read.data.payrollValuation?.workers?.find((worker: any) => Number(worker.workerId) === Number(workerId));
      if (!payrollRow || payrollRow.accountingReasons?.includes('WORKER_ADJUSTMENT_CONFLICT')) {
        invalidatePayroll(payrollRow ? 'WORKER_ADJUSTMENT_CONFLICT' : 'PAYROLL_VALUATION_UNAVAILABLE');
        state.addNotification('error', 'WORKER_ADJUSTMENT_CONFLICT', 'Resolve the worker adjustment conflict before changing its period balance.');
        return false;
      }
    }
    const activePeriodId = hasManualMoney ? selectedPeriodId : selectedPeriodId || state.periods?.find((period) => !period.isClosed)?.id;
    let adjustments: Array<Record<string, any>>;
    try {
      adjustments = balanceAdjustments(currentWorker, {
        avans: sanitized.avans,
        jarima: sanitized.jarima,
        oklad: sanitized.oklad,
        magazin: sanitized.magazin
      }, activePeriodId);
    } catch (error: any) {
      state.addNotification('error', error?.code || 'INVALID_WORKER_MONEY', error?.message || 'Worker payroll amount is invalid.');
      return false;
    }
    if (hasManualMoney && (await resolveElectronRuntimeMode(getElectronApi())).mode !== 'sync') {
      invalidatePayroll('WORKER_MONEY_PERSISTENCE_REQUIRED');
      state.addNotification('error', 'WORKER_MONEY_PERSISTENCE_REQUIRED', 'Oklad/Magazin cannot be saved through legacy persistence.');
      return false;
    }
    if (adjustments.length && !activePeriodId && (await resolveElectronRuntimeMode(getElectronApi())).mode === 'sync') {
      state.addNotification('error', 'OPEN_PERIOD_REQUIRED', 'Create an open period before changing AVANS or JARIMA balances.');
      return false;
    }
    // Blur and formatted-value roundtrips must not create commands or advance revisions.
    // Manual payroll values have already been checked against the persisted period above.
    if (currentWorker && adjustments.length === 0 && Object.entries(sanitized).every(([field, value]) => {
      if (value === undefined) return true;
      if (['avans', 'jarima', 'oklad', 'magazin', 'staj'].includes(field)) {
        return Number(value) === Number(currentWorker[field as keyof Worker] || 0);
      }
      return value === currentWorker[field as keyof Worker];
    })) return true;
    const sync = await tryWorkerMutation(state, get, set, 'UpsertWorker', String(workerId), {
      workerId,
      name: sanitized.name === undefined ? currentWorker?.name || '' : sanitized.name,
      staj: sanitized.staj === undefined ? Number(currentWorker?.staj || 0) : sanitized.staj,
      role: sanitized.role === undefined ? currentWorker?.role || null : sanitized.role,
      status: 'ACTIVE',
      balanceAdjustments: adjustments
    }, hasManualMoney ? selectedPeriodId : undefined);
    if (sync?.handled) {
      if (hasManualMoney && !sync.success) {
        invalidatePayroll('WORKER_ADJUSTMENT_WRITE_UNVERIFIED');
      }
      return sync.success;
    }

    set({ workers: updatedWorkers });

    if (options?.immediate || sanitized.name !== undefined) {
      if (!(await get().saveToDisk({ workers: updatedWorkers, companyId: initialLicenseStatus?.companyId })) || get().licenseStatus !== initialLicenseStatus) return false;
    } else {
      triggerDebouncedSave(() => {
        get().saveToDisk({ workers: updatedWorkers, companyId: initialLicenseStatus?.companyId });
      }, 1200, 'worker', () => get().licenseStatus === initialLicenseStatus);
    }
    return true;
  },

  addWorker: async (name: string, initialData?: { staj?: number; avans?: number; jarima?: number; role?: string }) => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const cleanName = cleanWorkerName(name);
    if (!cleanName) return false;

    const norm = normalizeWorkerName(cleanName);
    const existing = state.workers.find((w) => normalizeWorkerName(w.name) === norm);
    if (existing) {
      state.addNotification('warning', "Ishchi allaqachon mavjud", `"${cleanName}" allaqachon #${existing.id} sifatida ro'yxatda bor.`);
      return false;
    }

    const electronApi = getElectronApi();
    const runtime = await resolveElectronRuntimeMode(electronApi);
    if (get().licenseStatus !== initialLicenseStatus) {
      state.addNotification('error', '_SESSION_CHANGED', 'The active company changed while the worker create request was being prepared.');
      return false;
    }
    const activePeriodId = state.periods?.find((period) => !period.isClosed)?.id;
    const nextWorker = {
      name: cleanName,
      staj: Math.max(0, Number(initialData?.staj) || 0),
      avans: Math.max(0, Number(initialData?.avans) || 0),
      jarima: Math.max(0, Number(initialData?.jarima) || 0),
      role: initialData?.role || undefined
    };
    const adjustments = balanceAdjustments(undefined, {
      avans: nextWorker.avans,
      jarima: nextWorker.jarima
    }, activePeriodId);
    if (adjustments.length && !activePeriodId && runtime.mode === 'sync') {
      state.addNotification('error', 'OPEN_PERIOD_REQUIRED', 'Create an open period before setting opening AVANS or JARIMA balances.');
      return false;
    }

    if (runtime.mode === 'sync') {
      const companyId = state.licenseStatus?.companyId;
      if (!runtime.success) {
        state.addNotification('error', runtime.code || '_RUNTIME_NOT_READY', runtime.error || ' runtime readiness failed.');
        return false;
      }
      if (!companyId) {
        state.addNotification('error', '_RUNTIME_NOT_READY', 'A company binding is required for  worker changes.');
        return false;
      }
      const requestId = createUuid();
      const requestKey = `pending-worker:${requestId}`;
      const result = await tryWorkerMutation(state, get, set, 'CreateWorker', requestKey, {
        requestId,
        name: nextWorker.name,
        staj: nextWorker.staj,
        role: nextWorker.role || null,
        balanceAdjustments: adjustments
      });
      if (!result?.handled) {
        state.addNotification('error', '_WORKER_CREATE_REQUIRED', ' worker creation must use the authoritative server command.');
        return false;
      }
      if (result.success) {
        state.addNotification('info', 'Ishchi yaratish navbatda', 'Yangi ishchi yaratish so‘rovi lokal outboxga yozildi; ID server tasdiqlagach belgilanadi.');
      }
      return result.success;
    }
    state.addNotification('error', '_WORKER_CREATION_REQUIRED', 'Worker creation requires PostgreSQL-authoritative  allocation.');
    return false;
  },

  deleteWorker: async (workerId: number) => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const sync = await tryWorkerMutation(state, get, set, 'DeactivateWorker', String(workerId), { workerId });
    if (sync?.handled) {
      if (sync.success) state.addNotification('info', "Ishchi o'chirildi", 'Ishchi  tarixini saqlagan holda faol ro‘yxatdan olindi.');
      return sync.success;
    }
    const updatedWorkers = state.workers.filter((w) => w.id !== workerId);
    const updatedDeletedWorkerIds = Array.from(new Set([...(state.deletedWorkerIds || []), workerId]));
    set({ workers: updatedWorkers, deletedWorkerIds: updatedDeletedWorkerIds });
    if (!(await get().saveToDisk({ workers: updatedWorkers, deletedWorkerIds: updatedDeletedWorkerIds, companyId: initialLicenseStatus?.companyId })) || get().licenseStatus !== initialLicenseStatus) return false;
    return true;
  }
});
