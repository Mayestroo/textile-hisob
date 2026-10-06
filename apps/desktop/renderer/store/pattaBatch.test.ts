import { describe, expect, it, vi } from 'vitest';
import { buildBatchSettingsPayload, buildBatchPrintMutation, getNextPattaNumberInActiveSeries } from './pattaBatch';
import { buildPartyWorkSummary } from '../domain/pattaQuantity';

describe(' patta batch command payloads', () => {
  const models: any[] = [
    { id: 'model-a', name: 'Model A', title: 'Model A', color: 'Qora' },
    { id: 'model-b', name: 'Model B', title: 'Model B', color: 'Ko\'k' }
  ];

  it('creates bounded party summaries, cumulative totals, and reset settings for a batch', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000501' });
    const state: any = {
      models,
      workers: [],
      nextPartyNumber: 1,
      availableSizes: ['M', 'L'],
      pattaBatchConfigs: {
        'model-a': { partyNumber: '1', isCustomParty: false, totalIshSoni: '972', color: 'Qora', sizes: { M: '9', L: '' } },
        'model-b': { partyNumber: '', isCustomParty: false, totalIshSoni: '', color: 'Ko\'k', sizes: { M: '' } }
      },
      printedPartyHistory: [],
      submittedTickets: [],
      deletedPartyIds: []
    };
    const result = buildBatchPrintMutation(state, [{
      modelId: 'model-a', partyNumber: '1', pattaCount: 9,
      ...buildPartyWorkSummary(972, 9), sizes: { M: '9' }, color: 'Qora'
    }], new Date('2026-09-23T10:00:00.000Z'));

    expect(result.batchId).toMatch(/^batch_/);
    expect(result.parties).toHaveLength(1);
    expect(result.parties[0]).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      partyNumber: '1',
      modelId: 'model-a',
      pattaCount: 9,
      ishSoniPerPatta: 108,
      totalIshSoni: 972,
      ishSoni: 972,
      cumulativePattaCount: 9,
      cumulativeIshSoni: 972,
      serverRevision: 0
    });
    expect(result.settings.configs.find((config) => config.modelId === 'model-a')?.sizes).toEqual({ M: '', L: '' });
    expect(result.nextPartyNumber).toBe(2);
  });

  it('preserves current batch settings by company and model', () => {
    const settings = buildBatchSettingsPayload({
      models,
      workers: [],
      nextPartyNumber: 1,
      availableSizes: ['M'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '2', isCustomParty: true, totalIshSoni: '25', sizes: { M: '1' } } },
      printedPartyHistory: [],
      submittedTickets: [],
      deletedPartyIds: []
    });
    expect(settings).toMatchObject({ availableSizes: ['M'], configs: [expect.objectContaining({ modelId: 'model-a', partyNumber: '2', isCustomParty: true })] });
  });

  it('continues within the active series and restarts after all earlier parties are closed', () => {
    const history = [
      { partyNumber: '1', pattaCount: 12, pattaStartNumber: 1, pattaEndNumber: 12, cumulativePattaCount: 12, isClosed: true },
      { partyNumber: '1', pattaCount: 12, pattaStartNumber: 566, pattaEndNumber: 577, cumulativePattaCount: 577, isClosed: false }
    ] as any;

    expect(getNextPattaNumberInActiveSeries(history)).toBe(578);
    expect(getNextPattaNumberInActiveSeries(history.map((party: any) => ({ ...party, isClosed: true })))).toBe(1);
  });
});
