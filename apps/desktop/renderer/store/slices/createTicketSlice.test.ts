import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTicketSlice } from './createTicketSlice';
import { resetSessionGuardForTests } from '../sessionGuard';

function makeSlice() {
  let state: any = {
    licenseStatus: { companyId: 'company-a', requireTicketValidation: true },
    models: [{
      id: 'model-a',
      name: 'Model A',
      hisobSheetName: 'Model A-hisob',
      title: 'Model- A',
      party: '',
      color: 'Black',
      size: 'M',
      operations: [{ id: 'op-1', name: 'Sew', rate: 2 }],
      pattaOpsOrder: ['Sew'],
      hisobQuantities: {}
    }],
    workers: [{ id: 1, name: 'Worker A' }],
    ticketForms: {
      'model-a': {
        date: '2026-09-23',
        party: '1',
        color: 'Black',
        size: 'M',
        qty: '5',
        patta: '1',
        entries: { Sew: 1 }
      }
    },
    printedPartyHistory: [{
      id: 'party-a',
      modelId: 'model-a',
      modelName: 'Model A',
      partyNumber: '1',
      pattaCount: 1,
      cumulativePattaCount: 1,
      ishSoni: 5,
      cumulativeIshSoni: 5,
      color: 'Black',
      printedAt: '2026-09-23T09:00:00.000Z',
      isClosed: false
    }],
    submittedTickets: [],
    addNotification: vi.fn(),
    saveToDisk: vi.fn()
  };
  const set = vi.fn((next: any) => {
    state = { ...state, ...(typeof next === 'function' ? next(state) : next) };
  });
  const slice = createTicketSlice(set as any, (() => state) as any, {} as any);
  return { slice, set, state: () => state };
}

