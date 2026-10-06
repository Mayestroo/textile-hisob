import {
  Worker,
  ModelConfig,
  TicketFormState,
  Notification,
  PayrollPeriod,
  LicenseStatus,
  ModelPattaBatchConfig,
  PrintedPartyRecord,
  SubmittedTicketRecord
} from '../types/workbook';
import { AppUpdateInfo } from '../types/update';

export interface ActiveCellInfo {
  cellId: string;
  sheetName: string;
  value: string;
  formula?: string;
  isReadOnly?: boolean;
}

export interface ModalState {
  type:
    | 'new_operation'
    | 'delete_operation'
    | 'worker_manager'
    | 'backup_manager'
    | 'new_model'
    | 'period_manager'
    | 'license_activation'
    | 'developer_info'
    | 'patta_print'
    | 'worker_detail'
    | 'app_update'
    | 'edit_ticket'
    | null;
  modelId?: string;
  opName?: string;
  workerId?: number;
  data?: any;
}

export interface ModelSlice {
  models: ModelConfig[];
  addModel: (
    name: string,
    options?: {
      templateType?: 'blank' | 'standard' | 'clone';
      cloneFromId?: string;
      title?: string;
      party?: string;
      color?: string;
      size?: string;
    }
  ) => Promise<void> | void;
  deleteModel: (modelId: string) => Promise<void> | void;
  renameModel: (modelId: string, newName: string) => Promise<void> | void;
  syncNewOperation: (modelId: string, opName: string, rate: number) => Promise<void> | void;
  syncDeleteOperation: (modelId: string, opName: string) => Promise<void> | void;
  updateOperationRate: (modelId: string, opName: string, rate: number) => Promise<void> | void;
  updateOperationName: (modelId: string, oldOpName: string, newName: string) => Promise<void> | void;
  updateHisobQuantity: (modelId: string, workerId: number, opName: string, qty: number) => Promise<void> | void;
  reorderOperations: (modelId: string, newOrder: string[]) => Promise<void> | void;
}

export interface WorkerSlice {
  workers: Worker[];
  updateWorker: (workerId: number, updates: Partial<Worker>, options?: { immediate?: boolean }) => Promise<boolean>;
  addWorker: (name: string, initialData?: { staj?: number; avans?: number; jarima?: number; role?: string }) => Promise<boolean>;
  deleteWorker: (workerId: number) => Promise<boolean>;
}

export interface TicketSlice {
  ticketForms: Record<string, TicketFormState>;
  submittedTickets: SubmittedTicketRecord[];
  updateTicketField: (modelId: string, field: keyof TicketFormState, value: any) => void;
  setTicketWorker: (modelId: string, opName: string, workerId: string | number) => void;
  clearTicketForm: (modelId: string) => void;
  jonatish: (modelId: string) => Promise<boolean>;
  deleteSubmittedTicket: (ticketId: string) => Promise<boolean | void>;
  updateSubmittedTicket: (
    ticketId: string,
    updatedEntries: Array<{ opName: string; workerId: number; rateSnapshot?: number }>
  ) => Promise<boolean>;
}

export interface ArchivedPeriodData {
  period: PayrollPeriod;
  archivedAt: string;
  models: ModelConfig[];
  workers: Worker[];
  printedPartyHistory: PrintedPartyRecord[];
  submittedTickets: SubmittedTicketRecord[];
  pattaBatchConfigs?: Record<string, ModelPattaBatchConfig>;
  completedPartiesCount?: number;
  rolledOverPartiesCount?: number;
}

export interface PeriodSlice {
  currentPeriod: PayrollPeriod;
  periods: PayrollPeriod[];
  selectedArchiveFilename: string | null;
  selectedArchiveData: ArchivedPeriodData | null;
  startNewPeriod: (name: string, startDate: string) => Promise<boolean>;
  updateCurrentPeriod: (name: string, startDate: string) => Promise<boolean>;
  closeCurrentPeriod: (endDate: string, nextPeriodName?: string, nextStartDate?: string) => Promise<boolean>;
  loadArchivedPeriod: (filename: string | null) => Promise<void>;
}

