/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AllocationReviewPanel } from '../AllocationReviewPanel';

describe('allocation review panel server resolution actions', () => {
  const cancel = vi.fn();
  const list = vi.fn();
  const history = vi.fn();
  beforeEach(() => {
    cancel.mockReset(); list.mockReset(); history.mockReset();
    list.mockResolvedValue({ success: true, conflicts: [{ operation_id: 'alloc-1', payload_hash: 'a'.repeat(64), status: 'CONFLICT',
      last_error: JSON.stringify({ code: 'ALLOCATION_REVIEW_REQUIRED', message: 'Issuance evidence missing' }), created_at: '2026-11-01',
      payload: { partyNumber: 'P-1', pattaNumber: 7, qty: 20, entries: [{ workerId: 12 }] } }] });
    history.mockResolvedValue({ success: true, history: [] });
    cancel.mockResolvedValue({ success: true, status: 'CANCELLED', result: { status: 'CANCELLED' } });
    (window as any).electronAPI = { AllocationReviewList: list, AllocationReviewHistory: history, AllocationReviewCancel: cancel };
    vi.spyOn(window, 'prompt').mockReturnValue('Duplicate registration');
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows exact conflict evidence and only reports cancellation after server acknowledgment', async () => {
    render(<AllocationReviewPanel companyId="company-1" canCancel />);
    expect(await screen.findByText(/Issuance evidence missing/)).toBeTruthy();
    expect(screen.getByText(/alloc-1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bekor qilish' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ companyId: 'company-1', operationId: 'alloc-1', reason: 'Duplicate registration' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Server bekor qilishni tasdiqladi/);
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
    fireEvent.click(await screen.findByRole('button', { name: 'Bekor qilish' }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('server tasdig‘ini kutmoqda');
    expect(status.textContent).not.toContain('Server bekor qilishni tasdiqladi');
  });
});
