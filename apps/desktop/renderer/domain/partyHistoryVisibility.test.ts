import { describe, expect, it } from 'vitest';
import type { PrintedPartyRecord } from '../types/workbook';
import { selectPartyHistoryForView } from './partyHistoryVisibility';

const record = (id: string, flags: Partial<PrintedPartyRecord> = {}) => ({
  id,
  partyNumber: id,
  modelId: 'model-a',
  modelName: 'Model A',
  color: 'Qora',
  pattaCount: 1,
  cumulativePattaCount: 1,
  ishSoni: 10,
  cumulativeIshSoni: 10,
  printedAt: '2026-09-29T00:00:00.000Z',
  ...flags
});

describe('selectPartyHistoryForView', () => {
  const history = [
    record('archived', { isArchived: true, isClosed: true }),
    record('closed', { isClosed: true }),
    record('active')
  ];

  it('hides archived records only in the live view', () => {
    expect(selectPartyHistoryForView(history, 'live').map((party) => party.id))
      .toEqual(['closed', 'active']);
    expect(selectPartyHistoryForView(history, 'archive')).toEqual(history);
    expect(selectPartyHistoryForView(history, 'all-time')).toEqual(history);
  });
});