export interface PattaBatchSlice {
  availableSizes: string[];
  nextPartyNumber: number;
  pattaBatchConfigs: Record<string, ModelPattaBatchConfig>;
  printedPartyHistory: PrintedPartyRecord[];
  addCustomSize: (sizeName: string) => Promise<void> | void;
  deleteCustomSize: (sizeName: string) => Promise<void> | void;
  incrementPartyNumber: (modelId: string, printedPartyStr: string) => Promise<void> | void;
  updatePattaBatchConfig: (modelId: string, updates: Partial<ModelPattaBatchConfig>) => Promise<void> | void;
  updatePattaBatchSize: (modelId: string, size: string, count: string) => Promise<void> | void;
  addPrintedPartyRecord: (record: {
    partyNumber: string;
    modelId: string;
    modelName: string;
    color: string;
    pattaCount: number;
    ishSoni: number;
  }) => Promise<void> | void;
  batchPrintCompleted: (
    printedItems: Array<{
      modelId: string;
      partyNumber: string;
      pattaCount: number;
      ishSoniPerPatta?: number;
      totalIshSoni?: number;
      ishSoni: number;
      sizes?: Record<string, string>;
      color: string;
    }>
  ) => Promise<void> | void;
  deletePrintedPartyRecord: (id: string) => Promise<void> | void;
  clearPrintedPartyHistory: () => Promise<void> | void;
  confirmPartyActualQuantities: (partyRecordId: string) => Promise<void>;
  completePartySeries: () => Promise<void>;
}

export interface PattaSequenceSlice {
  nextPattaNumber: number;
}

export interface LicenseSlice {
  licenseStatus: LicenseStatus | null;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  checkLicense: () => Promise<LicenseStatus>;
  activateWithKey: (key: string) => Promise<{ success: boolean; error?: string }>;
}

export interface ConfirmModalState {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDanger?: boolean;
  resolve?: (value: boolean) => void;
}

export interface UiSlice {
  activeSheet: string;
  activeCell: ActiveCellInfo;
  notifications: Notification[];
  modalState: ModalState;
  confirmState: ConfirmModalState | null;
  loadingMessage: string | null;
  availableUpdate: AppUpdateInfo | null;
  setActiveSheet: (sheetName: string) => void;
  setActiveCell: (info: ActiveCellInfo) => void;
  openModal: (modal: ModalState) => void;
  closeModal: () => void;
  confirmAction: (options: {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    isDanger?: boolean;
  }) => Promise<boolean>;
  closeConfirm: (result: boolean) => void;
  addNotification: (type: Notification['type'], title: string, message: string) => void;
  removeNotification: (id: string) => void;
  setLoadingMessage: (msg: string | null) => void;
  setAvailableUpdate: (update: AppUpdateInfo | null) => void;
}

export interface PersistenceSlice {
  isSaving: boolean;
  isServerConnected: boolean;
  deletedTicketIds?: string[];
  deletedPartyIds?: string[];
  deletedWorkerIds?: number[];
  deletedModelIds?: string[];
  initStore: (forcedCompanyId?: string) => Promise<void>;
  saveToDisk: (
    overrideState?: {
      workers?: Worker[];
      models?: ModelConfig[];
      ticketForms?: Record<string, TicketFormState>;
      pattaBatchConfigs?: Record<string, ModelPattaBatchConfig>;
      availableSizes?: string[];
      nextPartyNumber?: number;
      nextPattaNumber?: number;
      printedPartyHistory?: PrintedPartyRecord[];
      submittedTickets?: SubmittedTicketRecord[];
      currentPeriod?: PayrollPeriod;
      periods?: PayrollPeriod[];
      companyId?: string;
      deletedTicketIds?: string[];
      deletedPartyIds?: string[];
      deletedWorkerIds?: number[];
      deletedModelIds?: string[];
    },
    options?: { forceBackup?: boolean; companyId?: string; skipReconcile?: boolean }
  ) => Promise<boolean>;
  exportExcel: () => void;
  exportWorkersExcel: () => void;
  resetToOriginal: () => Promise<boolean>;
  restoreFromVps: (companyId?: string) => Promise<{ success: boolean; message?: string }>;
}

export type WorkbookStore = ModelSlice &
  WorkerSlice &
  TicketSlice &
  PeriodSlice &
  PattaBatchSlice &
  PattaSequenceSlice &
  LicenseSlice &
  UiSlice &
  PersistenceSlice;
