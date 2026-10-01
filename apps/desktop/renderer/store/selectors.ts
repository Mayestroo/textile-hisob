import type { WorkbookStore } from './types';

export const selectWorkerCount = (state: Pick<WorkbookStore, 'workers'>): number => state.workers.length;

/** Party dashboard shows all non-archived canonical records; it is not period-scoped. */
export const selectPartyDashboardRecords = (state: Pick<WorkbookStore, 'printedPartyHistory'>) => state.printedPartyHistory;
