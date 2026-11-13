/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditSubmittedTicketModal } from '../modals/EditSubmittedTicketModal';
import { useWorkbookStore } from '../../../store/workbookStore';
import { useAuthStore } from '../../../store/authStore';
import { PattaView } from '../PattaView';

const ticket: any = {
  id: 'ticket-one', modelId: 'model-one', partyNumber: '15', partyRecordId: 'party-15', periodId: 'period-open',
  pattaNumber: 8, qty: 100, status: 'CONFIRMED', submittedAt: '2026-11-11',
  entries: [{ entryId: 'entry-ali', opName: 'Yeng tikish', workerId: 1, workerNameSnapshot: 'Ali', qty: 40, rateSnapshot: 5 }]
};

describe('Patta worker assignment and allocation editor interactions', () => {
  const updateSubmittedTicket = vi.fn();
  beforeEach(() => {
    updateSubmittedTicket.mockReset().mockResolvedValue(true);
    useAuthStore.setState({ permissions: ['edit:patta'] as any, companyId: 'company-one', role: 'accountant' as any });
    useWorkbookStore.setState({
      modalState: { type: 'edit_ticket', data: ticket }, submittedTickets: [ticket],
      models: [{ id: 'model-one', name: 'Model', operations: [{ id: 'op-one', name: 'Yeng tikish', rate: 5 }], pattaOpsOrder: ['Yeng tikish'] } as any],
      workers: [{ id: 1, name: 'Ali' }, { id: 2, name: 'Vali' }] as any,
      updateSubmittedTicket,
      licenseStatus: { companyId: 'company-one', activationId: 'activation' } as any,
      currentPeriod: { id: 'period-open', isClosed: false } as any,
      selectedArchiveFilename: null,
      payrollValuation: { companyId: 'company-one' } as any,
      closeModal: vi.fn()
    } as any);
  });
  afterEach(() => cleanup());

  it('resumes 40/100, adds Vali to complete 100, and submits actual worker quantities', async () => {
    render(<EditSubmittedTicketModal />);
    await screen.findByDisplayValue('40');
    expect(screen.getByText(/40\/100 · qoldi 60/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Ishchi taqsimoti qo‘shish/ }));
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: 'Yeng tikish' } });
    const ids = screen.getAllByPlaceholderText('ID');
    fireEvent.change(ids[1], { target: { value: '2' } });
    const qtyInputs = screen.getAllByLabelText('Yeng tikish allocation quantity');
    fireEvent.change(qtyInputs[1], { target: { value: '60' } });
    expect(screen.getByText(/100\/100 · qoldi 0/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Saqlash va hisoblarni yangilash/ }));
    await waitFor(() => expect(updateSubmittedTicket).toHaveBeenCalledWith('ticket-one', [
      expect.objectContaining({ entryId: 'entry-ali', workerId: 1, qty: 40 }),
      expect.objectContaining({ workerId: 2, qty: 60 })
    ]));
  });

  it('rejects 40+61 and duplicate worker-operation assignments before save', async () => {
    render(<EditSubmittedTicketModal />);
    fireEvent.click(screen.getByRole('button', { name: /Ishchi taqsimoti qo‘shish/ }));
    fireEvent.change(screen.getAllByPlaceholderText('ID')[1], { target: { value: '2' } });
    fireEvent.change(screen.getAllByLabelText('Yeng tikish allocation quantity')[1], { target: { value: '61' } });
    fireEvent.click(screen.getByRole('button', { name: /Saqlash va hisoblarni yangilash/ }));
    expect(await screen.findByText(/oshmasligi kerak/)).toBeTruthy();
    expect(updateSubmittedTicket).not.toHaveBeenCalled();
  });

  it('blocks duplicate worker-operation rows and disables mutation for a closed period', async () => {
    const { rerender } = render(<EditSubmittedTicketModal />);
    fireEvent.click(screen.getByRole('button', { name: /Ishchi taqsimoti qo‘shish/ }));
    fireEvent.change(screen.getAllByPlaceholderText('ID')[1], { target: { value: '1' } });
    fireEvent.change(screen.getAllByLabelText('Yeng tikish allocation quantity')[1], { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Saqlash va hisoblarni yangilash/ }));
    expect(await screen.findByText(/bir ishchini ikki marta/)).toBeTruthy();
    expect(updateSubmittedTicket).not.toHaveBeenCalled();

    useWorkbookStore.setState({ currentPeriod: { id: 'period-open', isClosed: true } as any });
    useAuthStore.setState({ permissions: ['edit:patta'] as any });
    useWorkbookStore.setState({ modalState: { type: 'edit_ticket', data: { ...ticket, periodId: 'period-closed' } } });
    rerender(<EditSubmittedTicketModal />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('keeps numeric worker entry and Enter/up/down navigation while retaining the draft on remount', () => {
    const model: any = { id: 'model-one', name: 'Model', party: '15', color: 'Blue', size: 'M',
      operations: [{ id: 'op-one', name: 'Yeng tikish', rate: 5 }, { id: 'op-two', name: 'Ikkinchi', rate: 7 }], pattaOpsOrder: ['Yeng tikish', 'Ikkinchi'], hisobQuantities: {} };
    useWorkbookStore.setState({
      modalState: { type: null }, models: [model], workers: [{ id: 1, name: 'Ali' }, { id: 2, name: 'Vali' }] as any,
      printedPartyHistory: [{ id: 'party-15', partyNumber: '15', modelId: 'model-one', modelName: 'Model', color: 'Blue', pattaCount: 1,
        cumulativePattaCount: 1, ishSoniPerPatta: 100, ishSoni: 100, cumulativeIshSoni: 100, printedAt: '2026-11-11' }] as any,
      submittedTickets: [], ticketForms: { 'model-one': { date: '2026-11-11', party: '15', patta: '8', color: 'Blue', size: 'M', qty: '100', strictParty: false, strictPatta: false, entries: {} } },
      currentPeriod: { id: 'period-open', isClosed: false } as any, availableSizes: ['M'], jonatish: vi.fn().mockResolvedValue(true)
    } as any);
    const first = render(<PattaView model={model} />);
    const workerOne = screen.getByRole('spinbutton', { name: 'Yeng tikish worker ID' });
    const workerTwo = screen.getByRole('spinbutton', { name: 'Ikkinchi worker ID' });
    fireEvent.change(workerOne, { target: { value: '1' } });
    expect(screen.getByText('Ali')).toBeTruthy();
    fireEvent.keyDown(workerOne, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(workerTwo);
    fireEvent.keyDown(workerTwo, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(workerOne);
    fireEvent.keyDown(workerOne, { key: 'Enter' });
    expect(document.activeElement).toBe(workerTwo);
    fireEvent.change(workerTwo, { target: { value: '2' } });
    expect(screen.getByText('Vali')).toBeTruthy();
    first.unmount();
    render(<PattaView model={model} />);
    expect((screen.getByRole('spinbutton', { name: 'Yeng tikish worker ID' }) as HTMLInputElement).value).toBe('1');
    expect((screen.getByRole('spinbutton', { name: 'Ikkinchi worker ID' }) as HTMLInputElement).value).toBe('2');
    expect(useWorkbookStore.getState().ticketForms['model-one']).toMatchObject({
      qty: '100', entries: { 'Yeng tikish': '1', Ikkinchi: '2' }
    });
  });
});
