/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConnectionStatus } from '../ConnectionStatus';
import { useWorkbookStore } from '../../../store/workbookStore';
import { useAuthStore } from '../../../store/authStore';
import { useSyncStore } from '../../../store/syncStore';

describe('background sync scheduling', () => {
  const workbook = useWorkbookStore.getState();
  const auth = useAuthStore.getState();
  let pending = 0;
  let conflicts = 0;
  const api = {
    getRuntimeMode: vi.fn().mockResolvedValue({ success: true, mode: 'sync' }),
    OutboxPending: vi.fn(),
    OutboxDiagnostics: vi.fn(async () => ({ success: true, diagnostics: { pendingCount: pending, conflictCount: conflicts } })),
    SyncPull: vi.fn().mockResolvedValue({ success: true, result: { success: true, pulledCount: 0 } }),
    SyncReconnect: vi.fn().mockResolvedValue({ success: true, result: { pushed: { attempted: 0, synced: 0 } } })
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    pending = 0;
    conflicts = 0;
    (window as any).electronAPI = api;
    useAuthStore.setState({ companyId: 'company-one' });
    useWorkbookStore.setState({ licenseStatus: { companyId: 'company-one' } as any, isServerConnected: true });
    useSyncStore.getState().reset();
    useSyncStore.setState({ online: true });
  });
  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
    vi.useRealTimers();
    useWorkbookStore.setState(workbook, true);
    useAuthStore.setState(auth, true);
    useSyncStore.getState().reset();
  });

  it('does not reconnect on focus/blur/scroll or an idle retry tick; still reads remote changes', async () => {
    render(<><ConnectionStatus /><input aria-label="Draft" /></>);
    const input = screen.getByRole('textbox', { name: 'Draft' });
    act(() => input.focus());
    act(() => input.blur());
    fireEvent.scroll(window);
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(api.SyncReconnect).not.toHaveBeenCalled();
    expect(api.SyncPull).toHaveBeenCalled();
  });

  it('retries outstanding outbox work on the interval, not on every blur', async () => {
    pending = 3;
    render(<><ConnectionStatus /><input aria-label="Draft" /></>);
    const input = screen.getByRole('textbox', { name: 'Draft' });
    for (let i = 0; i < 3; i++) {
      act(() => input.focus());
      act(() => input.blur());
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(api.SyncReconnect).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(13_000); });
    expect(api.SyncReconnect).toHaveBeenCalledTimes(1);
  });

  it('allows an explicit manual reconnect with an empty outbox', async () => {
    render(<ConnectionStatus />);
    await act(async () => { fireEvent.click(screen.getByText('Sinxron')); });
    expect(api.SyncReconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps recovery and cancellation delivery running for failed outbox work', async () => {
    conflicts = 1;
    render(<ConnectionStatus />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(api.SyncReconnect).toHaveBeenCalledTimes(1);
  });
});