describe(' ticket command routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSessionGuardForTests();
    const uuids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333'
    ];
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => uuids.shift()) });
  });

  it('submits one canonical UUID command and reloads the SQLite projection', async () => {
    const SubmitTicketCommand = vi.fn().mockResolvedValue({ success: true });
    const dbRead = vi.fn().mockResolvedValue({
      success: true,
      data: {
        companyId: 'company-a',
        workers: [{ id: 1, name: 'Worker A' }],
        models: [{
          id: 'model-a',
          name: 'Model A',
          operations: [{ id: 'op-1', name: 'Sew', rate: 2 }],
          pattaOpsOrder: ['Sew'],
          hisobQuantities: { '1': { Sew: 5 } }
        }],
        printedPartyHistory: [],
        submittedTickets: [{
          id: '44444444-4444-4444-8444-444444444444',
          modelId: 'model-a',
          partyNumber: '1',
          partyRecordId: 'party-a',
          pattaNumber: 1,
          qty: 5,
          status: 'PENDING_SYNC',
          submittedAt: '2026-09-23T10:00:00.000Z',
          entries: [{ opName: 'Sew', workerId: 1, workerNameSnapshot: 'Worker A', rateSnapshot: 2 }]
        }],
        periods: [],
        currentPeriod: { id: 'period_default', name: 'Default', startDate: '2026-09-01', isClosed: false }
      }
    });
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
        SubmitTicketCommand,
        dbRead
      }
    });
    const { slice, set, state } = makeSlice();

    const result = await slice.jonatish('model-a');

    expect(result).toBe(true);
    expect(SubmitTicketCommand).toHaveBeenCalledTimes(1);
    const command = SubmitTicketCommand.mock.calls[0][0];
    expect(command).toEqual(expect.objectContaining({
      companyId: 'company-a',
      modelId: 'model-a',
      partyNumber: '1',
       partyRecordId: 'party-a',
       pattaNumber: 1,
       qty: 5,
       size: 'M',
       color: 'Black',
       konveyer: '',
       effectiveDate: '2026-09-23',
      entries: [expect.objectContaining({ opName: 'Sew', workerId: 1 })]
    }));
    expect(command.commandId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(command.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(command.ticketId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Set([command.commandId, command.operationId, command.ticketId]).size).toBe(3);
    expect(dbRead).toHaveBeenCalledWith('company-a');
    expect(state().submittedTickets[0].id).toBe('44444444-4444-4444-8444-444444444444');
    expect(state().models[0].hisobQuantities).toEqual({ '1': { Sew: 5 } });
    expect(state().addNotification).toHaveBeenCalledWith('info', 'Sinxronlash navbatda', expect.stringContaining('VPS tasdig‘i kutilmoqda'));
    expect(state().saveToDisk).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalled();
  });

  it('sends per-ticket free-mode choices without fabricating a printed party record', async () => {
    const SubmitTicketCommand = vi.fn().mockResolvedValue({ success: true });
    const dbRead = vi.fn().mockResolvedValue({
      success: true,
      data: {
        companyId: 'company-a',
        workers: [{ id: 1, name: 'Worker A' }],
        models: [{ id: 'model-a', name: 'Model A', operations: [{ id: 'op-1', name: 'Sew', rate: 2 }], pattaOpsOrder: ['Sew'], hisobQuantities: {} }],
        printedPartyHistory: [], submittedTickets: [], periods: [], currentPeriod: null
      }
    });
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
        SubmitTicketCommand,
        dbRead
      }
    });
    const { slice, state } = makeSlice();
    state().ticketForms['model-a'] = {
      ...state().ticketForms['model-a'], party: '', patta: '', strictParty: false, strictPatta: false
    };
    state().printedPartyHistory = [];

    const result = await slice.jonatish('model-a');

    expect(result).toBe(true);
    expect(SubmitTicketCommand).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-a', partyNumber: "No'malum Partiya", partyRecordId: null, pattaNumber: 0,
      strictParty: false, strictPatta: false
    }));
    expect(SubmitTicketCommand.mock.calls[0][0].partyRecordId).toBeNull();
  });

  it('routes ticket deletion through the canonical workbook command', async () => {
    const WorkbookCommand = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
        WorkbookCommand
      }
    });
    const { slice, set, state } = makeSlice();
    state().submittedTickets = [{ id: 'ticket-a', modelId: 'model-a', qty: 1, entries: [] }];

    const deleteResult = await slice.deleteSubmittedTicket('ticket-a');

    expect(deleteResult).toBe(true);
    expect(WorkbookCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'DeleteTicket', entityId: 'ticket-a', payload: { ticketId: 'ticket-a' }
    }));
    expect(set).not.toHaveBeenCalled();
    expect(state().submittedTickets).toHaveLength(1);
  });

  it('blocks a ticket date outside the active period before it reaches the local outbox', async () => {
    const SubmitTicketCommand = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
        SubmitTicketCommand
      }
    });
    const { slice, state } = makeSlice();
    state().currentPeriod = { id: 'period-current', name: 'Current', startDate: '2026-10-01', isClosed: false };
    state().periods = [state().currentPeriod];

    const result = await slice.jonatish('model-a');

    expect(result).toBe(false);
    expect(SubmitTicketCommand).not.toHaveBeenCalled();
    expect(state().addNotification).toHaveBeenCalledWith(
      'error',
      'PERIOD_SCOPE_MISMATCH',
      expect.stringContaining('2026-09-23')
    );
  });

  it('routes ticket worker edits through the canonical workbook command', async () => {
    const WorkbookCommand = vi.fn().mockResolvedValue({ success: true, result: { status: 'PENDING_SYNC' } });
    const dbRead = vi.fn().mockResolvedValue({
      success: true,
      data: {
        companyId: 'company-a',
        workers: [{ id: 1, name: 'Worker A' }, { id: 2, name: 'Worker B' }],
        models: [{ id: 'model-a', name: 'Model A', operations: [{ id: 'op-1', name: 'Sew', rate: 2 }], pattaOpsOrder: ['Sew'], hisobQuantities: {} }],
        printedPartyHistory: [],
        submittedTickets: [{
          id: 'ticket-a', modelId: 'model-a', partyNumber: '1', partyRecordId: 'party-a',
          pattaNumber: 1, qty: 5, status: 'CONFIRMED', serverRevision: 2,
          submittedAt: '2026-09-23T10:00:00.000Z',
          entries: [{ opName: 'Sew', workerId: 2, workerNameSnapshot: 'Worker B', rateSnapshot: 2 }]
        }],
        periods: [],
        currentPeriod: { id: 'period_default', name: 'Default', startDate: '2026-09-01', isClosed: false }
      }
    });
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
        WorkbookCommand,
        dbRead
      }
    });
    const { slice, state } = makeSlice();
    state().workers.push({ id: 2, name: 'Worker B' });
    state().submittedTickets = [{
      id: 'ticket-a', modelId: 'model-a', partyNumber: '1', partyRecordId: 'party-a',
      pattaNumber: 1, qty: 5, status: 'CONFIRMED', serverRevision: 2,
      submittedAt: '2026-09-23T10:00:00.000Z',
      entries: [{ opName: 'Sew', workerId: 1, workerNameSnapshot: 'Worker A', rateSnapshot: 2 }]
    }];

    const result = await slice.updateSubmittedTicket('ticket-a', [{ opName: 'Sew', workerId: 2, rateSnapshot: 2 }]);

    expect(result).toBe(true);
    expect(WorkbookCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'UpdateTicket',
      entityId: 'ticket-a',
      baseRevision: 2,
      payload: { ticketId: 'ticket-a', entries: [expect.objectContaining({ opName: 'Sew', workerId: 2 })] },
      localArchive: { entries: [expect.objectContaining({ opName: 'Sew', workerId: 1 })] }
    }));
    expect(dbRead).toHaveBeenCalledWith('company-a');
  });

  it('shares one in-flight command for identical concurrent submissions', async () => {
    let resolveCommand: (value: { success: boolean }) => void = () => {};
    const SubmitTicketCommand = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveCommand = resolve;
    }));
    const dbRead = vi.fn().mockResolvedValue({
      success: true,
      data: {
        companyId: 'company-a',
        workers: [{ id: 1, name: 'Worker A' }],
        models: [{ id: 'model-a', name: 'Model A', operations: [{ name: 'Sew', rate: 2 }], hisobQuantities: {} }],
        printedPartyHistory: [],
        submittedTickets: [],
        periods: [],
        currentPeriod: { id: 'period_default', name: 'Default', startDate: '2026-09-01', isClosed: false }
      }
    });
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
        SubmitTicketCommand,
        dbRead
      }
    });
    const { slice } = makeSlice();

    const first = slice.jonatish('model-a');
    const second = slice.jonatish('model-a');

    expect(first).toBe(second);
    await vi.waitFor(() => expect(SubmitTicketCommand).toHaveBeenCalledTimes(1));
    resolveCommand({ success: true });
    await expect(first).resolves.toBe(true);
    expect(SubmitTicketCommand.mock.calls[0][0].commandId).toBeDefined();
  });

  it('does not hydrate a stale company projection after an in-flight switch', async () => {
    let resolveProjection: (value: any) => void = () => {};
    const dbRead = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveProjection = resolve;
    }));
    vi.stubGlobal('window', {
      electronAPI: {
        getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
        SubmitTicketCommand: vi.fn().mockResolvedValue({ success: true }),
        dbRead
      }
    });
    const { slice, set, state } = makeSlice();

    const resultPromise = slice.jonatish('model-a');
    await vi.waitFor(() => expect(dbRead).toHaveBeenCalled());
    state().licenseStatus = { companyId: 'company-b', requireTicketValidation: true };
    resolveProjection({
      success: true,
      data: { companyId: 'company-a', workers: [], models: [], printedPartyHistory: [], submittedTickets: [], periods: [] }
    });

    await expect(resultPromise).resolves.toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(state().addNotification).toHaveBeenCalledWith('error', '_SESSION_CHANGED', expect.any(String));
  });
});
