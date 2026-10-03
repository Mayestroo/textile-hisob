import { DEFAULT_BATCH_SIZES } from '../../constants/batchConstants';
import { ModelConfig, Worker, SubmittedTicketRecord, PayrollPeriod } from '../../types/workbook';
import { formatDateIso, getUzbekMonthName } from '../../utils/formatters';
import {
  reconcileModelHisobQuantities,
  sanitizeForms,
  sanitizeModels,
  sanitizePattaBatchConfigs,
  sanitizePrintedPartyHistory,
  sanitizeWorkers
} from './storeSanitizers';

export function isValidCompanyId(companyId: unknown): companyId is string {
  return typeof companyId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(companyId) && companyId !== 'unassigned';
}

/** Persisted state without ownership metadata is not safe to hydrate into a tenant store. */
export function isPayloadOwnedByCompany(raw: unknown, activeCompanyId: unknown): boolean {
  if (!isValidCompanyId(activeCompanyId) || !raw || typeof raw !== 'object') return false;
  const payloadCompanyId = (raw as { companyId?: unknown }).companyId;
  return isValidCompanyId(payloadCompanyId) && payloadCompanyId === activeCompanyId;
}

export interface HydratedWorkbookData {
  companyId?: string;
  workers: Worker[];
  models: ModelConfig[];
  availableSizes: string[];
  nextPartyNumber: number;
  printedPartyHistory: any[];
  submittedTickets: SubmittedTicketRecord[];
  currentPeriod: PayrollPeriod;
  periods: PayrollPeriod[];
  ticketForms: Record<string, any>;
  pattaBatchConfigs: Record<string, any>;
  deletedTicketIds: string[];
  deletedPartyIds: string[];
  deletedWorkerIds: number[];
  deletedModelIds: string[];
}

export function hydrateWorkbookData(raw: any, fallback?: Partial<HydratedWorkbookData>): HydratedWorkbookData {
  const source = raw && typeof raw === 'object' ? raw : {};
  const workers = sanitizeWorkers(source.workers || fallback?.workers || []);
  const submittedTickets = Array.isArray(source.submittedTickets)
    ? source.submittedTickets
    : fallback?.submittedTickets || [];
  const models = reconcileModelHisobQuantities(
    sanitizeModels(source.models || fallback?.models || []),
    submittedTickets
  );
  const printedPartyHistory = sanitizePrintedPartyHistory(
    source.printedPartyHistory || fallback?.printedPartyHistory || []
  );
  const availableSizes = Array.isArray(source.availableSizes) && source.availableSizes.length > 0
    ? source.availableSizes
    : fallback?.availableSizes || [...DEFAULT_BATCH_SIZES];
  const nextPartyNumber = Number(source.nextPartyNumber || fallback?.nextPartyNumber || 1);
  const currentPeriod = source.currentPeriod || fallback?.currentPeriod || {
    id: 'period_default',
    name: getUzbekMonthName(),
    startDate: `${formatDateIso().slice(0, 7)}-01`,
    isClosed: false
  };

  return {
    companyId: source.companyId || fallback?.companyId,
    workers,
    models,
    availableSizes,
    nextPartyNumber,
    printedPartyHistory,
    submittedTickets,
    currentPeriod,
    periods: Array.isArray(source.periods) ? source.periods : fallback?.periods || [],
    ticketForms: sanitizeForms(source.ticketForms || fallback?.ticketForms, models),
    pattaBatchConfigs: sanitizePattaBatchConfigs(
      source.pattaBatchConfigs || fallback?.pattaBatchConfigs,
      models,
      nextPartyNumber,
      availableSizes
    ),
    deletedTicketIds: source.deletedTicketIds || fallback?.deletedTicketIds || [],
    deletedPartyIds: source.deletedPartyIds || fallback?.deletedPartyIds || [],
    deletedWorkerIds: source.deletedWorkerIds || fallback?.deletedWorkerIds || [],
    deletedModelIds: source.deletedModelIds || fallback?.deletedModelIds || []
  };
}
