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

async function tryWorkerMutation(
  state: Pick<WorkbookStore, 'addNotification' | 'licenseStatus'>,
  get: () => WorkbookStore,
  set: (partial: Partial<WorkbookStore>) => void,
  commandType: 'CreateWorker' | 'UpsertWorker' | 'DeactivateWorker',
  entityId: string,
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
  next: { avans?: number; jarima?: number },
  periodId?: string
) {
  const result: Array<Record<string, any>> = [];
  for (const [field, type] of [['avans', 'AVANS'], ['jarima', 'JARIMA']] as const) {
    if (next[field] === undefined) continue;
    const amountDelta = Number(next[field] || 0) - Number(current?.[field] || 0);
    if (amountDelta === 0) continue;
    result.push({ adjustmentId: createUuid(), type, amountDelta, periodId: periodId || null });
  }
  return result;
}

export const createWorkerSlice: StateCreator<WorkbookStore, [], [], WorkerSlice> = (set, get) => ({
  workers: [],

  updateWorker: async (workerId: number, updates: Partial<Worker>, options?: { immediate?: boolean }) => {
    const state = get();
    const initialLicenseStatus = state.licenseStatus;
    const sanitized = { ...updates };
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

    const currentWorker = state.workers.find((worker) => worker.id === workerId);
    const activePeriodId = state.periods?.find((period) => !period.isClosed)?.id;
    const adjustments = balanceAdjustments(currentWorker, {
      avans: sanitized.avans,
      jarima: sanitized.jarima
    }, activePeriodId);
    if (adjustments.length && !activePeriodId && (await resolveElectronRuntimeMode(getElectronApi())).mode === 'sync') {
      state.addNotification('error', 'OPEN_PERIOD_REQUIRED', 'Create an open period before changing AVANS or JARIMA balances.');
      return false;
    }
    const sync = await tryWorkerMutation(state, get, set, 'UpsertWorker', String(workerId), {
      workerId,
      name: sanitized.name === undefined ? currentWorker?.name || '' : sanitized.name,
      staj: sanitized.staj === undefined ? Number(currentWorker?.staj || 0) : sanitized.staj,
      role: sanitized.role === undefined ? currentWorker?.role || null : sanitized.role,
      status: 'ACTIVE',
      balanceAdjustments: adjustments
    });
    if (sync?.handled) return sync.success;

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
        state.addNotification('success', "Ishchi qo'shildi", 'Yangi ishchi yaratish navbatga qo\'shildi; raqam server tomonidan belgilanadi.');
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
