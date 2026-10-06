import type { PrintedPartyRecord } from '../types/workbook';

export type PartyHistoryViewMode = 'live' | 'archive' | 'all-time';
export type PartySeriesTab = 'active' | 'closed';

export function selectPartyHistoryForView(
  history: PrintedPartyRecord[],
  mode: PartyHistoryViewMode
): PrintedPartyRecord[] {
  return mode === 'live'
    ? history.filter((party) => party.isArchived !== true)
    : history;
}

export function selectPartySeriesTab(
  history: PrintedPartyRecord[],
  tab: PartySeriesTab,
  mode: PartyHistoryViewMode
): PrintedPartyRecord[] {
  if (mode !== 'live') return history;
  return history.filter((party) => tab === 'closed' ? party.isClosed : !party.isClosed);
}
