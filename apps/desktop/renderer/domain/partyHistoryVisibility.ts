import type { PrintedPartyRecord } from '../types/workbook';
import type { PattaLifecycle } from './pattaLifecycle';

export type PartyHistoryViewMode = 'live' | 'archive' | 'all-time';
export type PartySeriesTab = PattaLifecycle;

export const LIFECYCLE_TAB_LABELS: Record<PartySeriesTab, string> = {
  active: 'Faol',
  closed: 'Yopilgan',
  ended: 'Yakunlangan',
  legacy: 'Eski arxiv'
};

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
  // Legacy compatibility helper for callers expecting whole-party filtering.
  // Journal presentation classifies item-by-item via selectLifecycleItems.
  if (tab === 'ended') {
    return history.filter((p) => Boolean(p.endedAt && p.endedOperationId));
  }
  if (tab === 'closed') {
    return history.filter((p) => p.isClosed && !p.endedAt);
  }
  if (tab === 'legacy') {
    return history.filter((p) => p.isClosed && !p.endedAt && !p.monthClosedPeriodId);
  }
  return history.filter((p) => !p.isClosed && !p.endedAt);
}
