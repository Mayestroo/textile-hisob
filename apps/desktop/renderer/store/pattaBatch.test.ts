import { describe, expect, it, vi } from 'vitest';
import { buildBatchSettingsPayload, buildBatchPrintMutation, buildPattaPreviewStarts, findNextPartyNumber, removePattaSizeFromBatchConfigs } from './pattaBatch';
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
      nextPattaNumber: 1,
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
      nextPattaNumber: 1,
      availableSizes: ['M'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '2', isCustomParty: true, totalIshSoni: '25', sizes: { M: '1' } } },
      printedPartyHistory: [],
      submittedTickets: [],
      deletedPartyIds: [],
      reusablePattaRanges: []
    });
    expect(settings).toMatchObject({ availableSizes: ['M'], configs: [expect.objectContaining({ modelId: 'model-a', partyNumber: '2', isCustomParty: true })] });
  });

  it('uses the synchronized series counter independently of closed-party history', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000502' });
    const history = [{
      id: 'closed-party', partyNumber: '1', modelId: 'model-a', modelName: 'Model A', color: 'Qora',
      pattaCount: 12, cumulativePattaCount: 577, pattaStartNumber: 566, pattaEndNumber: 577,
      ishSoni: 100, cumulativeIshSoni: 100, printedAt: '2026-09-20T10:00:00.000Z', isClosed: true
    }];
    const state: any = {
      models, workers: [], nextPartyNumber: 2, nextPattaNumber: 13,
      availableSizes: ['M'],
      pattaBatchConfigs: { 'model-b': { partyNumber: '2', isCustomParty: false, totalIshSoni: '100', color: 'Qora', sizes: { M: '12' } } },
      printedPartyHistory: history, submittedTickets: [], deletedPartyIds: []
    };
    const result = buildBatchPrintMutation(state, [{
      modelId: 'model-b', partyNumber: '2', pattaCount: 12,
      ...buildPartyWorkSummary(120, 12), sizes: { M: '12' }, color: 'Qora'
    }], new Date('2026-10-06T10:00:00.000Z'));

    expect(result.parties[0]).toMatchObject({ pattaStartNumber: 13, pattaEndNumber: 24 });
    expect(result.nextPattaNumber).toBe(25);
  });

  it('reuses free patta numbers from an archived party without overlapping active ranges', () => {
    let id = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` });
    const history: any[] = [
      { id: 'archived', partyNumber: '20', modelId: 'model-a', pattaCount: 12, cumulativePattaCount: 12,
        pattaStartNumber: 1, pattaEndNumber: 12, ishSoni: 0, cumulativeIshSoni: 0, printedAt: '', isClosed: true, isArchived: true },
      { id: 'active-one', partyNumber: '21', modelId: 'model-a', pattaCount: 4, cumulativePattaCount: 4,
        pattaStartNumber: 1, pattaEndNumber: 4, ishSoni: 0, cumulativeIshSoni: 0, printedAt: '' },
      { id: 'active-two', partyNumber: '22', modelId: 'model-b', pattaCount: 2, cumulativePattaCount: 8,
        pattaStartNumber: 7, pattaEndNumber: 8, ishSoni: 0, cumulativeIshSoni: 0, printedAt: '' }
    ];
    const state: any = {
      models, workers: [], nextPartyNumber: 1, nextPattaNumber: 13,
      availableSizes: ['M'],
      pattaBatchConfigs: {},
      printedPartyHistory: history, submittedTickets: [], deletedPartyIds: [], reusablePattaRanges: [{ start: 1, end: 12 }]
    };

    const result = buildBatchPrintMutation(state, [
      { modelId: 'model-a', partyNumber: '1', pattaCount: 3, ...buildPartyWorkSummary(30, 3), color: 'Qora' },
      { modelId: 'model-b', partyNumber: '2', pattaCount: 3, ...buildPartyWorkSummary(30, 3), color: 'Ko\'k' }
    ], new Date('2026-10-07T10:00:00.000Z'));

    expect(result.parties.map((party) => [party.pattaStartNumber, party.pattaEndNumber])).toEqual([[9, 11], [13, 15]]);
    expect(result.nextPattaNumber).toBe(16);
  });

  it('makes archived party numbers available for reuse', () => {
    expect(findNextPartyNumber([
      { id: 'archived', partyNumber: '1', modelId: 'model-a', modelName: 'Model A', color: 'Qora', pattaCount: 1, cumulativePattaCount: 1,
        ishSoni: 0, cumulativeIshSoni: 0, printedAt: '', isClosed: true, isArchived: true },
      { id: 'active', partyNumber: '2', modelId: 'model-a', modelName: 'Model A', color: 'Qora', pattaCount: 1, cumulativePattaCount: 2,
        ishSoni: 0, cumulativeIshSoni: 0, printedAt: '' }
    ])).toBe(1);
  });

  it('previews archived patta ranges before the high-water sequence without overlapping active ranges', () => {
    const starts = buildPattaPreviewStarts([{
      id: 'active', partyNumber: '2', modelId: 'model-b', modelName: 'Model B', color: 'Qora',
      pattaCount: 12, cumulativePattaCount: 24, pattaStartNumber: 13, pattaEndNumber: 24,
      ishSoni: 0, cumulativeIshSoni: 0, printedAt: ''
    }], [
      { modelId: 'model-a', partyNumber: '1', pattaCount: 12 },
      { modelId: 'model-c', partyNumber: '3', pattaCount: 2 }
    ], 25, [{ start: 1, end: 12 }]);

    expect(starts).toEqual([1, 25]);
  });

  it('removes a deleted size from every stored model batch config', () => {
    const result = removePattaSizeFromBatchConfigs({
      'model-a': { partyNumber: '', totalIshSoni: '', color: 'Qora', sizes: { '40-42': '3', M: '2' } },
      'model-b': { partyNumber: '', totalIshSoni: '', color: 'Ko\'k', sizes: { '40-42': '', L: '1' } }
    }, '40-42');

    expect(result['model-a'].sizes).toEqual({ M: '2' });
    expect(result['model-b'].sizes).toEqual({ L: '1' });
  });
});
