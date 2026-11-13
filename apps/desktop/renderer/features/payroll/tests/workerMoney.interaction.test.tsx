/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UmumiyView } from '../UmumiyView';
import { useWorkbookStore } from '../../../store/workbookStore';
import { useAuthStore } from '../../../store/authStore';

describe('worker money edits do not sync navigation', () => {
  const workbook = useWorkbookStore.getState();
  const auth = useAuthStore.getState();
  const updateWorker = vi.fn();
  const addNotification = vi.fn();
  beforeEach(() => {
    updateWorker.mockReset().mockResolvedValue(true);
    addNotification.mockReset();
    const period = { id: 'open', name: 'Open', startDate: '2026-11-01', isClosed: false };
    useAuthStore.setState({ companyId: 'company-one', permissions: ['edit:workers', 'edit:avans'] as any });
    useWorkbookStore.setState({
      workers: [{ id: 1, name: 'Ali', avans: 1000, jarima: 1000, oklad: 1000, magazin: 1000, staj: 0 }],
      models: [], currentPeriod: period, periods: [period], selectedArchiveFilename: null,
      licenseStatus: { companyId: 'company-one' } as any, updateWorker, addNotification,
      payrollValuation: { companyId: 'company-one', period: { periodId: 'open', isClosed: false },
        accountingStatus: 'COMPLETE', accountingReasons: [], syncStatus: 'CURRENT',
        workers: [{ workerId: 1, avans: 1000, jarima: 1000, oklad: 1000, magazin: 1000, gross: 1000 }] } as any
    });
  });
  afterEach(() => {
    cleanup();
    useWorkbookStore.setState(workbook, true);
    useAuthStore.setState(auth, true);
  });

  it.each(['Avans', 'Jarima', 'Oklad', 'Magazin'])('%s focus, scroll, blur and unchanged Enter do not save', async (label) => {
    const view = render(<UmumiyView />);
    const input = screen.getByRole('textbox', { name: `${label} #1` });
    act(() => input.focus());
    fireEvent.scroll(window);
    act(() => input.blur());
    act(() => input.focus());
    fireEvent.keyDown(input, { key: 'Enter' });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '1,000' } });
    await act(async () => input.blur());
    act(() => input.focus());
    view.unmount();
    expect(updateWorker).not.toHaveBeenCalled();
    expect(addNotification).not.toHaveBeenCalled();
  });

  it.each([['Avans', 'avans'], ['Jarima', 'jarima'], ['Oklad', 'oklad'], ['Magazin', 'magazin']])(
    '%s saves a changed amount once and Escape discards the next draft', async (label, field) => {
      render(<UmumiyView />);
      const input = screen.getByRole('textbox', { name: `${label} #1` });
      act(() => input.focus());
      fireEvent.change(input, { target: { value: '2,000' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(updateWorker).toHaveBeenCalledTimes(1));
      expect(updateWorker).toHaveBeenCalledWith(1, { [field]: 2000 });
      act(() => input.focus());
      fireEvent.change(input, { target: { value: '3,000' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(updateWorker).toHaveBeenCalledTimes(1);
    }
  );
});
