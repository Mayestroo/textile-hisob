import { describe, expect, it, vi } from 'vitest';
import { preserveWorkbookProjectionDrafts, runReconnect, runSyncPull } from './businessMutations';

describe('workbook projection refresh draft preservation', () => {
  it('keeps local ticket drafts when a canonical SQLite projection reloads', () => {
    const draft = { 'model-a': { date: '2026-10-07', qty: '123', party: '17', color: '', size: '', entries: {} } };
    const refreshed = preserveWorkbookProjectionDrafts({
      models: [{ id: 'model-a', name: 'Model A' }],
      ticketForms: { 'model-a': { date: '2026-10-07', qty: '12', party: '17', color: '', size: '', entries: {} } },
      availableSizes: ['M'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '17', totalIshSoni: '', sizes: {} } }
    }, {
      ticketForms: draft,
      availableSizes: ['M', 'L'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '18', totalIshSoni: '', sizes: {} } }
    });

    expect(refreshed.models).toEqual([{ id: 'model-a', name: 'Model A' }]);
    expect(refreshed.ticketForms).toBe(draft);
    expect(refreshed.availableSizes).toEqual(['M']);
  });

  it('also keeps batch-setting drafts while their inputs are being saved', () => {
    const batchDrafts = { 'model-a': { partyNumber: '18', totalIshSoni: '', sizes: {} } };
    const refreshed = preserveWorkbookProjectionDrafts({
      ticketForms: {},
      availableSizes: ['M'],
      pattaBatchConfigs: { 'model-a': { partyNumber: '17', totalIshSoni: '', sizes: {} } }
    }, {
      ticketForms: {},
      availableSizes: ['M', 'L'],
      pattaBatchConfigs: batchDrafts
    }, true);

    expect(refreshed.availableSizes).toEqual(['M', 'L']);
    expect(refreshed.pattaBatchConfigs).toBe(batchDrafts);
  });

  it('serializes the lightweight background pull with full reconnects per company', async () => {
    let releasePull: (() => void) | undefined;
    const order: string[] = [];
    const eAPI = {
      SyncPull: vi.fn(async () => {
        order.push('pull-start');
        await new Promise<void>((resolve) => { releasePull = resolve; });
        order.push('pull-end');
        return { success: true };
      }),
      SyncReconnect: vi.fn(async () => {
        order.push('reconnect');
        return { success: true };
      })
    };

    const pull = runSyncPull(eAPI, 'company-pull-queue');
    const reconnect = runReconnect(eAPI, 'company-pull-queue');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['pull-start']);
    releasePull?.();
    await Promise.all([pull, reconnect]);

    expect(order).toEqual(['pull-start', 'pull-end', 'reconnect']);
  });
});
