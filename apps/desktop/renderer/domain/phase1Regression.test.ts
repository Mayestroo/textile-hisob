import { describe, expect, it, vi } from 'vitest';
import { validateTicketForSubmission } from './ticketValidation';
import { reconcileModelHisobQuantities } from '../store/helpers/storeSanitizers';
import { createModelSlice } from '../store/slices/createModelSlice';
import { createTicketSlice } from '../store/slices/createTicketSlice';

const model = (overrides: any = {}) => ({
  id: 'model-a',
  name: 'model-a',
  hisobSheetName: 'model-a-hisob',
  title: 'Model-a',
  party: '',
  color: 'Кора',
  size: 'XL',
  operations: [{ id: 'op-1', name: 'Sew', rate: 10 }],
  pattaOpsOrder: ['Sew'],
  hisobQuantities: {},
  ...overrides
});

describe('Phase 1 domain corrections', () => {
  it('looks up parties by model and party number', () => {
    const result = validateTicketForSubmission(
      { date: '2026-01-01', party: '7', patta: '1', color: 'Кора', size: 'XL', qty: '2', entries: { Sew: 1 } },
      model(),
      [{ id: 1, name: 'Worker' }],
      [{ id: 'wrong', modelId: 'model-b', modelName: 'model-b', partyNumber: '7', pattaCount: 1, cumulativePattaCount: 1, cumulativeIshSoni: 1, color: 'Кора', ishSoni: 1, printedAt: 'now' }],
      []
    );
    expect(result.isValid).toBe(false);
    expect(result.message).toContain('mavjud emas');
  });

  it('rebuilds quantities and removes stale aggregate entries', () => {
    const result = reconcileModelHisobQuantities(
      [model({ hisobQuantities: { 1: { Sew: 99, Old: 4 }, 2: { Sew: 8 } } })],
      [{ id: 'ticket-1', modelId: 'model-a', partyNumber: '1', pattaNumber: 1, qty: 3, entries: [{ opName: 'Sew', workerId: 1 }], submittedAt: 'now' }]
    );
    expect(result[0].hisobQuantities).toEqual({ 1: { Sew: 3 } });
  });

  it('migrates pending form entries when an operation is renamed', async () => {
    const state: any = {
      models: [model()],
      ticketForms: { 'model-a': { entries: { Sew: 1 } } },
      pattaBatchConfigs: {},
      saveToDisk: vi.fn(),
      addNotification: vi.fn()
    };
    const slice: any = createModelSlice(
      (next: any) => Object.assign(state, next),
      () => state,
      {} as any
    );
    await slice.updateOperationName('model-a', 'Sew', 'Pack');
    expect(state.ticketForms['model-a'].entries).toEqual({ Pack: 1 });
  });

  it('rejects an unknown operation while editing a ticket', async () => {
    const state: any = {
      models: [model()],
      workers: [{ id: 1, name: 'Worker' }],
      submittedTickets: [{ id: 'ticket-1', modelId: 'model-a', qty: 2, entries: [{ opName: 'Sew', workerId: 1 }] }],
      saveToDisk: vi.fn(),
      addNotification: vi.fn()
    };
    const slice: any = createTicketSlice(
      (next: any) => Object.assign(state, next),
      () => state,
      {} as any
    );
    await expect(slice.updateSubmittedTicket('ticket-1', [{ opName: 'Missing', workerId: 1 }])).resolves.toBe(false);
    expect(state.saveToDisk).not.toHaveBeenCalled();
  });
});
