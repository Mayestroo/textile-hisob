/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { KonveyerView } from '../KonveyerView';
import { useWorkbookStore } from '../../../store/workbookStore';
import { useAuthStore } from '../../../store/authStore';

describe('KonveyerView payroll hydration', () => {
  const originalWorkbook = useWorkbookStore.getState();
  const originalAuth = useAuthStore.getState();

  beforeEach(() => {
    window.sessionStorage.clear();
    useAuthStore.setState({ companyId: 'conveyor-company' });
    useWorkbookStore.setState({
      models: [], workers: [], submittedTickets: [], selectedArchiveFilename: null,
      currentPeriod: { id: 'current-period', isClosed: false } as any,
      licenseStatus: { companyId: 'conveyor-company' } as any
    });
  });

  afterEach(() => {
    cleanup();
    useWorkbookStore.setState(originalWorkbook, true);
    useAuthStore.setState(originalAuth, true);
  });

  it.each([undefined, null, {}, { workers: null }])('renders instead of crashing with valuation %j', (valuation) => {
    useWorkbookStore.setState({ payrollValuation: valuation as any });
    render(<KonveyerView />);
    expect(screen.getByRole('heading', { name: 'Konveyerlar va modellar' })).toBeTruthy();
    expect(screen.getByText('Jami ish haqi')).toBeTruthy();
  });

  it('renders after valuation arrives following an initially missing value', () => {
    useWorkbookStore.setState({ payrollValuation: undefined as any });
    const view = render(<KonveyerView />);
    useWorkbookStore.setState({ payrollValuation: {
      companyId: 'conveyor-company', period: { periodId: 'current-period' }, workers: [],
      accountingStatus: 'COMPLETE', accountingReasons: [], syncStatus: 'CURRENT'
    } as any });
    view.rerender(<KonveyerView />);
    expect(screen.getByRole('heading', { name: 'Konveyerlar va modellar' })).toBeTruthy();
  });
});
