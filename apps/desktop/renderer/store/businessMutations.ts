import { WorkbookStore } from './types';
import { hydrateWorkbookData } from './helpers/hydration';
import { useAuthStore } from './authStore';
import { captureSessionIdentity, isSessionCurrent } from './sessionGuard';
import { getElectronApi, resolveElectronRuntimeMode } from './runtimeMode';

export type WorkbookCommandType =
  | 'UpsertModel' | 'DeactivateModel'
  | 'UpsertWorker' | 'DeactivateWorker' | 'CreateWorker'
  | 'CreatePeriod' | 'UpdatePeriod' | 'ClosePeriod'
  | 'CreateParty' | 'UpdateParty' | 'CloseParty' | 'ArchivePartyHistory'
  | 'UpdateBatchSettings' | 'CompletePattaBatch' | 'CompletePartySeries' | 'DeleteTicket';

export type WorkbookCommand = {
  commandType: WorkbookCommandType;
  commandId: string;
  operationId: string;
  companyId: string;
  entityId: string;
  payload: Record<string, any>;
  localArchive?: unknown;
};

export type WorkbookCommandIdentity = {
  commandId: string;
  operationId: string;
};

export type WorkbookCommandResult = {
  mode: 'legacy' | 'sync';
  success: boolean;
  committed?: boolean;
  localOnly?: boolean;
  code?: string;
  error?: string;
};

type SetWorkbook = (partial: Partial<WorkbookStore>) => void;
const reconnectQueues = new Map<string, Promise<any>>();

function createCommandId(): string {
  const randomUUID = (globalThis.crypto as Crypto & { randomUUID?: () => string } | undefined)?.randomUUID;
  if (typeof randomUUID !== 'function') throw new Error('_COMMAND_REQUIRED: UUID generation is unavailable');
  return randomUUID.call(globalThis.crypto);
}

export function createWorkbookCommand(
  commandType: WorkbookCommandType,
  companyId: string,
  entityId: string,
  payload: Record<string, any>,
  localArchive?: unknown,
  identity?: Partial<WorkbookCommandIdentity>
): WorkbookCommand {
  return {
    commandType,
    commandId: identity?.commandId || createCommandId(),
    operationId: identity?.operationId || createCommandId(),
    companyId,
    entityId,
    payload,
    ...(localArchive === undefined ? {} : { localArchive })
  };
}

export function hydrateWorkbookProjection(data: any, companyId: string) {
  const hydrated = hydrateWorkbookData(data);
  const sourceModels = new Map<string, any>(
    (Array.isArray(data?.models) ? data.models : []).map((model: any) => [model.id, model])
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
    deletedModelIds: hydrated.deletedModelIds,
    companyId
  };
}

export async function reloadWorkbookProjection(eAPI: any, companyId: string) {
  if (typeof eAPI?.dbRead !== 'function') throw Object.assign(new Error('_PROJECTION_READ_FAILED: SQLite projection bridge is unavailable'), { code: '_PROJECTION_READ_FAILED' });
  const result = await eAPI.dbRead(companyId);
  if (!result?.success || !result.data) {
    throw Object.assign(new Error(result?.error || '_PROJECTION_READ_FAILED: SQLite projection could not be loaded'), {
      code: result?.code || '_PROJECTION_READ_FAILED'
    });
  }
  return hydrateWorkbookProjection(result.data, companyId);
}

export function requestReconnect(eAPI: any, companyId: string) {
  void runReconnect(eAPI, companyId).catch(() => {
    // Offline  writes remain durable in SQLite/outbox; never fall back to legacy storage.
  });
}

export function runReconnect(eAPI: any, companyId: string): Promise<any> {
  if (typeof eAPI?.SyncReconnect !== 'function') return Promise.resolve({ success: false, code: '_SYNC_UNAVAILABLE' });
  const previous = reconnectQueues.get(companyId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => eAPI.SyncReconnect(companyId));
  reconnectQueues.set(companyId, next);
  void next.finally(() => {
    if (reconnectQueues.get(companyId) === next) reconnectQueues.delete(companyId);
  }).catch(() => {});
  return next;
}

