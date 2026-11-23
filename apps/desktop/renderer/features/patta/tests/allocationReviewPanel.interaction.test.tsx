/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AllocationReviewPanel, describeReviewReason } from '../AllocationReviewPanel';

describe('allocation review panel server resolution actions', () => {
  const cancel = vi.fn();
  const serverCancel = vi.fn();
  const list = vi.fn();
  const serverList = vi.fn();
  const history = vi.fn();
  beforeEach(() => {
    cancel.mockReset(); serverCancel.mockReset(); list.mockReset(); serverList.mockReset(); history.mockReset();
    list.mockResolvedValue({ success: true, conflicts: [{ operation_id: 'alloc-1', command_type: 'SubmitTicket', payload_hash: 'a'.repeat(64), status: 'CONFLICT',
      last_error: JSON.stringify({ code: 'ALLOCATION_REVIEW_REQUIRED', message: 'Issuance evidence missing' }), created_at: '2026-11-01',
      payload: { partyNumber: 'P-1', pattaNumber: 7, qty: 20, entries: [{ workerId: 12, workerNameSnapshot: 'Ali', opName: 'Tikish', qty: 20 }] } }] });
    serverList.mockResolvedValue({ success: true, reviews: [] });
    history.mockResolvedValue({ success: true, history: [] });
    cancel.mockResolvedValue({ success: true, status: 'CANCELLED', result: { status: 'CANCELLED' } });
    serverCancel.mockResolvedValue({ success: true, status: 'CANCELLED', result: { status: 'CANCELLED' } });
    (window as any).electronAPI = { AllocationReviewList: list, AllocationReviewServerList: serverList,
      AllocationReviewHistory: history, AllocationReviewCancel: cancel, AllocationReviewServerCancel: serverCancel };
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  async function cancelWithReason(reason: string) {
    fireEvent.click(await screen.findByRole('button', { name: 'Bekor qilish' }));
    fireEvent.change(screen.getByLabelText('Bekor qilish sababi'), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: 'Tasdiqlash' }));
  }

  it('shows readable conflict evidence and only reports cancellation after server acknowledgment', async () => {
    render(<AllocationReviewPanel companyId="company-1" canCancel />);
    expect((await screen.findAllByText(/Issuance evidence missing/)).length).toBeGreaterThan(0);
    expect(screen.getByText('Ali (12)')).toBeTruthy();
    await cancelWithReason('Duplicate registration');
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ companyId: 'company-1', operationId: 'alloc-1', reason: 'Duplicate registration' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Server bekor qilishni tasdiqladi/);
  });

  it('lets a reviewer cancel work held on another PC from the server evidence', async () => {
    list.mockResolvedValue({ success: true, conflicts: [] });
    const payload = { operationId: 'remote-op', ticketId: 't-1', partyNumber: '205', pattaNumber: 680, qty: 409, entries: [] };
    serverList.mockResolvedValue({ success: true, reviews: [{ operationId: 'remote-op', commandType: 'SubmitTicket', ticketId: 't-1',
      payloadHash: 'c'.repeat(64), payload, issuedQty: 410, modelName: 'Kofta', recordedAt: '2026-11-23T07:34:29Z',
      reason: 'Ticket quantity does not match authoritative issuance; preserve this operation for correction and review' }] });
    render(<AllocationReviewPanel companyId="company-1" canCancel />);
    expect(await screen.findByText(/kiritilgan 409 dona, partiyada har bir patta 410 dona/)).toBeTruthy();
    await cancelWithReason('409 o‘rniga 410');
    await waitFor(() => expect(serverCancel).toHaveBeenCalledWith({ companyId: 'company-1', operationId: 'remote-op',
      payloadHash: 'c'.repeat(64), payload, commandType: 'SubmitTicket', reason: '409 o‘rniga 410' }));
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does not offer cancellation to a typer and explains who resolves it', async () => {
    render(<AllocationReviewPanel companyId="company-1" />);
    expect(await screen.findByText(/faqat admin yoki hisobchi bekor qila oladi/)).toBeTruthy();
    expect(screen.getByText(/qayta jo‘natsangiz, eski yozuv almashtiriladi/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bekor qilish' })).toBeNull();
    expect(serverList).not.toHaveBeenCalled();
  });

  it('shows actionable server rejection details and does not offer the same rejected intent again', async () => {
    list.mockResolvedValue({ success: true, conflicts: [{ operation_id: 'alloc-rejected', payload_hash: 'b'.repeat(64), status: 'CONFLICT',
      cancellation_status: 'REJECTED', cancellation_result: { code: 'PERIOD_CLOSED', message: 'Closed period requires a separate correction' },
      last_error: 'ALLOCATION_REVIEW_REQUIRED', created_at: '2026-11-01', payload: { qty: 20 } }] });
    render(<AllocationReviewPanel companyId="company-1" canCancel />);
    expect((await screen.findByRole('alert')).textContent).toContain('PERIOD_CLOSED');
    expect(screen.queryByRole('button', { name: 'Bekor qilish' })).toBeNull();
  });

  it('reports durable pending intent without claiming cancellation succeeded before server acknowledgment', async () => {
    cancel.mockResolvedValue({ success: true, status: 'PENDING_SERVER_ACK', resolutionOperationId: 'resolution-pending' });
    render(<AllocationReviewPanel companyId="company-1" canCancel />);
    await cancelWithReason('Duplicate');
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('server tasdig‘ini kutmoqda');
    expect(status.textContent).not.toContain('Server bekor qilishni tasdiqladi');
  });

  it('asks a reviewer to sign in as operator instead of silently showing an empty list', async () => {
    list.mockResolvedValue({ success: true, conflicts: [] });
    serverList.mockResolvedValueOnce({ success: false, code: 'ALLOCATION_REVIEW_UNAUTHORIZED', error: 'Active company accountant/admin operator session required' })
      .mockResolvedValue({ success: true, reviews: [{ operationId: 'remote-op', commandType: 'SubmitTicket', ticketId: 't-1',
        payloadHash: 'c'.repeat(64), payload: { partyNumber: '205', pattaNumber: 680, qty: 409, entries: [] }, issuedQty: 410,
        modelName: 'Kofta', recordedAt: '2026-11-23T07:34:29Z', reason: 'Ticket quantity does not match authoritative issuance' }] });
    const login = vi.fn().mockResolvedValue({ success: true, session: { operatorId: 'admin' } });
    (window as any).electronAPI.OperatorLogin = login;
    render(<AllocationReviewPanel companyId="company-1" canCancel variant="page" />);
    fireEvent.change(await screen.findByLabelText('Operator login'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Operator paroli'), { target: { value: 'secret-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirish' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('company-1', 'admin', 'secret-pass'));
    expect(await screen.findByText(/kiritilgan 409 dona/)).toBeTruthy();
    expect(screen.queryByLabelText('Operator login')).toBeNull();
  });

  it('shows a rejected operator login', async () => {
    list.mockResolvedValue({ success: true, conflicts: [] });
    serverList.mockResolvedValue({ success: false, code: 'ALLOCATION_REVIEW_UNAUTHORIZED', error: 'operator required' });
    (window as any).electronAPI.OperatorLogin = vi.fn().mockResolvedValue({ success: false, code: 'OPERATOR_AUTH_REJECTED', error: 'Invalid operator credentials' });
    render(<AllocationReviewPanel companyId="company-1" canCancel variant="page" />);
    fireEvent.change(await screen.findByLabelText('Operator login'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Operator paroli'), { target: { value: 'wrong-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirish' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Login yoki parol noto‘g‘ri');
  });

  it('translates the known server reasons', () => {
    expect(describeReviewReason('no reliable per-patta issued quantity', 5, null)).toContain('ishonchli');
  });
});
