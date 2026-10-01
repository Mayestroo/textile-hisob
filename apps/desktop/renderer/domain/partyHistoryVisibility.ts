import type { PrintedPartyRecord } from '../types/workbook';

export type PartyHistoryViewMode = 'live' | 'archive' | 'all-time';

export function selectPartyHistoryForView(
  history: PrintedPartyRecord[],
  mode: PartyHistoryViewMode
): PrintedPartyRecord[] {
  return mode === 'live'
    ? history.filter((party) => party.isArchived !== true)
    : history;
}