function isCompanySessionCurrent(get: () => WorkbookStore, session: ReturnType<typeof captureSessionIdentity>, companyId: string, initialLicenseStatus: WorkbookStore['licenseStatus']) {
  const licenseCompanyId = get().licenseStatus?.companyId;
  const authCompanyId = useAuthStore.getState().companyId;
  return get().licenseStatus === initialLicenseStatus
    && isSessionCurrent(session, licenseCompanyId || authCompanyId)
    && (!licenseCompanyId || licenseCompanyId === companyId)
    && (!authCompanyId || authCompanyId === companyId);
}

function refreshAfterReconnect(eAPI: any, companyId: string, get: () => WorkbookStore, set: SetWorkbook, session: ReturnType<typeof captureSessionIdentity>, initialLicenseStatus: WorkbookStore['licenseStatus']) {
  if (typeof eAPI?.SyncReconnect !== 'function') return;
  void runReconnect(eAPI, companyId).then(async (syncResult: any) => {
    if (!syncResult?.success || !isCompanySessionCurrent(get, session, companyId, initialLicenseStatus)) return;
    if (!isCompanySessionCurrent(get, session, companyId, initialLicenseStatus)) return;
    const refreshed = await reloadWorkbookProjection(eAPI, companyId);
    if (!isCompanySessionCurrent(get, session, companyId, initialLicenseStatus)) return;
    set({ ...refreshed, isServerConnected: true } as Partial<WorkbookStore>);
  }).catch(() => {
    // Offline  writes remain durable in SQLite/outbox; never fall back to legacy storage.
  });
}

export async function submitWorkbookCommand(
  command: WorkbookCommand,
  get: () => WorkbookStore,
  set: SetWorkbook
): Promise<WorkbookCommandResult> {
  const eAPI = getElectronApi();
  const runtime = await resolveElectronRuntimeMode(eAPI);
  if (runtime.mode === 'legacy') return { mode: 'legacy', success: true };
  if (!runtime.success) return { mode: 'sync', success: false, code: runtime.code || '_RUNTIME_NOT_READY', error: runtime.error || ' runtime readiness failed' };

  const state = get();
  const initialLicenseStatus = state.licenseStatus;
  const licenseCompanyId = state.licenseStatus?.companyId;
  const authCompanyId = useAuthStore.getState().companyId;
  if (!command.companyId || (licenseCompanyId && licenseCompanyId !== command.companyId) || (authCompanyId && authCompanyId !== command.companyId)) {
    return { mode: 'sync', success: false, code: 'CROSS_COMPANY_REJECTED', error: 'Command company does not match the active company session' };
  }
  const session = captureSessionIdentity(command.companyId);
  if (!session) return { mode: 'sync', success: false, code: '_SESSION_UNAVAILABLE', error: 'The active  company session is unavailable' };
  if (typeof eAPI?.WorkbookCommand !== 'function') {
    return { mode: 'sync', success: false, code: '_COMMAND_REQUIRED', error: ' workbook command bridge is unavailable' };
  }

  const isCurrent = () => isCompanySessionCurrent(get, session, command.companyId, initialLicenseStatus);
  if (!isCurrent()) return { mode: 'sync', success: false, code: '_SESSION_CHANGED', error: 'The active company changed before the command started' };

  let commandResult: any;
  try {
    commandResult = await eAPI.WorkbookCommand(command);
  } catch (error) {
    return { mode: 'sync', success: false, code: 'WORKBOOK_COMMAND_FAILED', error: error instanceof Error ? error.message : ' workbook command failed' };
  }
  if (!commandResult?.success) {
    return {
      mode: 'sync',
      success: false,
      code: commandResult?.code || 'WORKBOOK_COMMAND_FAILED',
      error: commandResult?.error || ' workbook command was rejected'
    };
  }
  if (!isCurrent()) return { mode: 'sync', success: false, committed: true, code: '_SESSION_CHANGED', error: 'The command committed, but the active company changed before projection reload' };

  let projectionLoaded = false;
  try {
    const projection = await reloadWorkbookProjection(eAPI, command.companyId);
    if (isCurrent()) {
      set(projection as Partial<WorkbookStore>);
      projectionLoaded = true;
    }
  } catch {
    // The command and outbox row are already committed. Reconnect/hydration can retry later.
  }
  refreshAfterReconnect(eAPI, command.companyId, get, set, session, initialLicenseStatus);
  return {
    mode: 'sync',
    success: true,
    committed: true,
    localOnly: commandResult.result?.localOnly === true,
    ...(projectionLoaded ? {} : { code: '_PROJECTION_RELOAD_PENDING', error: ' command is committed; projection reload will retry during reconnect' })
  };
}
